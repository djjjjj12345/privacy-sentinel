/**
 * 视觉 / 语言模型分析器
 * ---------------------------------------------------------------
 * 调用火山方舟 Responses API，要求模型输出结构化 JSON。
 *
 * 重要前提：方舟的 `text.format = {type:"json_object"}` 只保证「是合法 JSON」，
 * 不保证「字段齐全、取值合法」。json_schema 模式目前仍是 beta 且 strict 默认关闭。
 * 因此这里做了三层防守：
 *   第 1 层 提示词：把结构和取值约束写死在 system prompt 里；
 *   第 2 层 解析：剥离代码块、截取最外层 {}、修复常见 JSON 瑕疵；
 *   第 3 层 校验：逐条走 schema.normalizeItem，枚举、等级、bbox 全部重新计算，
 *              模型给的所有值都不可信，只当作线索。
 */

const axios = require('axios');
const { buildSystemPrompt, normalizeItem, TYPE_LABEL } = require('./schema');

const BASE_URL = (process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
const VISION_MODEL = process.env.ARK_VISION_MODEL || 'doubao-seed-2-0-mini-260428';
const TEXT_MODEL = process.env.ARK_TEXT_MODEL || VISION_MODEL;
// 音频/视频单独走 Chat Completions。
// 默认沿用 VISION_MODEL：实测 doubao-seed-2-0-mini 系列同时支持 input_audio 与 video_url，
// 且与账号已开通的模型保持一致，避免默认值指向不存在的模型 ID 导致 404。
const AUDIO_MODEL = process.env.ARK_AUDIO_MODEL || VISION_MODEL;
const VIDEO_MODEL = process.env.ARK_VIDEO_MODEL || VISION_MODEL;

// 方舟图片上限约 10MB，base64 会膨胀约 1/3，这里按 base64 长度粗略设卡
const MAX_DATA_URL_LENGTH = 14 * 1024 * 1024;
// 音频/视频 base64 上限 25MB 原文 -> 约 33MB base64。这里限制 30MB base64，留足裕度。
const MAX_MEDIA_BASE64_LENGTH = 30 * 1024 * 1024;
// 浏览器录的常见 mime 与方舟支持格式的映射（方舟仅认 mp3 / wav / aac）
const AUDIO_MIME_TO_FORMAT = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/aac': 'aac',
  'audio/mp4': 'mp4', // m4a/aac in mp4 container
  'audio/x-m4a': 'mp4',
};
// 视频只尝试 mp4；webm/quicktime 直接拒，避免模型端 400
const VIDEO_MIME_TO_FORMAT = {
  'video/mp4': 'mp4',
};

class UpstreamError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.detail = detail;
  }
}

function getApiKey() {
  const key = process.env.ARK_API_KEY || process.env.VOLC_API_KEY;
  if (!key) {
    throw new UpstreamError(
      '未配置 ARK_API_KEY，服务端无法调用模型。请在 .env 或部署环境变量中配置。',
      500
    );
  }
  return key;
}

/**
 * 从模型返回的自由文本中提取 JSON 对象。
 * 依次尝试：直接解析 → 去代码块 → 截取最外层花括号 → 修复常见瑕疵。
 */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;

  let s = text.trim();

  // 去掉 Markdown 代码块包裹
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1].trim();

  const attempt = (str) => {
    try {
      const parsed = JSON.parse(str);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  let result = attempt(s);
  if (result) return result;

  // 截取最外层花括号
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const sliced = s.slice(first, last + 1);
    result = attempt(sliced);
    if (result) return result;

    // 修复尾随逗号
    const repaired = sliced
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    result = attempt(repaired);
    if (result) return result;
  }

  return null;
}

/** 从 Responses API 的返回体中取出文本 */
function readOutputText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;

  const chunks = [];
  for (const item of data.output || []) {
    const content = item && item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && part.type === 'output_text' && typeof part.text === 'string') {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join('\n');
}

