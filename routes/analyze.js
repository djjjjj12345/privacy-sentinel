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
const errors = require('../services/errors');
const logger = require('../services/logger');
const { checkImageUrl } = require('../services/urlGuard');

// ------------------------------------------------------------------
//  轻量限流：保护 API Key 不被单页循环刷爆
//  配置 REDIS_URL 时用 DCS 共享计数（多实例安全），否则退回进程内存。
// ------------------------------------------------------------------
const { createRateLimiter } = require('../services/rateLimiter');
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 30);
const rateLimit = createRateLimiter({
  limit: RATE_LIMIT,
  windowMs: 60 * 1000,
  prefix: 'ps:rl',
});

// 批量检测上限：
//  - 条数上限防止一次请求打满事件循环；
//  - 单条字数上限防止超长文本把整体响应撑爆。
const BATCH_MAX_ITEMS = 50;
const BATCH_MAX_ITEM_CHARS = 5000;
// 走 AI 的批量成本高、耗时长，条数再收紧一档
const BATCH_AI_MAX_ITEMS = 10;

/** 统一失败响应：走错误目录，保证前端拿到的文案一致 */
function fail(res, errOrCode, fallback) {
  const p = errors.payload(errOrCode, fallback);
  return res.status(errors.get(p.code).http).json(p);
}

/**
 * 校验并规范化 types（用户勾选的检测类型）。
 * 非法值忽略而非报错，避免前端版本不一致时整个请求失败。
 */
function normalizeTypes(input) {
  if (!Array.isArray(input)) return null;
  const valid = input.filter(
    (t) => typeof t === 'string' && Object.prototype.hasOwnProperty.call(TYPE_LABEL, t)
  );
  return valid.length ? valid : null;
}

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
    // 批量检测的能力边界，前端据此提示用户，而不是等服务端 400
    batch: {
      maxItems: BATCH_MAX_ITEMS,
      maxItemChars: BATCH_MAX_ITEM_CHARS,
      aiMaxItems: BATCH_AI_MAX_ITEMS,
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
  // 用户勾选的检测类型；null 表示全量
  const types = normalizeTypes(body.types);

  try {
    if (kind === 'image') {
      const dataUrl = body.dataUrl || body.image_url || body.imageUrl;
      if (!dataUrl) {
        return fail(res, 'empty_input', '缺少图片内容');
      }
      // 图片地址来自用户输入：先过 SSRF 守卫，别把服务端变成任意 URL 探测器
      if (!/^data:image\//i.test(String(dataUrl))) {
        const guard = checkImageUrl(dataUrl);
        if (!guard.ok) return fail(res, 'invalid_url', guard.reason);
      }
      const result = await analyzer.analyzeImage({
        imageUrl: dataUrl,
        profile,
        question: body.question,
        types,
      });
      if (!result.success) {
        return fail(res, result, result.error);
      }
      return res.json(result);
    }

    if (kind === 'text') {
      const text = body.text || body.content;
      if (!text || !String(text).trim()) {
        return fail(res, 'empty_input', '缺少文本内容');
      }
      if (body.mode === 'local') {
        return res.json(analyzer.analyzeTextLocalOnly(String(text), types));
      }
      const result = await analyzer.analyzeText({ text: String(text), profile, types });
      if (!result.success) {
        return fail(res, result, result.error);
      }
      return res.json(result);
    }

    if (kind === 'audio' || kind === 'video') {
      const dataUrl = body.dataUrl || body.file_data;
      if (!dataUrl) {
        return fail(res, 'empty_input', `缺少${kind === 'audio' ? '音频' : '视频'}内容`);
      }
      const method = kind === 'audio' ? analyzer.analyzeAudio : analyzer.analyzeVideo;
      const result = await method({ dataUrl, profile, question: body.question, types });
      if (!result.success) {
        return fail(res, result, result.error);
      }
      return res.json(result);
    }

    return fail(res, 'invalid_kind', `不支持的内容类型：${kind || '(空)'}`);
  } catch (error) {
    logger.error('[analyze] 未捕获异常:', error);
    return fail(res, error);
  }
});

// ------------------------------------------------------------------
//  批量检测
// ------------------------------------------------------------------
/**
 * POST /api/analyze/batch
 *
 * 一次提交多条文本，逐条返回检测结果，并给出汇总统计。
 *
 * 请求体：
 * {
 *   "items": [ { "text": "..." }, { "text": "...", "id": "row-3" } ],
 *   "mode": "local" | "full",        // 默认 local（不调用 AI，秒回且免费）
 *   "types": ["id", "phone"],        // 可选，只检测勾选的类型
 *   "profile": { ... }               // 仅 mode=full 生效
 * }
 *
 * 设计取舍：
 *   - 默认走本地规则引擎：批量场景通常几十上百行，走 AI 既慢又烧钱，
 *     而号码类信息本来就是正则的强项，本地结果完全够用；
 *   - 单条失败不影响其他条：逐条 catch，失败的那条单独带 error 字段，
 *     避免一行脏数据让整个批量请求白做。
 */
