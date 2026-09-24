/**
 * 分析编排层
 * ---------------------------------------------------------------
 * 把「本地正则引擎」和「多模态模型」的结果融合成一份统一响应。
 * 前端只需要消费这一份数据，不必关心背后用了几个引擎。
 */

const localDetector = require('./localDetector');
const vision = require('./visionAnalyzer');
const {
  fuseItems,
  maxLevelOf,
  summarize,
  LEVEL_NAME,
  TYPE_LABEL,
} = require('./schema');

/** 模型不可用时的确定性建议，避免前端拿到空建议 */
function fallbackAdvice(items, maxLevel) {
  if (!items.length) return '未发现敏感信息，可以放心发送。';
  const labels = Array.from(new Set(items.map((i) => i.label))).join('、');
  if (maxLevel >= 4) return `「${labels}」绝不能泄露，请立即停止发送并检查账户安全。`;
  if (maxLevel >= 3) return `「${labels}」风险很高，建议先通过电话等其他渠道核实对方身份。`;
  if (maxLevel >= 2) return `建议先确认对方身份，或把「${labels}」脱敏后再发送。`;
  return `建议确认对方身份后再发送「${labels}」。`;
}

function buildResult({ kind, items, ai, local, warnings = [] }) {
  const maxLevel = maxLevelOf(items);
  const usedAi = ai && ai.ok;
  const source = local && local.length && usedAi ? 'hybrid' : usedAi ? 'ai' : 'local';

  return {
    success: true,
    kind,
    source,
    engine: {
      local: local ? local.length : 0,
      ai: usedAi ? ai.items.length : 0,
    },
    hasSensitive: items.length > 0,
    maxLevel,
    levelName: LEVEL_NAME[maxLevel] || LEVEL_NAME[0],
    summary: usedAi && ai.summary ? ai.summary : summarize(items),
    items,
    advice: (usedAi && ai.advice) || fallbackAdvice(items, maxLevel),
    transcript: (ai && ai.transcript) || null,
    warnings,
    meta: {
      model: ai ? ai.model : null,
      elapsedMs: ai ? ai.elapsedMs : 0,
      requestId: ai ? ai.requestId : null,
    },
  };
}

/**
 * 分析图片。图片的原始像素内容只有模型能读，没有本地兜底。
 *
 * 因此这里的失败处理必须严格：模型没给出可解析结果时必须报错，
 * 绝不能返回「未检测到敏感信息」——那是一个危险的假阴性。
 * @param {string} imageUrl base64 data URL 或公网地址
 */
async function analyzeImage({ imageUrl, image_url, profile = {}, question }) {
  const url = imageUrl || image_url;

  let ai = null;
  try {
    ai = await vision.analyzeImage(url, { profile, question });
  } catch (error) {
    return {
      success: false,
      kind: 'image',
      error: error.message || '视觉模型调用失败',
      status: error.status || 500,
    };
  }

  if (!ai.ok) {
    return {
      success: false,
      kind: 'image',
      status: 502,
      error: '模型未返回可解析的结构化结果，本次识别无效，请重试',
      rawOutput: ai.rawText ? ai.rawText.slice(0, 300) : undefined,
    };
  }

  if (ai.claimedSensitive && !ai.items.length) {
    return {
      success: false,
      kind: 'image',
      status: 502,
      error: '模型认为存在敏感信息但未给出可用条目，本次识别无效，请重试',
    };
  }

  return buildResult({ kind: 'image', items: ai.items, ai, local: [], warnings: [] });
}

/**
 * 音视频统一处理：先调模型拿到转写文字与 AI 条目，再用转写文字跑一遍本地正则兜底。
 * 失败必须如实上报——音频/视频不像文本能纯本地兜底，但转写出来后又退化成纯文本问题，
 * 此时本地正则就是可靠的兜底。
 *
 * @param {'audio' | 'video'} kind
 */
async function analyzeMediaKind(kind, { dataUrl, profile = {}, question }) {
  const method = kind === 'audio' ? vision.analyzeAudio : vision.analyzeVideo;

  let ai = null;
  try {
    ai = await method(dataUrl, { profile, question });
  } catch (error) {
    return {
      success: false,
      kind,
      error: error.message || `${kind === 'audio' ? '音频' : '视频'}识别失败`,
      status: error.status || 500,
    };
  }

  if (!ai.ok) {
    return {
      success: false,
      kind,
      status: 502,
      error: `${kind === 'audio' ? '音频' : '视频'}识别：模型未返回可解析的结构化结果，请重试`,
      rawOutput: ai.rawText ? ai.rawText.slice(0, 300) : undefined,
      transcript: ai.transcript || null,
    };
  }

  if (ai.claimedSensitive && !ai.items.length) {
    return {
      success: false,
      kind,
      status: 502,
      error: `${kind === 'audio' ? '音频' : '视频'}识别：模型认为存在敏感信息但未给出可用条目，请重试`,
      transcript: ai.transcript || null,
    };
  }

  // 转写出来的文字跑一遍本地正则。模型漏掉的格式敏感信息能被这里补回来。
  const local = ai.transcript ? localDetector.detect(ai.transcript) : [];
  const warnings = [];
  if (ai.transcript && !local.length && !ai.items.length) {
    warnings.push('转写文本未匹配到本地规则，可作为辅助参考');
  }

  const items = fuseItems(local, ai.items);
  return buildResult({ kind, items, ai, local, warnings });
}

async function analyzeAudio(params) {
  return analyzeMediaKind('audio', params);
}

async function analyzeVideo(params) {
  return analyzeMediaKind('video', params);
}

/**
 * 分析文本。正则先跑一遍作为确定性底线，模型结果再融合进来。
 * @param {string} text
 */
async function analyzeText({ text, profile = {} }) {
  if (!text || !String(text).trim()) {
    return { success: false, kind: 'text', error: '文本内容为空', status: 400 };
  }

  const local = localDetector.detect(text);
  const warnings = [];

  let ai = null;
  try {
    ai = await vision.analyzeText(text, { profile });
  } catch (error) {
    // 模型挂了也不能让功能不可用：退回纯正则结果，并明确告知用户
    warnings.push(`AI 语义检测不可用（${error.message}），当前结果来自本地规则引擎`);
    ai = null;
  }

  if (ai && !ai.ok) {
    warnings.push('模型未返回结构化结果，已使用本地规则引擎兜底');
  }

  const aiItems = ai && ai.ok ? ai.items : [];
  const items = fuseItems(local, aiItems);

  return buildResult({ kind: 'text', items, ai, local, warnings });
}

/**
 * 文本的「仅本地」快速通道，用于前端点击发送时的零延迟预检。
 */
function analyzeTextLocalOnly(text) {
  const items = localDetector.detect(text);
  const maxLevel = maxLevelOf(items);
  return {
    success: true,
    kind: 'text',
    source: 'local',
    engine: { local: items.length, ai: 0 },
    hasSensitive: items.length > 0,
    maxLevel,
    levelName: LEVEL_NAME[maxLevel] || LEVEL_NAME[0],
    summary: summarize(items),
    items,
    advice: fallbackAdvice(items, maxLevel),
    transcript: null,
    warnings: [],
    meta: { model: null, elapsedMs: 0, requestId: null },
  };
}

module.exports = {
  analyzeImage,
  analyzeText,
  analyzeAudio,
  analyzeVideo,
  analyzeTextLocalOnly,
  fallbackAdvice,
  TYPE_LABEL,
};
