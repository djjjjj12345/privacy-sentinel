/**
 * privacy-sentinel SDK —— 敏感信息检测与脱敏
 * ---------------------------------------------------------------
 * 定位：把隐私哨兵的「本地检测引擎」做成第三方可直接接入的库。
 *
 * 三条硬约束（改代码时别破坏）：
 *   1. **零依赖**：只依赖 sdk/src/engine/ 下的三个引擎文件，不联网、不发请求。
 *      所以它可以塞进浏览器扩展、Electron、小程序 WebView、CI 脚本里跑。
 *   2. **默认不回显原文**：返回的 item 只给 type/label/level/start/end/masked，
 *      不给 raw。调用方本来就有原文，按 start/end 自己切片即可；
 *      需要 raw 时必须显式传 { includeRaw: true }。
 *      理由：SDK 常被用来「把检测结果打到日志/上报到后台」，默认不给原文
 *      可以避免调用方在不知情的情况下把敏感信息又存了一份。
 *   3. **规则单源**：引擎由 scripts/build-sdk.js 从 services/ 复制，
 *      测试会校验哈希。改规则请改 services/，不要在 sdk/ 里另写一份。
 *
 * 用法（Node）：
 *   const PS = require('privacy-sentinel');
 *   PS.detect('手机号13800138000');      // → [{ type:'phone', masked:'138****8000', ... }]
 *   PS.mask('手机号13800138000');        // → '手机号138****8000'
 *
 * 用法（浏览器）：
 *   <script src="privacy-sentinel.js"></script>
 *   PrivacySentinel.mask(text)
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./engine/schema.js'),
      require('./engine/localDetector.js'),
      require('./engine/guardCore.js')
    );
  } else if (root) {
    root.PrivacySentinel = factory(root.PSSchema, root.PSLocal, root.PSGuardCore);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SCHEMA, LOCAL, GUARD) {
  'use strict';

  const VERSION = '1.0.0';

  const STRATEGIES = ['mask', 'label', 'remove'];

  /** 条目字段白名单：默认不给 raw，避免 SDK 变成第二个泄露源 */
  const PUBLIC_FIELDS = ['type', 'label', 'level', 'levelName', 'start', 'end', 'masked', 'verified', 'reason', 'engine'];

  function assertEngine() {
    if (!LOCAL || typeof LOCAL.detect !== 'function' || !SCHEMA || typeof SCHEMA.TYPE_LABEL !== 'object') {
      throw new Error(
        'privacy-sentinel：引擎未正确加载。'
        + 'Node 环境请确认 sdk/src/engine/ 下有 schema.js / localDetector.js / guardCore.js；'
        + '浏览器环境请确认隐私哨兵脚本已加载完成。'
      );
    }
  }

  function normText(text) {
    if (typeof text !== 'string') {
      throw new TypeError('privacy-sentinel：输入必须是字符串，收到 ' + Object.prototype.toString.call(text));
    }
    return text;
  }

  function normOpts(opts) {
    const o = opts || {};
    const types = Array.isArray(o.types) && o.types.length ? o.types.slice() : null;
    return {
      types: types,
      minLevel: Number(o.minLevel) > 0 ? Number(o.minLevel) : 1,
      strategy: STRATEGIES.indexOf(o.strategy) >= 0 ? o.strategy : 'mask',
      includeRaw: o.includeRaw === true,
      includeReason: o.includeReason !== false,   // 默认给排查依据
    };
  }

  /** 只保留对外承诺的字段；raw 需显式开启 */
  function toPublic(item, o) {
    const level = Number(item.level) || 1;
    const out = {
      type: item.type,
      label: item.label || (SCHEMA.TYPE_LABEL && SCHEMA.TYPE_LABEL[item.type]) || item.type,
      level: level,
      levelName: SCHEMA.LEVEL_NAME ? SCHEMA.LEVEL_NAME[level] : '',
      start: Number(item.start),
      end: Number(item.end),
      masked: item.masked != null ? item.masked : '',
      verified: item.verified !== false,
      engine: item.engine || 'local',
    };
    if (o.includeReason) out.reason = item.reason || '';
    if (o.includeRaw) out.raw = item.raw;
    return out;
  }

  /**
   * 检测文本中的敏感信息。
   * @param {string} text
   * @param {object} [opts] types(类型白名单) / minLevel(等级阈值) / includeRaw / includeReason
   * @returns {Array<object>} 命中项，按等级从高到低排序
   */
  function detect(text, opts) {
    assertEngine();
    const src = normText(text);
    const o = normOpts(opts);
    if (!src) return [];

    let items = LOCAL.detect(src) || [];
    if (o.types) items = items.filter((i) => o.types.indexOf(i.type) >= 0);
    if (GUARD && typeof GUARD.pickItems === 'function') items = GUARD.pickItems(items, o.minLevel);
    return items.map((i) => toPublic(i, o));
  }

  /**
   * 检测并给出可直接展示的摘要。
   * @returns {{items:Array, count:number, level:number, levelName:string, summary:string, elapsedMs:number}}
   */
  function analyze(text, opts) {
    const startedAt = Date.now();
    const items = detect(text, opts);
    const level = SCHEMA.maxLevelOf ? SCHEMA.maxLevelOf(items) : 0;
    return {
      items: items,
      count: items.length,
      level: level,
      levelName: SCHEMA.LEVEL_NAME ? SCHEMA.LEVEL_NAME[level] || '' : '',
      summary: SCHEMA.summarize ? SCHEMA.summarize(items) : (items.length ? '检测到敏感信息' : '未检测到敏感信息'),
      elapsedMs: Date.now() - startedAt,
    };
  }

  /**
   * 把命中的区间替换成脱敏值，返回处理后的整段文本。
   * 注意：这是按 start/end 区间重建，不是简单字符串替换，
   * 所以「两处相同的手机号」不会被误替换、也不会漏替换。
   */
  function mask(text, opts) {
    assertEngine();
    const src = normText(text);
    const o = normOpts(opts);
    if (!src) return '';
    const items = LOCAL.detect(src) || [];
    const picked = typeFilter(items, o);
    if (!GUARD || typeof GUARD.buildMaskedText !== 'function') {
      throw new Error('privacy-sentinel：guardCore 未加载，无法生成脱敏文本');
    }
    return GUARD.buildMaskedText(src, picked, o.strategy);
  }

  function typeFilter(items, o) {
    let out = items;
    if (o.types) out = out.filter((i) => o.types.indexOf(i.type) >= 0);
    if (GUARD && typeof GUARD.pickItems === 'function') out = GUARD.pickItems(out, o.minLevel);
    return out;
  }

  /**
   * 一次调用同时拿到检测结果与脱敏文本（最常用的组合）。
   * @returns {{items:Array, count:number, level:number, levelName:string, summary:string, masked:string, elapsedMs:number}}
   */
  function analyzeAndMask(text, opts) {
    const startedAt = Date.now();
    const res = analyze(text, opts);
    res.masked = mask(text, opts);
    res.elapsedMs = Date.now() - startedAt;
    return res;
  }

  /**
   * 批量检测。返回与输入等长、同序的结果数组，便于调用方 zip 回原数据。
   * 单条抛错不会中断整批：该项记为 { error }，其余照常返回。
   */
  function detectBatch(list, opts) {
    if (!Array.isArray(list)) {
      throw new TypeError('privacy-sentinel：detectBatch 需要一个字符串数组');
    }
    return list.map((t) => {
      try {
        return { ok: true, result: analyzeAndMask(t, opts) };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    });
  }

  /** 单个值的脱敏（调用方已经知道类型时用，例如拿到一个手机号字段） */
  function desensitize(value, type, strategy) {
    assertEngine();
    if (value == null) return '';
    const s = STRATEGIES.indexOf(strategy) >= 0 ? strategy : 'mask';
    if (GUARD && typeof GUARD.maskOf === 'function') {
      // label 必须一起传：label 策略要替换成「[手机号]」而不是「[phone]」
      const label = (SCHEMA.TYPE_LABEL && SCHEMA.TYPE_LABEL[type]) || type;
      return GUARD.maskOf(
        { type: type, label: label, raw: String(value), masked: LOCAL.desensitize(String(value), type) },
        s
      );
    }
    return LOCAL.desensitize(String(value), type);
  }

  /** 支持的类型枚举（type → 中文名） */
  function types() {
    assertEngine();
    return Object.assign({}, SCHEMA.TYPE_LABEL);
  }

  /** 等级枚举（level → 中文名） */
  function levels() {
    assertEngine();
    return Object.assign({}, SCHEMA.LEVEL_NAME);
  }

  const API = {
    version: VERSION,
    detect: detect,
    analyze: analyze,
    mask: mask,
    analyzeAndMask: analyzeAndMask,
    detectBatch: detectBatch,
    desensitize: desensitize,
    types: types,
    levels: levels,
    strategies: STRATEGIES.slice(),
    /** 给高级用法：需要位置映射、抗变形归一化时直接拿引擎 */
    engine: { schema: SCHEMA, local: LOCAL, guard: GUARD },
  };

  return API;
});