router.post('/batch', rateLimit, async (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body.items) ? body.items : null;
  const types = normalizeTypes(body.types);
  const mode = String(body.mode || 'local').toLowerCase();
  const useAi = mode === 'full';
  const profile = sanitizeProfile(body.profile);

  if (!list) {
    return fail(res, 'invalid_format', '请求体缺少 items 数组');
  }
  if (list.length === 0) {
    return fail(res, 'empty_input', '批量内容为空，请至少输入一行');
  }
  const maxItems = useAi ? BATCH_AI_MAX_ITEMS : BATCH_MAX_ITEMS;
  if (list.length > maxItems) {
    const p = errors.payload('invalid_format', `批量最多 ${maxItems} 条`);
    p.message = `本次提交了 ${list.length} 条，超过单次上限 ${maxItems} 条。`;
    p.action = useAi
      ? 'AI 模式成本较高，条数上限更严；改用本地模式（默认）可一次检测最多 ' + BATCH_MAX_ITEMS + ' 条。'
      : `请拆成多批提交，每批不超过 ${maxItems} 条。`;
    return res.status(p.code === 'invalid_format' ? 400 : 400).json(p);
  }

  const started = Date.now();
  const results = [];
  let riskyCount = 0;
  let globalMaxLevel = 0;
  const typeCounts = {};

  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    // 兼容两种写法：直接传字符串，或传 { text, id }
    const text = typeof raw === 'string' ? raw : raw && (raw.text || raw.content);
    const id = raw && typeof raw === 'object' ? raw.id : undefined;

    // 空行不算错误，标记跳过，保持行号与界面一一对应
    if (!text || !String(text).trim()) {
      results.push({
        index: i,
        id,
        skipped: true,
        success: true,
        items: [],
        maxLevel: 0,
        levelName: LEVEL_NAME[0],
        summary: '空行，已跳过',
      });
      continue;
    }

    if (String(text).length > BATCH_MAX_ITEM_CHARS) {
      results.push({
        index: i,
        id,
        success: false,
        skipped: false,
        items: [],
        maxLevel: 0,
        levelName: LEVEL_NAME[0],
        summary: '本条超出长度上限',
        code: 'invalid_format',
        title: '本条内容太长',
        message: `单条最多 ${BATCH_MAX_ITEM_CHARS} 字，这条有 ${String(text).length} 字。`,
        action: '请拆分后再提交。',
      });
      continue;
    }

    try {
      const r = useAi
        ? await analyzer.analyzeText({ text: String(text), profile, types })
        : analyzer.analyzeTextLocalOnly(String(text), types);

      if (!r || !r.success) {
        results.push({
          index: i,
          id,
          success: false,
          skipped: false,
          items: [],
          maxLevel: 0,
          levelName: LEVEL_NAME[0],
          summary: '检测失败',
          code: 'server_error',
          title: errors.get('server_error').title,
          message: (r && r.error) || '本条检测未成功',
          action: '可单独重试这一条。',
        });
        continue;
      }

      const items = r.items || [];
      if (items.length) {
        riskyCount += 1;
        for (const it of items) typeCounts[it.type] = (typeCounts[it.type] || 0) + 1;
      }
      if ((r.maxLevel || 0) > globalMaxLevel) globalMaxLevel = r.maxLevel || 0;

      results.push({
        index: i,
        id,
        success: true,
        skipped: false,
        maxLevel: r.maxLevel,
        levelName: r.levelName,
        summary: r.summary,
        hasSensitive: Boolean(r.hasSensitive),
        items,
        advice: r.advice,
        source: r.source,
        warnings: r.warnings || [],
      });
    } catch (e) {
      logger.error(`[analyze/batch] 第 ${i} 条失败:`, e && e.message);
      const c = errors.classify(e);
      results.push({
        index: i,
        id,
        success: false,
        skipped: false,
        items: [],
        maxLevel: 0,
        levelName: LEVEL_NAME[0],
        summary: '检测失败',
        code: c.code,
        title: c.title,
        message: c.message,
        action: c.action,
      });
    }
  }

  return res.json({
    success: true,
    kind: 'batch',
    mode: useAi ? 'full' : 'local',
    total: list.length,
    scanned: results.filter((r) => !r.skipped).length,
    riskyCount,
    maxLevel: globalMaxLevel,
    levelName: LEVEL_NAME[globalMaxLevel] || LEVEL_NAME[0],
    typeCounts,
    results,
    meta: { elapsedMs: Date.now() - started },
  });
});

module.exports = router;