function describeAxiosError(error, modelVar = 'ARK_VISION_MODEL') {
  const status = error.response && error.response.status;
  const payload = error.response && error.response.data;
  const detail = payload ? (payload.error ? payload.error.message || JSON.stringify(payload.error) : JSON.stringify(payload)) : error.message;

  const hintMap = {
    401: 'API Key 无效或已失效，请检查 ARK_API_KEY',
    403: 'API Key 无权限，请确认已开通该模型',
    404: `模型不存在，请检查 ${modelVar} 是否与控制台中的模型 ID 一致`,
    429: '触发限流或余额不足，请稍后重试',
  };

  const hint = hintMap[status] || '模型服务调用失败';
  return {
    status: status || 502,
    message: `${hint}${detail ? `（${String(detail).slice(0, 200)}）` : ''}`,
  };
}

/**
 * 调用方舟 Responses API。
 * @param {object} opts
 * @param {string} opts.model
 * @param {Array}  opts.content  用户消息 content 数组
 * @param {object} opts.profile  用户画像，会注入 system prompt
 * @param {boolean} opts.useJsonFormat 是否声明 json_object 模式
 */
async function callArk({ model, content, profile, useJsonFormat = true, timeout = 60000 }) {
  const apiKey = getApiKey();

  const body = {
    model,
    input: [
      { role: 'system', content: buildSystemPrompt(profile) },
      { role: 'user', content },
    ],
  };
  if (useJsonFormat) {
    body.text = { format: { type: 'json_object' } };
  }

  const response = await axios.post(`${BASE_URL}/responses`, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: null,
  });

  if (response.status >= 400) {
    const err = new Error('upstream');
    err.response = { status: response.status, data: response.data };
    throw err;
  }

  return response.data;
}

/**
 * 带降级重试的调用：
 * 若模型不支持 json_object 模式（返回 400），自动去掉该参数重试一次。
 */
async function callArkWithFallback(options) {
  try {
    return await callArk({ ...options, useJsonFormat: true });
  } catch (error) {
    const status = error.response && error.response.status;
    if (status === 400 && options.useJsonFormat !== false) {
      return await callArk({ ...options, useJsonFormat: false });
    }
    throw error;
  }
}

/** 把模型返回的解析结果转成标准条目 */
function toItems(parsed) {
  if (!parsed || !Array.isArray(parsed.items)) return [];
  return parsed.items.map((raw) => normalizeItem(raw, 'ai')).filter(Boolean);
}

async function runAnalysis({ model, content, profile }) {
  const startedAt = Date.now();
  let data;
  try {
    data = await callArkWithFallback({ model, content, profile });
  } catch (error) {
    // 自身抛出的业务异常（例如未配置 Key）要原样透出，不能被通用文案覆盖
    if (error instanceof UpstreamError) throw error;
    const info = describeAxiosError(error);
    throw new UpstreamError(info.message, info.status);
  }

  const text = readOutputText(data);
  const parsed = extractJson(text);
  const elapsedMs = Date.now() - startedAt;

  if (!parsed) {
    // 模型没吐 JSON，属于可观测的异常：交给上层用正则结果兜底，同时暴露原文便于排查
    return {
      ok: false,
      reason: 'model_output_not_json',
      rawText: text.slice(0, 2000),
      items: [],
      transcript: null,
      advice: '',
      summary: '',
      elapsedMs,
      model,
      requestId: data && data.id,
    };
  }

  const items = toItems(parsed);

  return {
    ok: true,
    items,
    claimedSensitive: parsed.hasSensitive === true,
    transcript: typeof parsed.transcript === 'string' ? parsed.transcript : null,
    advice: typeof parsed.advice === 'string' ? parsed.advice.slice(0, 300) : '',
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 200) : '',
    elapsedMs,
    model,
    requestId: data && data.id,
  };
}

/**
 * 把 data URL 切成 mime 与纯 base64。
 * 失败时返回 null。
 */
function parseDataUrl(input) {
  if (typeof input !== 'string') return null;
  const m = input.match(/^data:([^;]+);base64,(.+)$/i);
  if (!m) return null;
  return { mime: m[1].toLowerCase(), base64: m[2] };
}

/**
 * Chat Completions 调用，专门用于 input_audio / input_video。
 * Responses API 对音视频支持尚不稳定，文档明确给出的是 Chat Completions 的写法。
 */
async function callArkChat({ model, content, timeout = 120000 }) {
  const apiKey = getApiKey();

  const body = {
    model,
    messages: [{ role: 'user', content }],
    temperature: 0.2,
  };

  const response = await axios.post(`${BASE_URL}/chat/completions`, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: null,
  });

  if (response.status >= 400) {
    const err = new Error('upstream');
    err.response = { status: response.status, data: response.data };
    throw err;
  }
  return response.data;
}

