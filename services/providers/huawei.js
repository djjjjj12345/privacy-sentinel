/**
 * providers/huawei.js — 华为云 MaaS 实现
 * ---------------------------------------------------------------
 * 走 MaaS 的 OpenAI 兼容接口（POST {base}/chat/completions）：
 *   文本 → messages: [system, user(text)]
 *   图片 → content: [{type:'image_url', image_url:{url}}, {type:'text', text}]
 *
 * 能力边界（重要，别在材料里写错）：
 *   MaaS 预置的多模态模型是「视觉-语言」模型，**没有音频/视频直传入参**。
 *   所以本 provider 声明 capabilities.audio/video = false，
 *   由 providers/index.js 按 AI_FALLBACK_PROVIDER 回退到方舟，
 *   或者（未配置回退时）返回一条能指导排查的明确错误。
 *   真正的国产化音视频链路要走「SIS 转写 → 本地正则 → 文本模型」两级流水线，
 *   见 docs/huawei-deploy.md 的「音视频后续接入」一节。
 *
 * 环境变量：
 *   HW_MAAS_BASE_URL   控制台「API 调用」页签里的完整地址
 *   HW_MAAS_API_KEY    API Key（明文只显示一次）
 *   HW_MAAS_AUTH       bearer（默认）| apig
 *   HW_VISION_MODEL    默认 Qwen2.5-VL-7B-Instruct
 *   HW_TEXT_MODEL      默认 DeepSeek-V4.1-Flash
 */
'use strict';
const axios = require('axios');
const { buildSystemPrompt } = require('../schema');
const {
  UpstreamError,
  MAX_DATA_URL_LENGTH,
  MAX_MEDIA_BASE64_LENGTH,
  AUDIO_MIME_TO_FORMAT,
  extractJson,
  toItems,
  parseDataUrl,
  describeHttpError,
} = require('./common');
const sis = require('./huawei-sis');

const VISION_MODEL = process.env.HW_VISION_MODEL || 'Qwen2.5-VL-7B-Instruct';
const TEXT_MODEL = process.env.HW_TEXT_MODEL || 'DeepSeek-V4.1-Flash';
const AUTH_MODE = String(process.env.HW_MAAS_AUTH || 'bearer').toLowerCase();

/** 运行时读取，便于测试与容器里改环境变量后立即生效 */
function baseUrl() {
  return String(process.env.HW_MAAS_BASE_URL || '').replace(/\/+$/, '');
}

function chatEndpoint() {
  const base = baseUrl();
  if (!base) {
    throw new UpstreamError(
      '未配置 HW_MAAS_BASE_URL。请到华为云 MaaS 控制台 → 已开通模型 → 「API 调用」页签复制完整地址。',
      500
    );
  }
  // 控制台给的地址可能已经带 /v1 或 /chat/completions，两种都要能接
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

function getApiKey() {
  const key = process.env.HW_MAAS_API_KEY;
  if (!key) {
    throw new UpstreamError(
      '未配置 HW_MAAS_API_KEY。请在 .env 或部署环境变量中填入华为云 MaaS 的 API Key。',
      500
    );
  }
  return key;
}

function authHeaders() {
  const key = getApiKey();
  const mode = String(process.env.HW_MAAS_AUTH || AUTH_MODE || 'bearer').toLowerCase();
  if (mode === 'apig') {
    // API 网关的 AppCode 鉴权方式
    return { 'X-Apig-AppCode': key, 'Content-Type': 'application/json' };
  }
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

/** 有些 OpenAI 兼容实现把 content 返回成数组，这里统一拼成字符串 */
function readContent(data) {
  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content)) || ''))
      .join('\n');
  }
  return '';
}

async function callHuawei({ model, messages, timeout = 90000, jsonMode = true }) {
  const body = { model, messages, temperature: 0.2 };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const send = (payload) => axios.post(chatEndpoint(), payload, {
    headers: authHeaders(),
    timeout,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: null,
  });

  let response;
  try {
    response = await send(body);
    // 部分模型不支持 response_format，去掉后重试一次
    if (response.status === 400 && jsonMode) {
      const retryBody = { model, messages, temperature: 0.2 };
      response = await send(retryBody);
    }
  } catch (error) {
    const info = describeHttpError(error, {
      modelVar: 'HW_VISION_MODEL',
      keyVar: 'HW_MAAS_API_KEY',
      providerLabel: '华为云 MaaS',
    });
    throw new UpstreamError(info.message, info.status);
  }

  if (response.status >= 400) {
    const info = describeHttpError(
      { response: { status: response.status, data: response.data } },
      { modelVar: 'HW_VISION_MODEL', keyVar: 'HW_MAAS_API_KEY', providerLabel: '华为云 MaaS' }
    );
    throw new UpstreamError(info.message, info.status);
  }

  return response.data;
}

