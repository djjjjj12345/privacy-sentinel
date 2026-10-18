/**
 * visionAnalyzer.js — 兼容门面（v3.3）
 * ---------------------------------------------------------------
 * 真正的实现在 services/providers/ 下：
 *   providers/ark.js     — 火山方舟（文本/图片走 Responses，音视频走 Chat Completions）
 *   providers/huawei.js  — 华为云 MaaS（OpenAI 兼容，文本/图片）
 *   providers/index.js   — 按 AI_PROVIDER 路由 + 能力降级
 *
 * 保留这个文件是为了让 analyzer.js / 诊断脚本 / 历史测试的 require 路径不变，
 * 导出签名与旧版完全一致。新增代码请直接 require('./providers')。
 */
'use strict';
const providers = require('./providers');
const common = require('./providers/common');
const { TYPE_LABEL } = require('./schema');

const VISION_MODEL = process.env.ARK_VISION_MODEL || 'doubao-seed-2-0-mini-260428';
const TEXT_MODEL = process.env.ARK_TEXT_MODEL || VISION_MODEL;
const AUDIO_MODEL = process.env.ARK_AUDIO_MODEL || VISION_MODEL;
const VIDEO_MODEL = process.env.ARK_VIDEO_MODEL || VISION_MODEL;

module.exports = {
  analyzeImage: (...args) => providers.analyzeImage(...args),
  analyzeText: (...args) => providers.analyzeText(...args),
  analyzeAudio: (...args) => providers.analyzeAudio(...args),
  analyzeVideo: (...args) => providers.analyzeVideo(...args),

  // 公共工具（保持旧导出，测试与诊断脚本仍在用）
  parseDataUrl: common.parseDataUrl,
  extractJson: common.extractJson,
  extractTranscriptFallback: common.extractTranscriptFallback,
  readOutputText: common.readOutputText,
  readChatContent: common.readChatContent,
  toItems: common.toItems,
  UpstreamError: common.UpstreamError,

  // 常量
  VISION_MODEL,
  TEXT_MODEL,
  AUDIO_MODEL,
  VIDEO_MODEL,
  AUDIO_MIME_TO_FORMAT: common.AUDIO_MIME_TO_FORMAT,
  VIDEO_MIME_TO_FORMAT: common.VIDEO_MIME_TO_FORMAT,
  TYPE_LABEL,

  // 新增：便于健康检查展示当前供应商
  providerInfo: providers.info,
};
