/*!
 * privacy-sentinel v1.0.0 · ESM 版
 * 用法：import PrivacySentinel, { detect, mask } from "./privacy-sentinel.esm.mjs"
 * 由 scripts/build-sdk.js 生成，请勿手改。
 */

/**
 * 统一数据契约层
 * ---------------------------------------------------------------
 * 前端、正则引擎、视觉模型三方共用同一份类型枚举与等级标准。
 * 任何一端新增类型，只需改这一个文件。
 *
 * 注意：整体包在 IIFE 里。浏览器直接加载本文件时，顶层 const 会进入全局词法作用域，
 * 与页面内联脚本的同名声明（如 TYPE_LABEL）冲突并导致整个脚本解析失败。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.PSSchema = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

// 敏感信息类型枚举：key 同时作为前端 desensitize() 的分支标识
const TYPE_LABEL = {
  id: '身份证号',
  bankcard: '银行卡号',
  phone: '手机号',
  password: '密码',
  otp: '短信验证码',
  address: '家庭住址',
  name: '姓名',
  email: '电子邮箱',
  url: '链接地址',
  passport: '护照号',
  uscc: '统一社会信用代码',
  ip: 'IP 地址',
  mac: 'MAC 地址',
  apikey: 'API 密钥',
  other: '其他敏感信息',
};

const TYPE_KEYS = Object.keys(TYPE_LABEL);

// 各类型的风险基准等级（下限）。模型可结合上下文上调，但不能下调到这个值以下。
const TYPE_FLOOR = {
  otp: 4,
  password: 3,
  bankcard: 2,
  id: 1,
  phone: 1,
  address: 1,
  name: 1,
  email: 1,
  url: 1,
  passport: 1,
  uscc: 2,
  ip: 1,
  mac: 1,
  // 密钥泄露可导致账号被接管、产生资损，与密码同级
  apikey: 3,
  other: 1,
};

const LEVEL_NAME = {
  0: '无风险',
  1: 'L1 · 低风险',
  2: 'L2 · 中风险',
  3: 'L3 · 高风险',
  4: 'L4 · 极高风险',
};

// 非图片输入时不应出现 bbox
const LEVEL_MIN = 1;
const LEVEL_MAX = 4;

function clampLevel(value, type) {
  const floor = TYPE_FLOOR[type] || 1;
  let n = Number(value);
  if (!Number.isFinite(n)) n = floor;
  n = Math.round(n);
  if (n < LEVEL_MIN) n = LEVEL_MIN;
  if (n > LEVEL_MAX) n = LEVEL_MAX;
  return Math.max(n, floor);
}

/**
 * 脱敏规则。与服务端、前端保持完全一致，避免出现两套结果。
 */
function desensitize(value, type) {
  const v = String(value == null ? '' : value);
  if (!v) return v;

  switch (type) {
    case 'id':
      if (v.length >= 18) return v.slice(0, 6) + '********' + v.slice(-4);
      if (v.length > 10) return v.slice(0, 6) + '****' + v.slice(-4);
      return v.slice(0, 2) + '****';
    case 'bankcard':
      if (v.length <= 8) return v.slice(0, 2) + '****' + v.slice(-2);
      return v.slice(0, 4) + ' **** **** ' + v.slice(-4);
    case 'phone':
      if (v.length < 8) return v.slice(0, 2) + '****';
      return v.slice(0, 3) + '****' + v.slice(-4);
    case 'password':
      return '******';
    case 'otp':
      return '****';
    case 'address':
      if (v.length > 6) return v.slice(0, 3) + '***' + v.slice(-3);
      return v.slice(0, 2) + '***';
    case 'name':
      // 保留姓氏，其余打码
      if (v.length <= 1) return v;
      if (v.length === 2) return v.slice(0, 1) + '*';
      return v.slice(0, 1) + '*'.repeat(Math.min(v.length - 1, 2));
    case 'email':
      // 保留首字符 + @ 之后的首字符，其余打码
      const at = v.indexOf('@');
      if (at < 1) return '***@***';
      const domain = at === -1 ? '' : v.slice(at);
      const local = v.slice(0, at);
      if (local.length <= 1) return local + '***' + domain;
      return local[0] + '***' + domain;
    case 'url':
      // 隐藏 query 中的 token/secret，保留域名
      try {
        const u = new URL(v);
        let query = u.search;
        if (query) {
          query = query.replace(/([?&])(token|access_token|password|pwd|secret|api_key|apikey|sid|signature|sig|code)=([^&]*)/gi,
            (_, pre, key) => `${pre}${key}=***`);
        }
        return u.host + u.pathname + query + u.hash;
      } catch (_) {
        return v.length <= 8 ? '***' : v.slice(0, 6) + '***' + v.slice(-4);
      }
    case 'passport':
      // 中国护照 E/G/D + 8 位：保留首字母 + 末 2 位
      if (v.length < 4) return '***';
      return v[0] + '*'.repeat(Math.max(1, v.length - 3)) + v.slice(-2);
    case 'uscc':
      // 18 位统一社会信用代码：保留前 6 位（登记部门）+ 后 4 位
      if (v.length < 18) return '***';
      return v.slice(0, 6) + '**********' + v.slice(-2);
    case 'ip':
      // IPv4 保留前两段；IPv6 保留前两段
      if (v.includes(':')) {
        const parts = v.split(':');
        return (parts[0] || '****') + ':' + (parts[1] || '****') + ':****:****:****:****:****:****';
      }
      const segs = v.split('.');
      if (segs.length !== 4) return '***';
      return segs[0] + '.' + segs[1] + '.*.*';
    case 'mac':
      // MAC 保留前 3 段（厂商 OUI），隐藏设备 ID
      const macSegs = v.split(/[:\-]/);
      if (macSegs.length === 6) return macSegs[0] + ':' + macSegs[1] + ':' + macSegs[2] + ':**:**:**';
      return '**:**:**:**:**:**';
    case 'apikey':
      // 只保留前缀（用于判断是哪家的密钥），其余全部打码
      // 例：sk-abcdef123456 -> sk-****3456
      const sepIdx = v.search(/[-_]/);
      if (sepIdx > 0 && sepIdx < 12) return v.slice(0, sepIdx + 1) + '****' + v.slice(-4);
      if (v.length <= 8) return '****';
      return v.slice(0, 2) + '****' + v.slice(-4);
    default:
      if (v.length <= 4) return '****';
      return v.slice(0, 2) + '***' + v.slice(-2);
  }
}

