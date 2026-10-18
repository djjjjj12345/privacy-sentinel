/**
 * providers/common.js — 供应商无关的公共逻辑
 * ---------------------------------------------------------------
 * 这里放的是「不论用火山方舟还是华为云 MaaS 都要用」的东西：
 *   - 模型输出解析的三层防守（剥离代码块 / 截取花括号 / 修尾随逗号）
 *   - 条目归一化（字段别名容错）
 *   - data URL 解析、媒体格式白名单
 *   - 统一的上游错误类型与 HTTP 错误翻译
 *
 * 抽出来的目的：换供应商时只改 provider，不重写防守逻辑。
 */
'use strict';
const { buildSystemPrompt, normalizeItem } = require('../schema');

// 方舟图片上限约 10MB，base64 会膨胀约 1/3，这里按 base64 长度粗略设卡
const MAX_DATA_URL_LENGTH = 14 * 1024 * 1024;
// 音频/视频 base64 上限 25MB 原文 -> 约 33MB base64。这里限制 30MB base64，留足裕度。
const MAX_MEDIA_BASE64_LENGTH = 30 * 1024 * 1024;

// 浏览器录的常见 mime 与支持格式的映射
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

/**
 * 从模型返回的自由文本中提取 JSON 对象。
 * 依次尝试：直接解析 → 去代码块 → 截取最外层花括号 → 修复常见瑕疵。
 */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;

  let s = text.trim();

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

  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const sliced = s.slice(first, last + 1);
    result = attempt(sliced);
    if (result) return result;

    const repaired = sliced
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    result = attempt(repaired);
    if (result) return result;
  }

  return null;
}

/** 从 Responses API 的返回体中取出文本（火山方舟） */
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

/** 从 Chat Completions 的返回体中取出文本（方舟音视频 / 华为云 MaaS） */
function readChatContent(data) {
  const choice = data && data.choices && data.choices[0];
  return (choice && choice.message && typeof choice.message.content === 'string')
    ? choice.message.content
    : '';
}

/** 把模型返回的解析结果转成标准条目 */
function toItems(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  // json_object 模式不约束字段名，模型偶尔会用同义键名。
  // 这里按优先级尝试常见别名，避免「有结果却整批丢弃」。
  const ARRAY_KEYS = ['items', 'sensitive_items', 'sensitiveItems', 'detections', 'findings'];
  let arr = null;
  for (const key of ARRAY_KEYS) {
    if (Array.isArray(parsed[key])) {
      arr = parsed[key];
      break;
    }
  }
  if (!arr) return [];
  return arr.map((raw) => normalizeItem(raw, 'ai')).filter(Boolean);
}

/**
 * 把 data URL 切成 mime 与纯 base64。失败返回 null。
 */
function parseDataUrl(input) {
  if (typeof input !== 'string') return null;
  const m = input.match(/^data:([^;]+);base64,(.+)$/i);
  if (!m) return null;
  return { mime: m[1].toLowerCase(), base64: m[2] };
}

/**
 * 当模型没吐 JSON 时，把它的自由文本当转写看——总比丢掉好。
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
 * 把 axios 错误翻译成用户能看懂的提示。
 * 不同供应商的 Key 变量名不同，通过参数传入，避免文案误导排查方向。
 */
function describeHttpError(error, opts = {}) {
  const { modelVar = 'ARK_VISION_MODEL', keyVar = 'ARK_API_KEY', providerLabel = '模型服务' } = opts;
  const status = error && error.response && error.response.status;
  const payload = error && error.response && error.response.data;

  const isTimeout = !status && (
    error.code === 'ECONNABORTED' ||
    /timeout of \d+ms exceeded/i.test(error.message || '')
  );

  const detail = payload
    ? (payload.error ? payload.error.message || JSON.stringify(payload.error) : JSON.stringify(payload))
    : (error && error.message);

  const hintMap = {
    401: `API Key 无效或已失效，请检查 ${keyVar}`,
    403: `API Key 无权限，请确认已开通该模型`,
    404: `模型不存在，请检查 ${modelVar} 是否与控制台中的模型 ID 一致`,
    429: '触发限流或余额不足，请稍后重试',
  };

  const hint = isTimeout
    ? '模型处理超时（音视频抽帧转写较慢），请剪短或压缩后重试'
    : (hintMap[status] || `${providerLabel}调用失败`);
  return {
    status: isTimeout ? 504 : (status || 502),
    message: `${hint}${detail ? `（${String(detail).slice(0, 200)}）` : ''}`,
  };
}

/** 把系统提示词与用户内容拼成 Chat Completions 的 messages */
function buildChatMessages({ profile, content }) {
  return [
    { role: 'system', content: buildSystemPrompt(profile) },
    { role: 'user', content },
  ];
}

module.exports = {
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
  buildChatMessages,
};
