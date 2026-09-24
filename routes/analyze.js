/**
 * 统一分析接口
 * ---------------------------------------------------------------
 * POST /api/analyze
 *
 * 前端不再区分「文本走谁、图片走谁」，只提交 kind + 内容，
 * 由服务端决定调用哪些引擎并返回统一的 items 结构。
 *
 * 请求体：
 * {
 *   "kind": "image" | "text" | "audio" | "video",
 *   "dataUrl": "data:image/jpeg;base64,...",   // image/audio/video 使用
 *   "text": "要检测的文本",                     // text 使用
 *   "fileName": "idcard.jpg",                  // 可选，仅用于回显
 *   "question": "自定义提问",                   // 可选
 *   "mode": "full" | "local",                  // 可选，仅 text 有效
 *   "profile": { "age": "30-45", "literacy": "mid", "sensitivity": "mid" }
 * }
 */

const express = require('express');
const router = express.Router();

const analyzer = require('../services/analyzer');
const { TYPE_LABEL, TYPE_FLOOR, LEVEL_NAME } = require('../services/schema');

// ------------------------------------------------------------------
//  轻量限流：保护 API Key 不被单页循环刷爆
// ------------------------------------------------------------------
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 30);
const WINDOW_MS = 60 * 1000;
const hits = new Map();

function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip || 'unknown';
}

function rateLimit(req, res, next) {
  if (!RATE_LIMIT || RATE_LIMIT <= 0) return next();
  const key = clientKey(req);
  const now = Date.now();
  const record = hits.get(key) || { count: 0, resetAt: now + WINDOW_MS };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + WINDOW_MS;
  }
  record.count += 1;
  hits.set(key, record);

  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT - record.count)));

  if (record.count > RATE_LIMIT) {
    const retryAfter = Math.ceil((record.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      success: false,
      error: `请求过于频繁，请 ${retryAfter} 秒后再试`,
      retryAfter,
    });
  }
  next();
}

// 定期清理过期的限流记录，避免内存无限增长
const cleaner = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of hits) {
    if (now > record.resetAt) hits.delete(key);
  }
}, WINDOW_MS);
if (cleaner.unref) cleaner.unref();

/**
 * 用户画像白名单过滤，避免外部传入任意字段污染提示词
 */
function sanitizeProfile(input) {
  if (!input || typeof input !== 'object') return {};
  const allowedAge = ['18-', '30-45', '45-60', '60+'];
  const allowedLit = ['basic', 'mid', 'adv'];
  const allowedSens = ['low', 'mid', 'high'];
  const out = {};
  if (allowedAge.includes(input.age)) out.age = input.age;
  if (allowedLit.includes(input.literacy)) out.literacy = input.literacy;
  if (allowedSens.includes(input.sensitivity)) out.sensitivity = input.sensitivity;
  return out;
}

// ------------------------------------------------------------------
//  契约查询：让前端可以动态拿到类型与等级定义，避免两边硬编码漂移
// ------------------------------------------------------------------
router.get('/schema', (req, res) => {
  res.json({
    success: true,
    types: TYPE_LABEL,
    floors: TYPE_FLOOR,
    levels: LEVEL_NAME,
    kinds: {
      image: 'supported',
      text: 'supported',
      audio: 'supported',
      video: 'supported',
    },
  });
});

// ------------------------------------------------------------------
//  主分析入口
// ------------------------------------------------------------------
router.post('/', rateLimit, async (req, res) => {
  const body = req.body || {};
  const kind = String(body.kind || '').trim().toLowerCase();
  const profile = sanitizeProfile(body.profile);

  try {
    if (kind === 'image') {
      const dataUrl = body.dataUrl || body.image_url || body.imageUrl;
      if (!dataUrl) {
        return res.status(400).json({ success: false, error: '缺少图片内容（dataUrl）' });
      }
      const result = await analyzer.analyzeImage({
        imageUrl: dataUrl,
        profile,
        question: body.question,
      });
      if (!result.success) {
        return res.status(result.status || 500).json(result);
      }
      return res.json(result);
    }

    if (kind === 'text') {
      const text = body.text || body.content;
      if (!text || !String(text).trim()) {
        return res.status(400).json({ success: false, error: '缺少文本内容（text）' });
      }
      if (body.mode === 'local') {
        return res.json(analyzer.analyzeTextLocalOnly(String(text)));
      }
      const result = await analyzer.analyzeText({ text: String(text), profile });
      if (!result.success) {
        return res.status(result.status || 500).json(result);
      }
      return res.json(result);
    }

    if (kind === 'audio' || kind === 'video') {
      const dataUrl = body.dataUrl || body.file_data;
      if (!dataUrl) {
        return res
          .status(400)
          .json({ success: false, kind, error: `缺少${kind === 'audio' ? '音频' : '视频'}内容（dataUrl）` });
      }
      const method = kind === 'audio' ? analyzer.analyzeAudio : analyzer.analyzeVideo;
      const result = await method({ dataUrl, profile, question: body.question });
      if (!result.success) {
        return res.status(result.status || 500).json(result);
      }
      return res.json(result);
    }

    return res.status(400).json({
      success: false,
      error: `不支持的内容类型：${kind || '(空)'}，可选值 image / text / audio / video`,
    });
  } catch (error) {
    console.error('[analyze] 未捕获异常:', error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '服务内部错误',
    });
  }
});

module.exports = router;