/**
 * bbox 归一化：允许模型返回 0-1 或 0-1000 两种刻度，统一收敛到 0-1。
 * 返回 null 表示该条目无法定位。
 */
function normalizeBBox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  let nums = bbox.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;

  const maxAbs = Math.max(...nums.map(Math.abs));
  if (maxAbs > 1.5) {
    const scale = maxAbs > 100 ? 1000 : 100;
    nums = nums.map((n) => n / scale);
  }

  let [x, y, w, h] = nums;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }

  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  x = clamp01(x); y = clamp01(y);
  w = clamp01(w); h = clamp01(h);
  if (w < 0.005 || h < 0.005) return null;

  return [x, y, w, h];
}

/**
 * 把任意来源（模型 / 正则）的条目标准化为统一结构。
 * @param {object} raw 原始条目
 * @param {string} engine 'ai' | 'local'
 */
function normalizeItem(raw, engine = 'ai') {
  if (!raw || typeof raw !== 'object') return null;

  let type = String(raw.type || '').trim().toLowerCase();
  // 兼容模型可能吐出的同义写法
  const ALIAS = {
    idcard: 'id', id_card: 'id', identity: 'id', 身份证: 'id', 身份证号: 'id',
    bank_card: 'bankcard', bank: 'bankcard', card: 'bankcard', 银行卡: 'bankcard',
    mobile: 'phone', tel: 'phone', 手机: 'phone', 手机号: 'phone',
    pwd: 'password', passwd: 'password', 密码: 'password',
    code: 'otp', sms_code: 'otp', verify_code: 'otp', 验证码: 'otp', 短信验证码: 'otp',
    addr: 'address', 住址: 'address', 地址: 'address',
    username: 'name', 姓名: 'name',
    email_address: 'email', mail: 'email', 邮箱: 'email', 'e-mail': 'email',
    link: 'url', website: 'url', 链接: 'url', 网址: 'url', url_address: 'url',
    passport_id: 'passport', passport_no: 'passport', passport_number: 'passport', 护照: 'passport', 护照号: 'passport',
    credit_code: 'uscc', 'uscc': 'uscc', 信用代码: 'uscc', '社会信用代码': 'uscc',
    ipv4: 'ip', ipv6: 'ip', 'ip_address': 'ip', 'ip地址': 'ip',
    mac_address: 'mac', 'macaddr': 'mac', 'mac地址': 'mac',
  };
  if (ALIAS[type]) type = ALIAS[type];
  if (!TYPE_KEYS.includes(type)) type = 'other';

  // 模型偶尔会用 value/text/content 等字段名承载敏感内容，按优先级取第一个非空字符串
  const pickStr = (...vals) => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return '';
  };
  const value = pickStr(raw.raw, raw.value, raw.text, raw.content).trim();
  if (!value) return null;

  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) confidence = engine === 'local' ? 1 : 0.8;
  confidence = Math.min(1, Math.max(0, confidence));

  return {
    type,
    label: TYPE_LABEL[type],
    raw: value,
    masked: desensitize(value, type),
    level: clampLevel(raw.level, type),
    confidence,
    // true=校验位通过；false=格式像但校验位不符；null=模型给出、无校验依据
    verified: typeof raw.verified === 'boolean' ? raw.verified : null,
    reason: String(raw.reason || (engine === 'local' ? '匹配到固定格式规则' : '')).slice(0, 200),
    bbox: normalizeBBox(raw.bbox),
    // 原文中的字符区间（仅本地规则命中时有值，模型条目无从得知）；
    // 前端用它做脱敏导出与高亮定位，避免二次搜索导致重复值错位
    start: Number.isInteger(raw.start) ? raw.start : null,
    end: Number.isInteger(raw.end) ? raw.end : null,
    engine,
  };
}

/**
 * 按 raw 值去重，保留等级最高、信息最全的一条。
 * 同时做「本地正则命中但模型漏检」的补漏。
 */
function fuseItems(localItems = [], aiItems = []) {
  const pickBetter = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    // 等级优先，其次优先保留模型给出的 reason / bbox
    if (b.level !== a.level) return b.level > a.level ? b : a;
    const aRich = (a.reason ? 1 : 0) + (a.bbox ? 1 : 0);
    const bRich = (b.reason ? 1 : 0) + (b.bbox ? 1 : 0);
    if (bRich !== aRich) return bRich > aRich ? b : a;
    return a;
  };

  const map = new Map();
  const norm = (v) => String(v).replace(/\s|-/g, '').toLowerCase();

  // 记录哪些值是「校验位通过」的，融合后统一标记，避免标记在合并时丢失
  const verifiedValues = new Set();
  for (const item of localItems) {
    if (item.verified === true) verifiedValues.add(norm(item.raw));
  }

  for (const item of localItems) {
    map.set(norm(item.raw), pickBetter(map.get(norm(item.raw)), item));
  }
  for (const item of aiItems) {
    map.set(norm(item.raw), pickBetter(map.get(norm(item.raw)), item));
  }

  const items = Array.from(map.values());
  for (const item of items) {
    if (verifiedValues.has(norm(item.raw))) item.verified = true;
  }

  items.sort((a, b) => b.level - a.level || b.confidence - a.confidence);
  return items;
}

