/**
 * ⚠️ 本文件由 scripts/build-extension.js 自动生成，请勿直接修改。
 * 来源：services/localDetector.js（哈希 c8492dddb4e5）
 * 改规则请改 services/ 下的源文件，然后重新运行：node scripts/build-extension.js
 */
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
 *   3. 数字间分隔符：138 0013-8000 / 4111.1111.1111.1111
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

  // 只折叠空格/连字符/下划线：点号不能折叠，否则 192.168.1.100 会被粘成 1921681100，
  // IP 直接漏检。分组的点号（4111.1111.1111.1111）比 IP 罕见得多，取舍很明确。
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
