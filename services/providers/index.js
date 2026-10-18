/**
 * providers/index.js — 模型供应商路由
 * ---------------------------------------------------------------
 * AI_PROVIDER=ark|huawei 决定主通道；未配置时默认 ark（保持线上行为不变）。
 *
 * 能力降级：
 *   华为云 MaaS 没有音频/视频直传通道，这类请求会按 AI_FALLBACK_PROVIDER
 *   （默认 ark）回退；若备用通道也未配置，返回一条能指导排查的错误，
 *   而不是假装成功——假阴性比报错危险得多。
 *
 * 设计原则：对外只暴露 analyzeImage/Text/Audio/Video 四个方法，
 * 与旧版 services/visionAnalyzer.js 完全同构，上层零改动。
 */
'use strict';
const logger = require('../logger');
const { UpstreamError } = require('./common');

const REGISTRY = {
  ark: () => require('./ark'),
  huawei: () => require('./huawei'),
};

const cache = {};
const warned = new Set();

function currentName() {
  return String(process.env.AI_PROVIDER || 'ark').trim().toLowerCase();
}

function getProvider(name) {
  const key = String(name || currentName()).trim().toLowerCase();
  const loader = REGISTRY[key];
  if (!loader) {
    if (!warned.has(key)) {
      warned.add(key);
      logger.warn(`[provider] 未知的 AI_PROVIDER=${key}，已回退到 ark`);
    }
    return getProvider('ark');
  }
  if (!cache[key]) cache[key] = loader();
  return cache[key];
}

function fallbackName(primary) {
  const name = String(process.env.AI_FALLBACK_PROVIDER || 'ark').trim().toLowerCase();
  return name && name !== primary.name ? name : '';
}

/**
 * 统一调用入口：主通道有能力就直接调，没有能力则尝试回退。
 */
async function invoke(kind, method, args) {
  const primary = getProvider();
  if (primary.capabilities[kind]) {
    return primary[method](...args);
  }

  const fbName = fallbackName(primary);
  if (fbName) {
    const fb = getProvider(fbName);
    if (fb.capabilities[kind] && fb.isConfigured()) {
      logger.warn(`[provider] ${primary.label} 不支持 ${kind}，已回退到 ${fb.label}`);
      return fb[method](...args);
    }
  }

  // 没有可用回退：让 provider 自己抛出带排查指引的错误
  return primary[method](...args);
}

function analyzeImage(...args) { return invoke('image', 'analyzeImage', args); }
function analyzeText(...args) { return invoke('text', 'analyzeText', args); }
function analyzeAudio(...args) { return invoke('audio', 'analyzeAudio', args); }
function analyzeVideo(...args) { return invoke('video', 'analyzeVideo', args); }

/** 供 /api/health 与测试使用 */
function info() {
  const p = getProvider();
  return {
    provider: p.name,
    label: p.label,
    capabilities: p.capabilities,
    configured: p.isConfigured(),
    fallback: fallbackName(p) || null,
  };
}

/** 测试用：清掉实例缓存，让环境变量改动立即生效 */
function reset() {
  for (const k of Object.keys(cache)) delete cache[k];
  warned.clear();
}

module.exports = {
  getProvider,
  currentName,
  analyzeImage,
  analyzeText,
  analyzeAudio,
  analyzeVideo,
  info,
  reset,
  UpstreamError,
};