function normalizeResult(data, parsed, model, startedAt) {
  const elapsedMs = Date.now() - startedAt;
  if (!parsed) {
    return {
      ok: false,
      reason: 'model_output_not_json',
      rawText: readContent(data).slice(0, 2000),
      items: [],
      transcript: null,
      advice: '',
      summary: '',
      elapsedMs,
      model,
      requestId: data && data.id,
    };
  }
  return {
    ok: true,
    items: toItems(parsed),
    claimedSensitive: parsed.hasSensitive === true,
    transcript: typeof parsed.transcript === 'string' ? parsed.transcript : null,
    advice: typeof parsed.advice === 'string' ? parsed.advice.slice(0, 300) : '',
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 200) : '',
    elapsedMs,
    model,
    requestId: data && data.id,
  };
}

async function analyzeText(text, opts = {}) {
  if (!text || typeof text !== 'string') {
    throw new UpstreamError('缺少文本内容', 400);
  }
  const TEXT_CAP = 12000;
  const truncated = text.length > TEXT_CAP;
  const trimmed = text.slice(0, TEXT_CAP);
  const startedAt = Date.now();

  const messages = [
    { role: 'system', content: buildSystemPrompt(opts.profile) },
    {
      role: 'user',
      content:
        `请分析下面这段即将发送给联系人的消息，识别其中的敏感信息与语义风险。` +
        `${truncated ? `（注意：消息过长，以下为前 ${TEXT_CAP} 字）` : ''}\n\n` +
        `---消息开始---\n${trimmed}\n---消息结束---`,
    },
  ];

  const data = await callHuawei({ model: TEXT_MODEL, messages, timeout: 90000 });
  const parsed = extractJson(readContent(data));
  const result = normalizeResult(data, parsed, TEXT_MODEL, startedAt);
  result.truncated = truncated;
  return result;
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

  const messages = [
    { role: 'system', content: buildSystemPrompt(opts.profile) },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        { type: 'text', text: question },
      ],
    },
  ];

  const startedAt = Date.now();
  const data = await callHuawei({ model: VISION_MODEL, messages, timeout: 120000 });
  const parsed = extractJson(readContent(data));
  return normalizeResult(data, parsed, VISION_MODEL, startedAt);
}

function unsupported(kind) {
  return new UpstreamError(
    `华为云 MaaS 预置模型不支持${kind}直传。` +
    `请配置华为云 SIS（HW_AK/HW_SK/HW_PROJECT_ID/HW_REGION/HW_SIS_ENDPOINT/HW_OBS_BUCKET/HW_OBS_ENDPOINT）启用音频转写，` +
    `或设置 AI_FALLBACK_PROVIDER=ark 走备用通道。详见 docs/huawei-deploy.md 第 6 节。`,
    501
  );
}

/**
 * 音频分析：SIS 转写 → 复用 analyzeText 同一套 system prompt 与字段别名容错。
 * 不另写解析逻辑：callHuawei / extractJson / readContent / normalizeResult 全部复用。
 * 转写文本会作为 transcript 返回，上层 analyzer.js 会再用本地正则兜底。
 */
async function analyzeAudio(dataUrl, opts = {}) {
  if (!sis.isConfigured()) {
    throw unsupported('音频');
  }

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

  const buffer = Buffer.from(parsed.base64, 'base64');
  const startedAt = Date.now();

  const transcript = await sis.transcribe({
    buffer,
    mimeType: parsed.mime,
    filename: `audio.${fmt}`,
  });

  const text = transcript.text || '';
  const TEXT_CAP = 12000;
  const truncated = text.length > TEXT_CAP;
  const trimmed = text.slice(0, TEXT_CAP);

  if (!trimmed) {
    return {
      ok: true,
      items: [],
      claimedSensitive: false,
      transcript: '',
      advice: '音频转写结果为空，未检测到语音内容',
      summary: '音频转写为空',
      elapsedMs: Date.now() - startedAt,
      model: TEXT_MODEL,
      requestId: null,
      transcribeProvider: transcript.provider,
      audioDurationMs: transcript.durationMs != null ? transcript.durationMs : undefined,
    };
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt(opts.profile) },
    {
      role: 'user',
      content:
        `以下是音频转写文本，请识别其中的敏感信息并按规定 JSON 结构输出。` +
        `${truncated ? `（注意：转写过长，以下为前 ${TEXT_CAP} 字）` : ''}\n\n` +
        `---转写开始---\n${trimmed}\n---转写结束---`,
    },
  ];

  const data = await callHuawei({ model: TEXT_MODEL, messages, timeout: 90000 });
  const parsedJson = extractJson(readContent(data));
  const result = normalizeResult(data, parsedJson, TEXT_MODEL, startedAt);
  result.transcript = text;
  result.truncated = truncated;
  result.transcribeProvider = transcript.provider;
  if (transcript.durationMs != null) result.audioDurationMs = transcript.durationMs;
  return result;
}

async function analyzeVideo() { throw unsupported('视频'); }

module.exports = {
  name: 'huawei',
  label: '华为云 MaaS',
  get capabilities() {
    return { text: true, image: true, audio: sis.isConfigured(), video: false };
  },
  isConfigured: () => Boolean(process.env.HW_MAAS_BASE_URL && process.env.HW_MAAS_API_KEY),
  baseUrl,
  chatEndpoint,
  readContent,
  callHuawei,
  analyzeImage,
  analyzeText,
  analyzeAudio,
  analyzeVideo,
  VISION_MODEL,
  TEXT_MODEL,
};