function readChatContent(data) {
  const choice = data && data.choices && data.choices[0];
  return (choice && choice.message && typeof choice.message.content === 'string')
    ? choice.message.content
    : '';
}

/**
 * 统一的"先转写为文字、再识别敏感条目"任务。
 * 返回与 runAnalysis 同构的 ok/items/transcript/advice 对象。
 *
 * 注意 Chat Completions 的内容类型名与 Responses API 不同：
 *   文本是 "text"（不是 input_text），视频是 "video_url"（不是 input_video），
 *   音频是 "input_audio"（其 data 字段收纯 base64）。以上均经线上实测确认。
 */
async function analyzeMedia({ model, modelVar, inputPart, question, mime, label }) {
  const startedAt = Date.now();
  let data;
  try {
    data = await callArkChat({
      model,
      content: [
        inputPart,
        { type: 'text', text: question },
      ],
      timeout: 180000,
    });
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    const info = describeAxiosError(error, modelVar);
    throw new UpstreamError(`${label}识别失败：${info.message}`, info.status);
  }

  const text = readChatContent(data);
  const parsed = extractJson(text);
  const elapsedMs = Date.now() - startedAt;

  if (!parsed) {
    return {
      ok: false,
      reason: 'model_output_not_json',
      rawText: text.slice(0, 2000),
      items: [],
      transcript: extractTranscriptFallback(text),
      advice: '',
      summary: '',
      elapsedMs,
      model,
      requestId: data && data.id,
    };
  }

  const items = toItems(parsed);
  return {
    ok: true,
    items,
    claimedSensitive: parsed.hasSensitive === true,
    transcript: typeof parsed.transcript === 'string' ? parsed.transcript : null,
    advice: typeof parsed.advice === 'string' ? parsed.advice.slice(0, 300) : '',
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 200) : '',
    elapsedMs,
    model,
    requestId: data && data.id,
  };
}

/**
 * 当模型没吐 JSON 时，把它的自由文本当转写看——总比丢掉好。
 * 取最长的纯文本段落，去掉 Markdown 标记。
 */
function extractTranscriptFallback(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), '');
  const cleaned = longest
    .replace(/```[a-z]*\s*([\s\S]*?)\s*```/gi, '$1')
    .replace(/^[#*\->\s]+/, '')
    .trim();
  return cleaned ? cleaned.slice(0, 2000) : null;
}

/**
 * 分析音频。dataUrl 形如 `data:audio/mp3;base64,XXX`。
 * 模型先转写音频内容为文字，再走与图片相同的敏感信息识别。
 */
async function analyzeAudio(dataUrl, opts = {}) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    throw new UpstreamError('音频格式必须是 data:audio/...;base64,...', 400);
  }
  const fmt = AUDIO_MIME_TO_FORMAT[parsed.mime];
  if (!fmt) {
    throw new UpstreamError(
      `音频格式不支持（${parsed.mime}）。请使用 MP3 / WAV / AAC / M4A。`,
      415
    );
  }
  if (parsed.base64.length > MAX_MEDIA_BASE64_LENGTH) {
    throw new UpstreamError(
      `音频过大（${(parsed.base64.length / 1024 / 1024).toFixed(1)}MB），请压缩或截取后再试`,
      413
    );
  }

  const question = opts.question || (
    '请先逐字转写这段音频中的中文内容，再用与图片识别相同的 JSON 结构输出敏感信息。' +
    '音频中可能出现身份证号、银行卡号、手机号、家庭住址、验证码、转账金额、密码等。' +
    '若音频内容很短、只是闲聊，按 hasSensitive:false 输出。'
  );

  return analyzeMedia({
    model: AUDIO_MODEL,
    modelVar: 'ARK_AUDIO_MODEL',
    mime: parsed.mime,
    label: '音频',
    inputPart: {
      type: 'input_audio',
      input_audio: { data: parsed.base64, format: fmt },
    },
    question,
  });
}

/**
 * 分析视频。同音频：先转写音轨与画面描述，再走敏感信息识别。
 * 注意：当前方舟仅对 mp4 容器提供完整支持，webm/quicktime 必须前端转码。
 */
