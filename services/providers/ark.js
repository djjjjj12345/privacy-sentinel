/**
 * providers/ark.js — 火山方舟实现
 * ---------------------------------------------------------------
 * 与原 services/visionAnalyzer.js 的行为完全一致，只是搬进了 provider 目录：
 *   - 文本 / 图片 → Responses API（input_text / input_image）
 *   - 音频 → Chat Completions input_audio
 *   - 视频 → Chat Completions video_url
 *
 * 三层防守（提示词 / 解析 / 校验）原样保留：
 *   json_object 只保证「是合法 JSON」，不保证字段齐全，
 *   模型给的所有值都只当线索，最终由 schema.normalizeItem 重算。
 */
'use strict';
const axios = require('axios');
const { buildSystemPrompt } = require('../schema');
const {
  UpstreamError,
  MAX_DATA_URL_LENGTH,
  MAX_MEDIA_BASE64_LENGTH,
  AUDIO_MIME_TO_FORMAT,
  VIDEO_MIME_TO_FORMAT,
  extractJson,
  readOutputText,
  readChatContent,
  toItems,
  parseDataUrl,
  extractTranscriptFallback,
  describeHttpError,
} = require('./common');

const BASE_URL = (process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
const VISION_MODEL = process.env.ARK_VISION_MODEL || 'doubao-seed-2-0-mini-260428';
const TEXT_MODEL = process.env.ARK_TEXT_MODEL || VISION_MODEL;
// 音频/视频单独走 Chat Completions。
// 默认沿用 VISION_MODEL：实测 doubao-seed-2-0-mini 系列同时支持 input_audio 与 video_url。
const AUDIO_MODEL = process.env.ARK_AUDIO_MODEL || VISION_MODEL;
const VIDEO_MODEL = process.env.ARK_VIDEO_MODEL || VISION_MODEL;

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
 * 带降级重试的调用：模型不支持 json_object 模式（400）时去掉该参数重试一次。
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

async function runAnalysis({ model, content, profile }) {
  const startedAt = Date.now();
  let data;
  try {
    data = await callArkWithFallback({ model, content, profile });
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    const info = describeHttpError(error, { modelVar: 'ARK_VISION_MODEL', keyVar: 'ARK_API_KEY', providerLabel: '火山方舟' });
    throw new UpstreamError(info.message, info.status);
  }

  const text = readOutputText(data);
  const parsed = extractJson(text);
  const elapsedMs = Date.now() - startedAt;

  if (!parsed) {
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

async function callArkChat({ model, messages, timeout = 120000 }) {
  const apiKey = getApiKey();

  const response = await axios.post(`${BASE_URL}/chat/completions`, {
    model,
    messages,
    temperature: 0.2,
  }, {
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
 * 统一的「先转写为文字、再识别敏感条目」任务。
 * Chat Completions 的内容类型名与 Responses API 不同：
 *   文本 "text"、视频 "video_url"、音频 "input_audio"（data 收纯 base64）。
 */
async function analyzeMedia({ model, modelVar, inputPart, question, profile = {}, label }) {
  const startedAt = Date.now();

  // 关键：必须把 JSON 结构写进 system prompt，否则模型会自己编字段名。
  const firstMessages = [
    { role: 'system', content: buildSystemPrompt(profile) },
    { role: 'user', content: [inputPart, { type: 'text', text: question }] },
  ];

  let data;
  try {
    data = await callArkChat({ model, messages: firstMessages, timeout: 180000 });
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    const info = describeHttpError(error, { modelVar, keyVar: 'ARK_API_KEY', providerLabel: '火山方舟' });
    throw new UpstreamError(`${label}识别失败：${info.message}`, info.status);
  }

  let text = readChatContent(data);
  let parsed = extractJson(text);

  // 修复轮：模型声称有敏感信息但 items 缺失/为空/字段不合规时，
  // 复用第一轮上下文追加一轮纠正提问（不重传媒体，开销小、速度快）。
  if (parsed && parsed.hasSensitive === true && !toItems(parsed).length) {
    try {
      const repairMessages = firstMessages.concat([
        { role: 'assistant', content: text },
        {
          role: 'user',
          content:
            '你上一条回复中 hasSensitive 为 true，但 items 数组缺失、为空或字段不符合要求。' +
            '请重新输出完整 JSON：把每一个敏感条目放入 items 数组，每条必须包含 type' +
            '（id/bankcard/phone/password/otp/address/name/other 之一）与 raw（逐字符照抄原文）两个字段。' +
            '若确实没有敏感信息，输出 hasSensitive:false 且 items 为空数组。',
        },
      ]);
      const data2 = await callArkChat({ model, messages: repairMessages, timeout: 120000 });
      const text2 = readChatContent(data2);
      const parsed2 = extractJson(text2);
      if (parsed2 && (toItems(parsed2).length || parsed2.hasSensitive !== true)) {
        data = data2;
        text = text2;
        parsed = parsed2;
      }
    } catch (repairError) {
      // 修复轮失败不致命：沿用第一轮结果，交给上层兜底
    }
  }

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
    profile: opts.profile,
    label: '音频',
    inputPart: { type: 'input_audio', input_audio: { data: parsed.base64, format: fmt } },
    question,
  });
}

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
    profile: opts.profile,
    label: '视频',
    inputPart: { type: 'video_url', video_url: { url: dataUrl } },
    question,
  });
}

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
  name: 'ark',
  label: '火山方舟',
  capabilities: { text: true, image: true, audio: true, video: true },
  isConfigured: () => Boolean(process.env.ARK_API_KEY || process.env.VOLC_API_KEY),
  baseUrl: BASE_URL,
  analyzeImage,
  analyzeText,
  analyzeAudio,
  analyzeVideo,
  // 仅供诊断脚本使用
  callArkChat,
  callArkWithFallback,
  VISION_MODEL,
  TEXT_MODEL,
  AUDIO_MODEL,
  VIDEO_MODEL,
};
