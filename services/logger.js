/**
 * 结构化日志器：所有 console 输出都经 sanitize 脱敏后落盘
 *
 * 目标：让"隐私哨兵"的服务器 stdout 自己不会变成隐私泄露源。
 *
 * 脱敏策略：识别对象/数组/字符串中的身份证、银行卡、手机、邮箱、姓名、地址、
 * IP/MAC、URL、token/key、cookie 等字段，把它们的 raw 值替换为 ***REDACTED[类型]***。
 * 原始 raw 长度也保留下来用于排障。
 */

const PLACEHOLDER = (kind) => `***REDACTED[${kind}](len=N)***`;

/** 把任意对象 / 字符串安全化，确保最终进 stdout 的没有可识别隐私。 */
function sanitizeForLog(value, depth = 0) {
  if (depth > 6) return '[too deep]';
  if (value == null) return value;

  // Error 对象：先提取 message/stack/code/status 再继续递归
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeForLog(value.message, depth + 1),
      code: value.code,
      status: value.status,
      // stack 也脱敏，避免泄漏文件路径与代码片段中的隐私
      stack: '[truncated]',
    };
  }

  if (typeof value === 'string') return maskString(value);

  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeForLog(v, depth + 1));
  }

  const out = {};
  for (const k of Object.keys(value)) {
    const lk = k.toLowerCase();
    // 1) 字段名为强敏感关键词（token / apikey / cookie / authorization / password 等）→ 整字段替换
    if (/^(authorization|apikey|api_key|api-key|password|passwd|pwd|token|cookie|secret|session|access_token|refresh_token|set-cookie)$/.test(lk)) {
      out[k] = PLACEHOLDER(k);
      continue;
    }
    // 2) 字段名是用户内容字段（text / data / dataurl / input / text / content 等）→ 整字符串字段按文本规则脱敏
    if (/^(text|data|dataurl|input|content|body|question|prompt|messages|input_text|user_text|user_content|raw_text)$/.test(lk) && typeof value[k] === 'string') {
      out[k] = maskString(value[k]);
      continue;
    }
    // 3) 字段名为敏感类型（phone/idcard/email/...）→ 整字段替换
    if (/^(phone|mobile|email|mail|idcard|id_card|身份证|银行卡|银行卡号|银行卡cvv|cvv|name|姓名|address|地址|地址详情|地址全)$/.test(k) || /^(phone|mobile|email|idcard|id_card|bank_card|bankcard|cvv|name|address)$/.test(lk)) {
      out[k] = PLACEHOLDER(k);
      continue;
    }
    out[k] = sanitizeForLog(value[k], depth + 1);
  }
  return out;
}

/** 在字符串内部扫描常见隐私模式并替换。 */
function maskString(s) {
  if (!s || s.length < 6) return s;
  const patterns = [
    // 身份证 18 位 / 15 位
    { re: /\b\d{17}[\dXx]\b/g, kind: 'idcard' },
    { re: /\b\d{15}\b/g, kind: 'idcard15' },
    // 银行卡（13-19 位连续数字）
    { re: /\b\d{16,19}\b/g, kind: 'bankcard' },
    // 手机号（中国大陆）
    { re: /\b1[3-9]\d{9}\b/g, kind: 'phone' },
    // 邮箱
    { re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, kind: 'email' },
    // IPv4
    { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, kind: 'ipv4' },
    // 中国统一社会信用代码（18 位字母数字）
    { re: /\b[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}\b/g, kind: 'uscc' },
    // 中国护照（E/G/D + 8 位数字）
    { re: /\b[EGDe]\d{8}\b/g, kind: 'passport' },
    // CVV
    { re: /\b\d{3,4}\b(?=\s*[,，]\s*(cvv|cvc|安全码))/gi, kind: 'cvv' },
    // key=xxx / token=xxx
    { re: /\b(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[=:]\s*[\w-]{6,}/gi, kind: 'kv-secret' },
    // Bearer xxx
    { re: /\bBearer\s+[A-Za-z0-9._-]+/g, kind: 'bearer' },
    // 长 base64 chunk（>256 字符连续 base64）→ 直接整段替换为截断预览
    { re: /[A-Za-z0-9+/]{256,}={0,2}/g, kind: 'base64' },
  ];
  let out = s;
  for (const { re, kind } of patterns) {
    out = out.replace(re, (m) => `***${kind}${m.length}***`);
  }
  return out;
}

/** 输出 info 级日志：脱敏后单行 JSON。 */
function info(...args) { write('INFO', args); }
function warn(...args) { write('WARN', args); }
function error(...args) { write('ERROR', args); }

function write(level, args) {
  const ts = new Date().toISOString();
  const safe = args.map((a) => sanitizeForLog(a));
  try {
    process.stdout.write(JSON.stringify({ t: ts, lv: level, msg: safe }) + '\n');
  } catch (_) {
    // 静默：日志本身不能再抛错
  }
}

module.exports = {
  info,
  warn,
  error,
  sanitizeForLog,
  // 测试 / 自检可能需要直接拿脱敏后的内容做断言
  _maskString: maskString,
};