async function analyzeVideo(dataUrl, opts = {}) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    throw new UpstreamError('视频格式必须是 data:video/...;base64,...', 400);
  }
  const fmt = VIDEO_MIME_TO_FORMAT[parsed.mime];
  if (!fmt) {
    throw new UpstreamError(
      `视频格式不支持（${parsed.mime}）。请使用 MP4 容器（可先用格式工厂或 FFmpeg 转码）。`,
      415
    );
  }
  if (parsed.base64.length > MAX_MEDIA_BASE64_LENGTH) {
    throw new UpstreamError(
      `视频过大（${(parsed.base64.length / 1024 / 1024).toFixed(1)}MB），请压缩后再试`,
      413
    );
  }

  const question = opts.question || (
    '请先识别这段视频中：① 音轨转写为文字 ② 画面里出现的文字与证件号码。' +
    '再按 JSON 结构输出敏感信息。若只是普通聊天视频，按 hasSensitive:false 输出。'
  );

  return analyzeMedia({
    model: VIDEO_MODEL,
    modelVar: 'ARK_VIDEO_MODEL',
    mime: parsed.mime,
    label: '视频',
    // 方舟 Chat Completions 对视频只认 video_url（file_id / url 二选一），
    // url 字段支持视频链接或 Base64 编码，这里直接传 data URL。
    inputPart: {
      type: 'video_url',
      video_url: { url: dataUrl },
    },
    question,
  });
}

/**
 * 分析图片（支持 base64 data URL 或公网 URL）
 * @param {string} imageUrl
 * @param {object} opts { profile, question }
 */
async function analyzeImage(imageUrl, opts = {}) {
  if (!imageUrl || typeof imageUrl !== 'string') {
    throw new UpstreamError('缺少图片内容', 400);
  }
  const isDataUrl = /^data:image\/[a-z0-9.+-]+;base64,/i.test(imageUrl);
  if (isDataUrl && imageUrl.length > MAX_DATA_URL_LENGTH) {
    throw new UpstreamError(
      `图片过大（约 ${(imageUrl.length / 1024 / 1024).toFixed(1)}MB），请压缩后重试`,
      413
    );
  }
  if (!isDataUrl && !/^https?:\/\//i.test(imageUrl)) {
    throw new UpstreamError('图片格式不支持，需为 data:image/... 或 http(s) 地址', 400);
  }

  const question =
    opts.question ||
    '请识别这张图片中的所有敏感信息，并按规定 JSON 结构输出。注意逐字符照抄原文，不要推测。';

  return runAnalysis({
    model: VISION_MODEL,
    profile: opts.profile,
    content: [
      { type: 'input_image', image_url: imageUrl },
      { type: 'input_text', text: question },
    ],
  });
}

/**
 * 分析文本（语义层）
 * @param {string} text
 * @param {object} opts { profile }
 */
async function analyzeText(text, opts = {}) {
  if (!text || typeof text !== 'string') {
    throw new UpstreamError('缺少文本内容', 400);
  }
  // 截断必须显式告知：静默丢尾部内容会让「后半段的敏感信息」变成假阴性。
  const TEXT_CAP = 12000;
  const truncated = text.length > TEXT_CAP;
  const trimmed = text.slice(0, TEXT_CAP);

  const result = await runAnalysis({
    model: TEXT_MODEL,
    profile: opts.profile,
    content: [
      {
        type: 'input_text',
        text: `请分析下面这段即将发送给联系人的消息，识别其中的敏感信息与语义风险。${truncated ? '（注意：消息过长，以下为前 ' + TEXT_CAP + ' 字）' : ''}\n\n---消息开始---\n${trimmed}\n---消息结束---`,
      },
    ],
  });
  result.truncated = truncated;
  return result;
}

module.exports = {
  analyzeImage,
  analyzeText,
  analyzeAudio,
  analyzeVideo,
  parseDataUrl,
  extractJson,
  extractTranscriptFallback,
  readOutputText,
  readChatContent,
  toItems,
  UpstreamError,
  VISION_MODEL,
  TEXT_MODEL,
  AUDIO_MODEL,
  VIDEO_MODEL,
  AUDIO_MIME_TO_FORMAT,
  VIDEO_MIME_TO_FORMAT,
  TYPE_LABEL,
};
