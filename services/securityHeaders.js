/**
 * 基础安全响应头
 * ---------------------------------------------------------------
 * 定位：一个「隐私保护工具」如果自身安全头都配不齐，是没有说服力的。
 * 集中配置一处挂载，避免散落各处后漏配。
 *
 * CSP 的现实约束与选择：
 *   前端目前是单文件（index.html 内含大量 <style> 与 <script>）。
 *   如果 CSP 直接写 'unsafe-inline'，等于 XSS 防护形同虚设；
 *   如果完全不写内联许可，页面会立刻白屏。
 *   因此这里采用 nonce 方案：
 *     - 每个请求生成随机 nonce；
 *     - HTML 响应由 htmlNonce 中间件读取后，给所有 <style>/<script> 标签
 *       注入 nonce（全局替换，不只是第一个）；
 *     - CSP 里只放行 'self' + nonce。浏览器在检测到 nonce 后会忽略
 *       'unsafe-inline'，因此策略是真正生效的，而不是摆设。
 *   前提：页面里不能残留内联事件处理器（onclick=...），因为 nonce 不覆盖
 *   属性型处理器。index.html 中的那一处已改为 addEventListener。
 *
 *   HSTS 只在 HTTPS 下发送——本地 http 调试时发了会让浏览器强制跳转。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 生成 CSP 策略串 */
function buildCsp(nonce) {
  const directives = [
    "default-src 'self'",
    // 图片：允许 data:（本地预览、OCR 回显）、blob:
    "img-src 'self' data: blob: https:",
    // 媒体：音视频预览走 blob:/data:
    "media-src 'self' data: blob:",
    // 样式与脚本：仅同源 + 本次 nonce（不写 unsafe-inline，让策略真正生效）
    `style-src 'self' 'nonce-${nonce}'`,
    `script-src 'self' 'nonce-${nonce}'`,
    // 连接：只放行同源。AI 调用全部由服务端转发，前端不直连任何第三方
    "connect-src 'self'",
    "font-src 'self' data:",
    // 禁止被嵌套，防点击劫持
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ];
  return directives.join('; ');
}

/** Express 中间件：为所有响应补安全头，并把 nonce 挂到 res.locals */
function securityHeaders(req, res, next) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // 已废弃，显式关闭避免旧浏览器进入兼容模式
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(self), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', buildCsp(nonce));

  // HSTS：仅 HTTPS 生效
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (req.secure || proto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // 处理敏感输入的工具不应被任何中间层缓存
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');

  next();
}

/**
 * HTML 响应注入 nonce 的中间件（挂在 express.static 之前）。
 * - 只处理 HTML 请求，其余交回给 static；
 * - 文件原文做进程内缓存，避免每次请求重复读盘；
 * - 读取失败或路径异常时直接 next()，交给原有逻辑，不阻断页面。
 *
 * @param {string} rootDir 前端目录绝对路径
 */
function htmlNonce(rootDir) {
  const root = path.resolve(rootDir);
  const cache = new Map(); // 文件绝对路径 -> { mtimeMs, html }

  function readCached(file) {
    return new Promise((resolve, reject) => {
      fs.stat(file, (err, st) => {
        if (err) return reject(err);
        const hit = cache.get(file);
        if (hit && hit.mtimeMs === st.mtimeMs) return resolve(hit.html);
        fs.readFile(file, 'utf8', (e2, html) => {
          if (e2) return reject(e2);
          cache.set(file, { mtimeMs: st.mtimeMs, html });
          resolve(html);
        });
      });
    });
  }

  return function htmlNonceMiddleware(req, res, next) {
    const p = String(req.path || '');
    // 只接管页面请求；静态资源（js/css/图标）走 static
    const isHtml = p === '/' || p === '' || /\.html$/i.test(p);
    if (!isHtml || req.method !== 'GET') return next();

    const rel = p === '/' || p === '' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.resolve(root, rel);
    // 目录穿越防护：解析后必须仍在 root 之内
    if (file !== root && !file.startsWith(root + path.sep)) return next();

    readCached(file)
      .then((html) => {
        const nonce = res.locals.cspNonce;
        let out = html;
        if (nonce) {
          // 全局替换：单文件前端有多个 style/script 标签，漏一个就会白屏
          out = out
            .replace(/<style\b/gi, `<style nonce="${nonce}"`)
            .replace(/<script\b/gi, `<script nonce="${nonce}"`);
        }
        // og:image / og:url / canonical 必须是绝对地址：微信、Twitter 的抓取器
        // 拿到 "/icons/og-cover.png" 会直接放弃，分享卡片就没有封面图。
        const base = String(process.env.PUBLIC_BASE_URL || 'https://privacy-sentinel.onrender.com').replace(/\/+$/, '');
        out = out
          .replace(/(<meta\s+property="og:(?:image|image:secure_url|url)"\s+content=")(\/[^"]*)"/gi, `$1${base}$2"`)
          .replace(/(<link\s+rel="canonical"\s+href=")(\/[^"]*)"/gi, `$1${base}$2"`);
        res.type('html').send(out);
      })
      .catch(() => next());
  };
}

module.exports = { securityHeaders, htmlNonce, buildCsp };
