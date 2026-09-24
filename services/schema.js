/**
 * 统一数据契约层
 * ---------------------------------------------------------------
 * 前端、正则引擎、视觉模型三方共用同一份类型枚举与等级标准。
 * 任何一端新增类型，只需改这一个文件。
 */

// 敏感信息类型枚举：key 同时作为前端 desensitize() 的分支标识
const TYPE_LABEL = {
  id: '身份证号',
  bankcard: '银行卡号',
  phone: '手机号',
  password: '密码',
  otp: '短信验证码',
  address: '家庭住址',
  name: '姓名',
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
  };
  if (ALIAS[type]) type = ALIAS[type];
  if (!TYPE_KEYS.includes(type)) type = 'other';

  const value = String(raw.raw != null ? raw.raw : raw.value != null ? raw.value : '').trim();
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
    '      "type": "id | bankcard | phone | password | otp | address | name | other",',
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

module.exports = {
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
