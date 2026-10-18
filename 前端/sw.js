/* Privacy Sentinel · Service Worker v3.3
 *
 * 策略：
 *   - /api/*          永远走网络（识别结果实时性强，缓存反而误事）
 *   - GET 其他路径     网络优先，失败回退缓存（保证离线仍可看历史）
 *   - 字体/图片/JS    缓存优先（它们很少变）
 *
 * 注意：缓存版本号（v3.3.0）随产品版本一起改；旧缓存会在 activate 时清理。
 */
const CACHE_VERSION = 'privacy-sentinel-v3.3.0';
const STATIC_CACHE = [CACHE_VERSION + '-shell'];

self.addEventListener('install', (event) => {
  // 不预缓存任何资源——index.html 自身就够大了，且会被 service worker 自身的
  // scope 拦截预缓存请求。让运行时缓存策略自己决定。
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('privacy-sentinel-') && k !== CACHE_VERSION && !k.endsWith('-shell'))
          .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

function isStaticAsset(url) {
  return /\.(?:js|css|png|svg|ico|woff2?|ttf|eot)(?:\?.*)?$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;          // POST/PUT 不做缓存
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API：永远走网络，失败交给前端 callAnalyze 的重试
  if (isApiRequest(url)) {
    event.respondWith(fetch(req).catch(() => new Response(
      JSON.stringify({ success: false, error: '当前处于离线模式，分析功能需要联网' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )));
    return;
  }

  // 静态资源：缓存优先
  if (isStaticAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const resp = await fetch(req);
        if (resp.ok) cache.put(req, resp.clone());
        return resp;
      } catch (e) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // 其它（页面 / index.html / SPA 路由）：网络优先，失败回退缓存
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    try {
      const resp = await fetch(req);
      if (resp.ok && req.mode === 'navigate') cache.put(req, resp.clone());
      return resp;
    } catch (e) {
      const hit = await cache.match(req) || await cache.match('/');
      if (hit) return hit;
      return new Response('离线且无缓存', { status: 504 });
    }
  })());
});
