/**
 * 图片 URL 入口守卫
 * ---------------------------------------------------------------
 * 用户可以把图片链接交给服务端识别。如果直接拿去请求，工具就变成了一个
 * 「任意 URL 探测代理」——攻击者能借它访问内网、云元数据（169.254.169.254），
 * 这就是典型的 SSRF。
 *
 * 这里做的是「先校验再放行」：
 *   1. 只允许 http / https；
 *   2. 拒绝带账号密码的 URL；
 *   3. 拒绝环回、私网、链路本地、云元数据地址（IPv4 与 IPv6 都覆盖）；
 *   4. 限制长度，避免超长 URL 撑爆日志或请求头；
 *   5. 只按主机名字面判断，不做 DNS 解析——DNS 重绑定需在真正发起请求时
 *      用同样的判定再拦一次（当前实现把 URL 交给模型服务，服务端不发起请求）。
 */

const MAX_URL_LENGTH = 2048;

/** 明显指向本机/内网的保留域名后缀 */
const BLOCKED_HOST_SUFFIXES = [
  'localhost',
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home.arpa',
];

/** 云厂商元数据服务的常用主机名 */
const BLOCKED_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.tencentyun.com',
  '100.100.100.200', // 阿里云元数据
  '169.254.169.254', // AWS / 华为云 / 腾讯云通用
  'fd00:ec2::254',
]);

function parseIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const segs = m.slice(1).map(Number);
  if (segs.some((n) => n > 255)) return null;
  return segs;
}

/** 私有 / 环回 / 链路本地 / 保留段 */
function isPrivateIPv4(segs) {
  const [a, b] = segs;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 环回
  if (a === 169 && b === 254) return true; // 链路本地（含元数据地址）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 运营商级 NAT 100.64/10
  if (a >= 224) return true; // 组播与保留
  return false;
}

function isPrivateIPv6(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (/^fe80:/.test(h)) return true; // 链路本地
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // 唯一本地地址 fc00::/7
  if (/^::ffff:/.test(h)) return true; // IPv4 映射，属于绕过的常见写法
  return false;
}

/**
 * @param {string} raw
 * @returns {{ok: boolean, reason?: string, url?: string}}
 */
function checkImageUrl(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return { ok: false, reason: '图片地址为空' };
  // data: URL 是用户本地图片编码，不经过网络，直接放行
  if (/^data:image\//i.test(value)) return { ok: true, url: value };
  if (value.length > MAX_URL_LENGTH) return { ok: false, reason: `图片地址过长（超过 ${MAX_URL_LENGTH} 字符）` };

  let u;
  try {
    u = new URL(value);
  } catch (e) {
    return { ok: false, reason: '图片地址格式不正确，应以 http:// 或 https:// 开头' };
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: '只支持 http / https 图片地址' };
  }
  if (u.username || u.password) {
    return { ok: false, reason: '图片地址不能包含用户名或密码' };
  }

  const host = u.hostname.toLowerCase();

  if (BLOCKED_HOSTS.has(host)) return { ok: false, reason: '不允许访问该地址' };
  if (BLOCKED_HOST_SUFFIXES.some((s) => host === s.replace(/^\./, '') || host.endsWith(s))) {
    return { ok: false, reason: '不允许访问内网或本机地址' };
  }

  const v4 = parseIPv4(host);
  if (v4 && isPrivateIPv4(v4)) return { ok: false, reason: '不允许访问内网或本机地址' };
  if (host.includes(':') && isPrivateIPv6(host)) return { ok: false, reason: '不允许访问内网或本机地址' };

  return { ok: true, url: u.toString() };
}

module.exports = { checkImageUrl, isPrivateIPv4, isPrivateIPv6, MAX_URL_LENGTH };