function maxLevelOf(items) {
  return items.reduce((max, i) => Math.max(max, i.level), 0);
}

function summarize(items) {
  if (!items.length) return '未检测到敏感信息';
  const counter = new Map();
  for (const item of items) {
    counter.set(item.label, (counter.get(item.label) || 0) + 1);
  }
  const parts = Array.from(counter.entries()).map(
    ([label, n]) => (n > 1 ? `${label} ${n} 处` : label)
  );
  return `检测到 ${parts.join('、')}`;
}

/**
 * 系统提示词。json_object 模式下不像 json_schema 那样有硬约束，
 * 因此把结构与取值约束全部写进提示词，并在服务端做二次校验。
 */
function buildSystemPrompt(profile = {}) {
  const agePart = profile.age ? `用户年龄段：${profile.age}。` : '';
  const litPart = profile.literacy ? `用户网络安全水平：${profile.literacy}。` : '';
  const sensPart =
    profile.sensitivity === 'high'
      ? '当前为高灵敏度策略：宁可多报，不要漏报。'
      : profile.sensitivity === 'low'
      ? '当前为低灵敏度策略：只报等级 3 及以上的严重风险。'
      : '';

  return [
    '你是「隐私哨兵」的敏感信息识别引擎，运行在即时通讯场景中，',
    '职责是在用户把一条消息发出去之前，判断其中是否包含敏感信息并评估风险。',
    '',
    '你只能输出一个 JSON 对象。不要输出解释、前后缀、Markdown 代码块或任何其他字符。',
    '',
    'JSON 结构：',
    '{',
    '  "hasSensitive": true | false,',
    '  "maxLevel": 0 | 1 | 2 | 3 | 4,',
    '  "summary": "一句话概述发现了什么",',
    '  "transcript": "语音转写文本，无语音时填 null",',
    '  "items": [',
    '    {',
    '      "type": "id | bankcard | phone | password | otp | address | name | email | url | passport | uscc | ip | mac | other",',
    '      "raw": "原样照抄的敏感内容",',
    '      "level": 1 | 2 | 3 | 4,',
    '      "confidence": 0.0 - 1.0,',
    '      "reason": "一句话说明为什么危险，要具体",',
    '      "bbox": [x, y, width, height] 或 null',
    '    }',
    '  ],',
    '  "advice": "给用户的一句可执行建议"',
    '}',
    '',
    '字段约束：',
    '1. raw 必须逐字符照抄输入中的原文，不要改写、补全、翻译或推测。图片模糊无法确认时不要猜。',
    '2. level 判定标准：1=低（手机号、住址、姓名），2=中（银行卡号、账号），',
    '   3=高（登录密码、账号口令），4=极高（短信验证码、支付验证码）。',
    '   可结合上下文上调：当对方在实施诈骗、索要信息、催促转账或冒充熟人时，等级加一。',
    '   不要把普通数字误判为敏感信息，例如金额、日期、订单号、快递单号、楼层门牌号。',
    '3. bbox 仅在输入为图片、且你能大致定位该信息在图中的位置时给出，',
    '   格式为归一化坐标 [x, y, width, height]，取值 0 到 1，左上角为原点。无法定位时填 null。',
    '4. 没有发现敏感信息时，items 返回空数组，maxLevel 返回 0，hasSensitive 返回 false。',
    '5. 同一段内容只输出一条，不要重复。',
    '6. 除 JSON 之外不要输出任何字符，不要在 JSON 前后加说明文字。',
    '',
    agePart + litPart + sensPart,
  ].join('\n');
}

// 双端导出：Node 走 module.exports，浏览器挂到 window.PSSchema。
// 这样浏览器本地检测模式与后端共用同一份类型枚举/脱敏规则，不会出现两套标准。
const SCHEMA_API = {
  TYPE_LABEL,
  TYPE_KEYS,
  TYPE_FLOOR,
  LEVEL_NAME,
  clampLevel,
  desensitize,
  normalizeBBox,
  normalizeItem,
  fuseItems,
  maxLevelOf,
  summarize,
  buildSystemPrompt,
};

// 双端导出：Node 走 module.exports，浏览器挂到 window.PSSchema（见文件顶部 IIFE）
return SCHEMA_API;
});

/**
 * 本地正则检测引擎
 * ---------------------------------------------------------------
 * 定位：低成本、高精度的「确定性兜底」。
 * 它与视觉模型不是替代关系，而是互补：
 *   - 正则擅长格式固定的号码，且能保证 raw 逐字符正确、不产生幻觉；
 *   - 模型擅长语义风险，例如姓名、话术、场景判断。
 *
 * 相比旧实现修复的三个真实缺陷：
 *   1. 旧代码中 \d{17}[\dXx]（身份证）与 \d{16,19}（银行卡）会同时命中同一个号码，
 *      同一串数字被报成两类敏感信息。现在改为「区间匹配 + 冲突消解」。
 *   2. 旧代码不校验日期与校验位，任意 18 位数字都被当成身份证，
 *      例如订单号 202503190000000123 也会被报成身份证。
 *   3. 新增「分级置信」：校验位通过的标 verified，不通过的仍会上报但标注存疑，
 *      避免把测试号码、录入错误一律静默丢弃（那会造成漏报）。
 */

