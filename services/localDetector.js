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

const { normalizeItem, desensitize, TYPE_LABEL } = require('./schema');

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

  // ---- 家庭住址 ----
  const addressRe = /(?:北京|上海|天津|重庆|广州|深圳|杭州|成都|武汉|南京|西安|长沙|青岛|郑州|大连|东莞|宁波|厦门|合肥|福州|昆明|沈阳|济南|无锡|苏州|南昌|南宁|长春|哈尔滨|太原|石家庄|兰州|海口|贵阳|乌鲁木齐|呼和浩特|银川|西宁|拉萨)(?:市|区|县|州|盟)?[^\s，。；;、,]{0,20}?(?:路|街|大道|大街|巷|弄|胡同|号院|小区|花园|公寓|大厦|广场|苑|村)\d*\s*(?:号|栋|幢|单元|楼|层|室)?[^\s，。；;、,]{0,10}/g;
  for (const m of text.matchAll(addressRe)) {
    const value = m[0].trim();
    if (value.length < 5) continue;
    push('address', value, m.index, m.index + m[0].length, true);
  }

  return raw;
}

/**
 * 冲突消解：同一段字符区间只保留一个类型。
 * 优先级按证据强度排序，同时让「校验通过的候选」优先占用区间。
 */
const TYPE_PRIORITY = {
  otp: 100,
  password: 95,
  id: 90,
  bankcard: 80,
  phone: 70,
  address: 60,
  name: 50,
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

/**
 * 对文本执行本地检测。
 * @param {string} text
 * @returns {Array} 标准化后的条目数组
 */
function detect(text) {
  if (!text || typeof text !== 'string') return [];

  const matches = resolveOverlaps(collectMatches(text));

  return matches
    .map((m) =>
      normalizeItem(
        {
          type: m.type,
          raw: m.value,
          level: undefined,
          confidence: m.verified ? 1 : 0.6,
          verified: m.verified,
          reason: m.verified
            ? '匹配到固定格式规则，校验通过'
            : '格式匹配但校验位不符，可能是测试号码或录入错误，请人工确认',
        },
        'local'
      )
    )
    .filter(Boolean);
}

module.exports = {
  detect,
  checkIdCard,
  checkBankCard,
  isLuhnValid,
  TYPE_LABEL,
  desensitize,
};