// 双端加载：Node 下 require，浏览器下从 window.PSSchema 取（本地离线模式复用同一套规则）。
// 同样包 IIFE：避免顶层的 const（TYPE_LABEL 等）污染页面全局词法作用域。
(function (root, factory) {
  const schema = typeof module !== 'undefined' && module.exports
    ? require('./schema')
    : (root ? root.PSSchema : null);
  const api = factory(schema);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.PSLocal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SCHEMA) {
  'use strict';

  const { normalizeItem, desensitize, TYPE_LABEL } = SCHEMA || {};


// 零宽字符：复制粘贴、网页排版常带，肉眼不可见，但会把「13800138000」拆成不连续字符
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u2060]/;

/**
 * 归一化文本，同时保留「归一化位置 → 原文位置」的映射。
 *
 * 处理三类常见的绕过手法：
 *   1. 零宽字符插入：13​800138000
 *   2. 全角字符：１３８００１３８０００
 *   3. 数字间的空格、连字符、下划线：138 0013-8000
 *
 * 只折叠「数字与数字之间」的分隔符——否则 "hello world" 会被粘成 "helloworld"，
 * 破坏「密码 是 xxx」这类上下文规则。
 *
 * @returns {{text: string, map: number[]}} map[i] 是归一化后第 i 个字符在原文中的下标
 */
function normalizeForScan(text) {
  const chars = [];
  const map = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ZERO_WIDTH_RE.test(ch)) continue; // 直接丢弃，不占用归一化位置
    let c = ch;
    const code = ch.charCodeAt(0);
    if (code >= 0xff01 && code <= 0xff5e) c = String.fromCharCode(code - 0xfee0); // 全角→半角
    else if (ch === '\u3000') c = ' ';
    chars.push(c);
    map.push(i);
  }

  // 点号留给 IP、域名等规则。号码分组的点号由独立的候选规则处理。
  const SEP = /[ \-_]/;
  const out = [];
  const outMap = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (SEP.test(c)) {
      const prev = out.length ? out[out.length - 1] : '';
      let j = i + 1;
      while (j < chars.length && SEP.test(chars[j])) j++;
      const next = chars[j] || '';
      if (/[0-9]/.test(prev) && /[0-9]/.test(next)) continue; // 数字间分隔符折叠
    }
    out.push(c);
    outMap.push(map[i]);
  }

  return { text: out.join(''), map: outMap };
}


function isRealDate(y, m, d) {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 身份证候选判定。
 * @returns {'valid'|'weak'|null}
 *   valid 校验位正确；weak 格式像但校验位不符；null 不可能是身份证
 */
function checkIdCard(value) {
  const v = String(value).toUpperCase();

  if (/^\d{15}$/.test(v)) {
    // 1985 版老号没有校验位，最多只能给到 weak
    const y = Number('19' + v.slice(6, 8));
    const m = Number(v.slice(8, 10));
    const d = Number(v.slice(10, 12));
    return isRealDate(y, m, d) ? 'weak' : null;
  }

  if (!/^\d{17}[\dX]$/.test(v)) return null;

  // 中间 8 位必须是真实日期，这一步能过滤掉绝大多数随机长数字
  const y = Number(v.slice(6, 10));
  const m = Number(v.slice(10, 12));
  const d = Number(v.slice(12, 14));
  if (!isRealDate(y, m, d)) return null;

  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(v[i]) * weights[i];

  return checkCodes[sum % 11] === v[17] ? 'valid' : 'weak';
}

/** Luhn 校验 */
function isLuhnValid(value) {
  const v = String(value).replace(/\D/g, '');
  if (v.length < 12 || v.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = v.length - 1; i >= 0; i--) {
    let d = Number(v[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * 银行卡候选判定。
 * 真实卡号首位只有 3/4/5/6 四个发卡组织标识，先做这一步筛选能砍掉大量噪声。
 * @returns {'valid'|'weak'|null}
 */
function checkBankCard(value) {
  const v = String(value);
  if (!/^\d{16,19}$/.test(v)) return null;
  if (!/^[3-6]/.test(v)) return null;
  return isLuhnValid(v) ? 'valid' : 'weak';
}

/** 日期/时间/金额等常见误报场景 */
function looksLikeNonSensitive(value) {
  if (/^(19|20)\d{6}$/.test(value)) return true;
  if (/^(19|20)\d{6}\d{6}$/.test(value)) return true;
  if (/^(\d)\1+$/.test(value)) return true;
  return false;
}

/** 收集所有候选命中，保留字符区间用于冲突消解 */
function collectMatches(text) {
  const raw = [];

  const push = (type, value, start, end, verified) => {
    if (!value) return;
    if (looksLikeNonSensitive(value)) return;
    raw.push({ type, value, start, end, verified });
  };

  // ---- 身份证号 ----
  const idRe = /(?<!\d)(\d{17}[\dXx]|\d{15})(?!\d)/g;
  for (const m of text.matchAll(idRe)) {
    const verdict = checkIdCard(m[1]);
    if (!verdict) continue;
    push('id', m[1], m.index, m.index + m[1].length, verdict === 'valid');
  }

  // ---- 银行卡号 ----
  const cardRe = /(?<!\d)(\d{16,19})(?!\d)/g;
  for (const m of text.matchAll(cardRe)) {
    const verdict = checkBankCard(m[1]);
    if (!verdict) continue;
    push('bankcard', m[1], m.index, m.index + m[1].length, verdict === 'valid');
  }

  // ---- 手机号 ----
  const phoneRe = /(?<!\d)(1[3-9]\d{9})(?!\d)/g;
  for (const m of text.matchAll(phoneRe)) {
    push('phone', m[1], m.index, m.index + m[1].length, true);
  }

  // 中文口述数字和括号分组只在明确的手机语境中解析，避免拼接普通数字与编号。
  const phoneLabel = /(?:手机号(?:码)?|联系电话|电话号码)\s*(?:是|为|写成了?)?\s*:?\s*/;
  const groupedPhone = /1[3-9]\d *\( *\d{4} *\) *\d{4}(?!\d)/;
  const spokenPhone = /[一幺][三四五六七八九][零〇一幺二三四五六七八九]{9}(?![零〇一幺二三四五六七八九\d])/;
  const labeledPhoneRe = new RegExp(`${phoneLabel.source}(${groupedPhone.source}|${spokenPhone.source})`, 'g');
  const spokenDigits = { 零: '0', 〇: '0', 一: '1', 幺: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };
  for (const m of text.matchAll(labeledPhoneRe)) {
    const grouped = m[1];
    const start = m.index + m[0].lastIndexOf(grouped);
    const value = grouped.replace(/[ ()]/g, '').replace(/[零〇一幺二三四五六七八九]/g, (digit) => spokenDigits[digit]);
    push('phone', value, start, start + grouped.length, true);
  }

  // ---- 密码 ----
  const pwdRe = /(?:密码|口令|登录密码|支付密码|pwd|passwd|password)\s*(?:是|为|:|：|=)\s*([^\s，。；;、,]{4,32})/gi;
  for (const m of text.matchAll(pwdRe)) {
    const value = m[1];
    const start = m.index + m[0].lastIndexOf(value);
    push('password', value, start, start + value.length, true);
  }

  // ---- 短信验证码（前后两种语序）----
  const otpAfter = /(?:验证码|校验码|动态码|短信码|OTP)\s*(?:是|为|:|：|=)?\s*(\d{4,8})(?!\d)/gi;
  for (const m of text.matchAll(otpAfter)) {
    const value = m[1];
    const start = m.index + m[0].lastIndexOf(value);
    push('otp', value, start, start + value.length, true);
  }
  const otpBefore = /(?<!\d)(\d{4,8})(?!\d)\s*(?:是|为)?\s*(?:我?的)?\s*(?:验证码|校验码|动态码|短信码)/g;
  for (const m of text.matchAll(otpBefore)) {
    push('otp', m[1], m.index, m.index + m[1].length, true);
  }

  // ---- 姓名 ----
  // 脱离上下文的中文人名，和任意两字词语没有区别，硬猜必然误报一片。
  // 因此只在强自述语境下识别，并叠加三重约束：触发词 + 停用词表 + 尾部必须是标点或句末。
  const NAME_STOP_RE = /外卖|快递|客服|司机|师傅|人工|售后|维修|保洁|搬家|救护车|出租车|的|了|和|与|过|在|去|来|再|还|就|都/;
  // 尾部边界同样要认半角：归一化已把全角「，」转成了半角「,」
  const nameRe = /(?:我叫|本人叫|我的名字(?:叫|是)|姓名|联系人|收货人|投保人|持卡人|申请人|收件人)\s*(?:是|叫|为|:|：)?\s*([\u4e00-\u9fa5]{2,4})(?=[，,。；;、\s!！？?]|$)/g;
  for (const m of text.matchAll(nameRe)) {
    const value = m[1];
    if (NAME_STOP_RE.test(value)) continue;
    const start = m.index + m[0].lastIndexOf(value);
    push('name', value, start, start + value.length, true);
  }

  // ---- 家庭住址 ----
  // 「路/街/巷」这类道路通名必须跟上门牌数字才算住址：只说「公司在建国路」是位置描述，
  // 不是家庭住址，报了就是噪音；而「小区/花园/公寓/大厦」这类居住区名本身即可成立。
  const addressRe = /(?:北京|上海|天津|重庆|广州|深圳|杭州|成都|武汉|南京|西安|长沙|青岛|郑州|大连|东莞|宁波|厦门|合肥|福州|昆明|沈阳|济南|无锡|苏州|南昌|南宁|长春|哈尔滨|太原|石家庄|兰州|海口|贵阳|乌鲁木齐|呼和浩特|银川|西宁|拉萨)(?:市|区|县|州|盟)?[^\s，。；;、,]{0,20}?(?:(?:路|街|大道|大街|巷|弄|胡同)\d+(?:\s*(?:号|栋|幢|单元|楼|层|室))?|(?:号院|小区|花园|公寓|大厦|广场|苑|村))[^\s，。；;、,]{0,10}/g;
  for (const m of text.matchAll(addressRe)) {
    const value = m[0].trim();
    if (value.length < 5) continue;
    push('address', value, m.index, m.index + m[0].length, true);
  }

  // ---- 邮箱 ----
  const emailRe = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
  for (const m of text.matchAll(emailRe)) {
    push('email', m[0], m.index, m.index + m[0].length, true);
  }

  // ---- URL（含查询参数、fragment）----
  // 两层约束：
  //  1. 终止字符集必须同时列出全角与半角标点：归一化会把全角「，」(U+FF0C) 转成半角「,」，
  //     若这里只写全角，链接会一路吃到句尾，把「，半小时后失效」整段中文吞进 URL，
  //     导出「删除」策略时用户的正文会被连带删掉。
  //  2. 只有带敏感查询参数的链接才算敏感信息：给同事发一条官网链接是正常行为，
  //     一律报警只会让用户把提醒条当成噪音关掉。
  // 半角 `?` 绝不能进终止字符集——它是 query 的起始符，挡掉它就看不到 ?token= 了
  const urlRe = /\b(?:https?:\/\/|www\.)[\w-]+(?:\.[\w-]+)+(?:[\/?#][^\s，。；;、，,;！!？（）()「」『』《》<>【】"']*)?/gi;
  const SENSITIVE_QUERY_RE = /[?&](?:token|access[_-]?token|refresh[_-]?token|key|api[_-]?key|secret|password|passwd|pwd|auth|session|sid|sig|signature|code|otp|invite|reset|verify)=/i;
  for (const m of text.matchAll(urlRe)) {
    if (!SENSITIVE_QUERY_RE.test(m[0])) continue;
    push('url', m[0], m.index, m.index + m[0].length, true);
  }

  // ---- 护照（中国 E/G/D 系列，8 位数字；新旧版均可）----
  // 仅在出现「护照」上下文时识别，避免误伤 9 位产品序列号；前后不允许是数字
  const passportRe = /(?:护照|护照号|passport|护照号码)\s*[:：是为]?\s*([EGegD]\d{7,8})\b/g;
  for (const m of text.matchAll(passportRe)) {
    const value = m[1].toUpperCase();
    const start = m.index + m[0].lastIndexOf(value);
    push('passport', value, start, start + value.length, true);
  }

  // ---- 统一社会信用代码（GB 32100-2015：18 位 = 登记管理部门1+机构类别1+登记管理机关行政区划码6+主体标识码（9 位组织机构代码）+校验位1）----
  // 仅在「信用代码」「营业执照」「统一社会信用代码」上下文中识别，避免误伤任意 18 位数字
  const usccRe = /(?:统一社会信用代码|信用代码|营业执照)\s*[:：是为号]?\s*([0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10})\b/g;
  for (const m of text.matchAll(usccRe)) {
    const value = m[1].toUpperCase();
    const start = m.index + m[0].lastIndexOf(value);
    // 校验 ISO 7064 MOD 31-3
    if (verifyUsccChecksum(value)) {
      push('uscc', value, start, start + value.length, true);
    } else {
      push('uscc', value, start, start + value.length, false);
    }
  }

  // ---- IPv4 ----
  // 前后都不能是字母或点：软件版本号 v1.2.3.4 长得和 IPv4 一模一样，
  // 只挡数字挡不住它，必须连「v」和点一起挡掉。
  const ipv4Re = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;
  for (const m of text.matchAll(ipv4Re)) {
    // 跳过 192-255.0-255.0-255.0-255 的极端小数字和 0/255 边界
    const segs = m[0].split('.').map(Number);
    if (segs.some((s) => s > 255)) continue;
    push('ip', m[0], m.index, m.index + m[0].length, true);
  }

  // ---- IPv6（仅 8 段冒号十六进制；太罕见，放在最后最低优先级）----
  const ipv6Re = /(?<![\w:])(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}(?![\w:])/g;
  for (const m of text.matchAll(ipv6Re)) {
    push('ip', m[0], m.index, m.index + m[0].length, true);
  }

  // ---- MAC 地址（AA:BB:CC:DD:EE:FF / AA-BB-CC-DD-EE-FF）----
  const macRe = /\b(?:[0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}\b/g;
  for (const m of text.matchAll(macRe)) {
    push('mac', m[0].toUpperCase(), m.index, m.index + m[0].length, true);
  }

  // ---- API 密钥 / 访问令牌 ----
  // 这类凭据一旦泄露，攻击者可以直接调用你的账号资源产生资损，
  // 因此与密码同级（L3）。规则按厂商前缀逐个匹配，前缀本身就是强证据，
  // 不需要额外上下文，避免「必须写『密钥』二字才识别」造成的漏报。
  const keyPatterns = [
    // OpenAI / 兼容接口
    /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
    // 阿里云 AccessKey
    /\b(LTAI[A-Za-z0-9]{12,})\b/g,
    // 腾讯云 SecretId
    /\b(AKID[A-Za-z0-9]{16,})\b/g,
    // 华为云 / AWS Access Key Id
    /\b((?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{12,})\b/g,
    // GitHub Personal Access Token / OAuth / Server token
    /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
    // GitLab
    /\b(glpat-[A-Za-z0-9_-]{16,})\b/g,
    // Slack
    /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
    // Google API Key
    /\b(AIza[A-Za-z0-9_-]{30,})\b/g,
    // Stripe
    /\b((?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g,
    // SendGrid / Mailgun / Twilio
    /\b(SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/g,
    /\b(AC[a-f0-9]{32})\b/g,
    // JWT（三段 Base64URL）
    /\b(ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    // PEM 私钥头
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  ];
  for (const re of keyPatterns) {
    for (const m of text.matchAll(re)) {
      push('apikey', m[1] || m[0], m.index, m.index + m[0].length, true);
    }
  }

  // 带上下文的通用密钥声明：AK/SK/token/密钥 是 xxx
  // 前缀规则覆盖不到的自研系统密钥，靠这条兜底
  const genericKeyRe =
    /(?:api[_\-]?key|apikey|access[_\-]?token|access[_\-]?key|secret[_\-]?key|secret|token|密钥|秘钥|令牌|私钥)\s*(?:是|为|:|：|=)\s*([A-Za-z0-9_\-]{16,})/gi;
  for (const m of text.matchAll(genericKeyRe)) {
    const value = m[1];
    // 排除纯数字（多半是订单号）与看起来像哈希但无前缀的短串
    if (/^\d+$/.test(value)) continue;
    const start = m.index + m[0].lastIndexOf(value);
    push('apikey', value, start, start + value.length, true);
  }

  return raw;
}

/** 统一社会信用代码校验位（ISO 7064 MOD 31-3） */
function verifyUsccChecksum(value) {
  const v = String(value).toUpperCase();
  if (v.length !== 18) return false;
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  const chars = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const idx = chars.indexOf(v[i]);
    if (idx < 0) return false;
    sum += idx * weights[i];
  }
  const checkIdx = (31 - (sum % 31)) % 31;
  return chars[checkIdx] === v[17];
}

/**
 * 冲突消解：同一段字符区间只保留一个类型。
 * 优先级按证据强度排序，同时让「校验通过的候选」优先占用区间。
 */
const TYPE_PRIORITY = {
  otp: 100,
  password: 95,
  apikey: 92,  // 前缀即强证据，优先级高于号码类
  uscc: 90,    // 校验位可信，证据强
  id: 90,
  bankcard: 80,
  phone: 70,
  email: 65,
  url: 65,
  ip: 60,
  mac: 60,
  passport: 55,
  address: 50,
  name: 45,
  other: 10,
};

function resolveOverlaps(matches) {
  const sorted = matches.slice().sort((a, b) => {
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    const pa = TYPE_PRIORITY[a.type] || 0;
    const pb = TYPE_PRIORITY[b.type] || 0;
    if (pa !== pb) return pb - pa;
    return (b.end - b.start) - (a.end - a.start);
  });

  const taken = [];
  const result = [];
  const overlaps = (s, e) => taken.some(([ts, te]) => s < te && e > ts);

  for (const m of sorted) {
    if (overlaps(m.start, m.end)) continue;
    taken.push([m.start, m.end]);
    result.push(m);
  }

  return result.sort((a, b) => a.start - b.start);
}

/** 在原有规则的结果之外，补查被排版字符拆开的完整号码。 */
function findSplitNumbers(text, existing) {
  const separator = /[ \t\u00A0\u2000-\u200A\u202F_\-\u2010-\u2015\u2212]/.source;
  const gap = `(?:${separator}{1,8}|${separator}{0,8}\\r?\\n${separator}{0,8}|\\.)`;
  const splitRe = new RegExp(`(?<![\\d.])\\d+(?:${gap}\\d+)+|(?<!\\d)\\d{17}${gap}[Xx](?!\\w)`, 'g');
  const idSuffix = new RegExp(`^(?:${gap})?[Xx](?!\\w)`);
  const matches = [];
  let previous = 0;

  for (const match of text.matchAll(splitRe)) {
    let grouped = match[0];
    const start = match.index;
    let value = grouped.replace(/[^\dXx]/g, '');
    if (value.length === 17) {
      const suffix = idSuffix.exec(text.slice(start + grouped.length));
      if (suffix) {
        grouped += suffix[0];
        value += suffix[0].slice(-1);
      }
    }
    const end = start + grouped.length;

    // 连续小数点、域名和版本号不能当成分组号码。
    const dotted = grouped.includes('.');
    if (dotted && (/[\w.]/.test(text[start - 1] || '') || /^\w|^\.[\w.]/.test(text.slice(end, end + 2)))) continue;

    // 原有规则已识别的字段优先，例如 IP、密码和敏感链接。
    while (previous < existing.length && existing[previous].end <= start) previous++;
    if (previous < existing.length && existing[previous].start < end) continue;

    if (/^1[3-9]\d{9}$/.test(value) && (!dotted || /^\d{3}\.\d{4}\.\d{4}$/.test(grouped))) {
      matches.push({ type: 'phone', value, start, end, verified: true });
      continue;
    }

    // 对点号分组要求明确的分组格式和校验通过，避免把数值列识别成证件或银行卡。
    const id = checkIdCard(value);
    if (id && (!dotted || (id === 'valid' && /^\d{6}\.\d{8}\.\d{3}[\dXx]$/.test(grouped)))) {
      matches.push({ type: 'id', value, start, end, verified: id === 'valid' });
      continue;
    }
    const card = checkBankCard(value);
    if (card && (!dotted || (card === 'valid' && /^\d{4}(?:\.\d{4}){3}$/.test(grouped)))) {
      matches.push({ type: 'bankcard', value, start, end, verified: card === 'valid' });
    }
  }
  return matches;
}

/**
 * 对文本执行本地检测。
 * @param {string} text
 * @returns {Array} 标准化后的条目数组
 */
function detect(text) {
  if (!text || typeof text !== 'string') return [];

  // 在归一化文本上匹配，再把命中区间映射回原文，保证脱敏/定位不串位
  const norm = normalizeForScan(text);
  const matches = resolveOverlaps(collectMatches(norm.text));
  matches.push(...findSplitNumbers(norm.text, matches));
  matches.sort((a, b) => a.start - b.start);

  return matches
    .map((m) => {
      const start = norm.map[m.start] !== undefined ? norm.map[m.start] : m.start;
      const lastIdx = norm.map[m.end - 1];
      const end = lastIdx !== undefined ? lastIdx + 1 : m.end;

      return normalizeItem(
        {
          type: m.type,
          raw: m.value,
          level: undefined,
          confidence: m.verified ? 1 : 0.6,
          verified: m.verified,
          start,
          end,
          reason: m.verified
            ? '匹配到固定格式规则，校验通过'
            : '格式匹配但校验位不符，可能是测试号码或录入错误，请人工确认',
        },
        'local'
      );
    })
    .filter(Boolean);
}

const LOCAL_API = {
  detect,
  normalizeForScan,
  checkIdCard,
  checkBankCard,
  isLuhnValid,
  verifyUsccChecksum,
  TYPE_LABEL,
  desensitize,
};

  return LOCAL_API;
});

/**
 * 输入守卫核心逻辑（与引擎一样走 UMD：Node 测试 / 浏览器扩展 / 网页版三处同源）
 * ---------------------------------------------------------------
 * 单独抽出来的原因：这部分是纯逻辑，必须能被单元测试直接调用。
 * content.js 只负责「绑定事件 + 画 UI」，规则与文本处理全部落在这里，
 * 网页版 guard.html 与浏览器扩展因此不可能走向两套行为。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.PSGuardCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // Node 环境下没有 window，行为相关函数会自动降级（测试只覆盖纯逻辑部分）
  const win = root && root.document ? root : null;

  const MAX_SCAN_CHARS = 20000;   // 超长文本跳过，避免在富文本编辑器里卡顿
  const DEBOUNCE_MS = 350;

  const LEVEL_STYLE = {
    1: { cls: 'lv1', title: '低危：公开后可能被关联' },
    2: { cls: 'lv2', title: '中危：可用于定向骚扰或社工' },
    3: { cls: 'lv3', title: '高危：可直接造成财产损失' },
    4: { cls: 'lv4', title: '极高危：一旦泄露几乎无法挽回' },
  };

  const DEFAULT_CONFIG = {
    enabled: true,
    minLevel: 1,
    strategy: 'mask',
    disabledHosts: [],
  };

  // 密码框里输入密码是正常行为，不该报警；隐藏域没有可见输入
  const SKIP_TYPES = ['password', 'hidden', 'file', 'checkbox', 'radio', 'button', 'submit'];

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') return !el.readOnly && !el.disabled;
    if (tag !== 'input') return false;
    const type = String(el.getAttribute && el.getAttribute('type') || 'text').toLowerCase();
    return SKIP_TYPES.indexOf(type) < 0 && !el.readOnly && !el.disabled;
  }

  function readValue(el) {
    if (!el) return '';
    return el.isContentEditable ? String(el.innerText || '') : String(el.value == null ? '' : el.value);
  }

  /**
   * 写回输入框并触发框架受控更新。
   * 直接赋值 el.value 对 React / Vue 无效：它们的受控组件监听的是 input 事件，
   * 且内部维护了自己的 value tracker，必须走原型上的原生 setter。
   */
  function writeValue(el, value) {
    if (!el) return;
    if (el.isContentEditable) {
      if (el.focus) el.focus();
      const sel = win && win.getSelection ? win.getSelection() : null;
      if (sel && win.document.createRange) {
        const range = win.document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        // insertText 会走浏览器的编辑管线，从而触发 React / Vue 的 onChange
        if (win.document.execCommand && win.document.execCommand('insertText', false, value)) return;
      }
      el.innerText = value;
      return;
    }
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    if (el.dispatchEvent && win && win.Event) {
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
  }

  function maskOf(item, strategy) {
    if (strategy === 'remove') return '';
    if (strategy === 'label') return '[' + (item.label || item.type || '隐私') + ']';
    // 只显示脱敏值：提醒条本身不能再泄露第二次
    if (item.masked) return item.masked;
    const raw = String(item.raw || '');
    const n = raw.length;
    if (n <= 2) return '*'.repeat(n);
    return raw.slice(0, 1) + '*'.repeat(n - 2) + raw.slice(-1);
  }

  /** 按 start/end 区间重建文本；必须从后往前替换，否则前面的下标会被长度变化带偏 */
  function buildMaskedText(text, items, strategy) {
    const src = String(text == null ? '' : text);
    const spans = (items || [])
      .filter((i) => Number(i.start) >= 0 && Number(i.end) > Number(i.start))
      .sort((a, b) => Number(b.start) - Number(a.start));
    let out = src;
    for (const it of spans) {
      const s = Number(it.start);
      const e = Number(it.end);
      if (e > out.length) continue;   // 文本已被外部改写，跳过越界区间而不是抛错
      out = out.slice(0, s) + maskOf(it, strategy) + out.slice(e);
    }
    return out;
  }

  /** 过滤出达到阈值的项，并按等级从高到低排序，保证最严重的排在最前 */
  function pickItems(items, minLevel) {
    const floor = Number(minLevel) || 1;
    return (items || [])
      .filter((i) => (Number(i.level) || 1) >= floor)
      .sort((a, b) => (Number(b.level) || 1) - (Number(a.level) || 1));
  }

  function levelClass(level) {
    const s = LEVEL_STYLE[Number(level)];
    return s ? s.cls : 'lv1';
  }

  function levelTitle(level) {
    const s = LEVEL_STYLE[Number(level)];
    return s ? s.title : LEVEL_STYLE[1].title;
  }

  return {
    MAX_SCAN_CHARS,
    DEBOUNCE_MS,
    LEVEL_STYLE,
    DEFAULT_CONFIG,
    SKIP_TYPES,
    isEditable,
    readValue,
    writeValue,
    maskOf,
    buildMaskedText,
    pickItems,
    levelClass,
    levelTitle,
  };
});

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


const __ps = globalThis.PrivacySentinel;
export default __ps;
export const detect = __ps.detect;
export const analyze = __ps.analyze;
export const mask = __ps.mask;
export const analyzeAndMask = __ps.analyzeAndMask;
export const detectBatch = __ps.detectBatch;
export const types = __ps.types;
export const levels = __ps.levels;
export const desensitize = __ps.desensitize;
export const version = __ps.version;
