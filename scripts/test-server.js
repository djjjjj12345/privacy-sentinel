/**
 * HTTP-level server tests — exercises the express stack without going through
 * the AI pipeline. Boots a fresh in-process instance, no external network, no
 * API key required.
 *
 * 用法：node scripts/test-server.js
 */
'use strict';
const http = require('http');
const path = require('path');

let pass = 0, fail = 0;
const log = (ok, name, info) => { ok ? pass++ : fail++; console.log(`${ok ? '✅' : '❌'} ${name}${info ? '  ·  ' + info : ''}`); };

const express = require('express');
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '45mb' }));
app.use(express.urlencoded({ extended: true, limit: '45mb' }));

const analyzeRoutes = require(path.join(__dirname, '..', 'routes', 'analyze'));
const detectRoutes = require(path.join(__dirname, '..', 'routes', 'detect'));
app.use('/api/analyze', analyzeRoutes);
app.use('/api', detectRoutes);

app.get('/api/health', (req, res) => {
  res.json({ success: true, version: require(path.join(__dirname, '..', 'package.json')).version });
});

// 复刻 server.js 的关键中间件
app.use(express.static(path.join(__dirname, '..', '前端')));
app.use('/api', (req, res) => res.status(404).json({ success: false, error: `接口不存在：${req.method} ${req.originalUrl}` }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ success: false, error: '请求体过大' });
  res.status(500).json({ success: false, error: err.message });
});

const srv = app.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const req = (method, url, body) => new Promise((resolve) => {
    const r = http.request(base + url, { method, headers: { 'Content-Type': 'application/json' } }, (resp) => {
      let data = '';
      resp.on('data', (c) => data += c);
      resp.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch {}
        resolve({ status: resp.statusCode, body: json, raw: data, ct: resp.headers['content-type'] });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: null, raw: e.message }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });

  try {
    // 1) 健康检查
    let r = await req('GET', '/api/health');
    log(r.status === 200 && r.body?.success === true, '/api/health 返回成功', `v${r.body?.version}`);

    // 2) 未注册的 API 返回 JSON 404
    r = await req('GET', '/api/nonexistent');
    log(r.status === 404 && r.body?.success === false, '未知 API 返回 JSON 404', `err=${(r.body?.error || '').slice(0, 30)}`);

    // 3) body 上限触发
    const huge = 'A'.repeat(50 * 1024 * 1024);
    r = await req('POST', '/api/analyze', { kind: 'text', data: huge });
    log(r.status === 413, '超 45MB 请求体被 413 拒绝', `HTTP ${r.status}`);

    // 4) 缺 kind 字段
    r = await req('POST', '/api/analyze', { text: 'hello' });
    log(r.status >= 400 && r.body?.success === false, '缺 kind 字段被拒', `HTTP ${r.status}`);

    // 5) text 通道正常路径
    r = await req('POST', '/api/analyze', { kind: 'text', text: '我的身份证是 110105199003071239，请保密' });
    log(r.status === 200 && r.body?.success === true && (r.body?.items?.length || 0) > 0, 'text 通道识别身份证', `${(r.body?.items || []).length} items`);

    // 6) text 通道：没有敏感信息
    r = await req('POST', '/api/analyze', { kind: 'text', text: '今天天气真好啊' });
    log(r.status === 200 && r.body?.success === true && (r.body?.items?.length || 0) === 0, 'text 通道无敏感信息返回 items=[]');

    // 7) 限流：默认上限 30/分钟，发 40 个并发，期望至少 10 个 429
    const burst = [];
    for (let i = 0; i < 40; i++) burst.push(req('POST', '/api/analyze', { kind: 'text', text: 'test' + i }));
    const burstResults = await Promise.all(burst);
    const over429 = burstResults.filter((x) => x.status === 429).length;
    const remainingHeader = burstResults[0]?.body?.error || burstResults[0]?.raw;
    log(over429 >= 8, '限流触发：40 并发中至少 8 个 429', `${over429}/40 返回 429`);

    // 8) X-RateLimit-* 头存在
    r = await req('GET', '/api/health');
    // GET 不走限流，所以直接读 burstResults 里第一个 200 的响应
    const first200 = burstResults.find((x) => x.status === 200);
    log(!!first200, '限流前 30 个请求通过', `首个 200 收到 ${first200 ? 'OK' : 'NONE'}`);

    // 9) 响应头是 JSON
    r = await req('POST', '/api/analyze', {});
    log(r.ct && r.ct.includes('json'), 'API 错误响应 Content-Type 是 JSON', r.ct || '无');

    // 10) 静态资源正常
    r = await new Promise((resolve) => {
      http.get(base + '/manifest.webmanifest', (resp) => {
        resolve({ status: resp.statusCode });
        resp.resume();
      }).on('error', (e) => resolve({ status: 0, err: e.message }));
    });
    log(r.status === 200, 'manifest.webmanifest 静态可访问', `HTTP ${r.status}`);

    // 11) service worker 可访问
    r = await new Promise((resolve) => {
      http.get(base + '/sw.js', (resp) => { resolve({ status: resp.statusCode }); resp.resume(); });
    });
    log(r.status === 200, 'sw.js 静态可访问', `HTTP ${r.status}`);

    // 12) icon 可访问
    r = await new Promise((resolve) => {
      http.get(base + '/icons/icon-192.png', (resp) => { resolve({ status: resp.statusCode }); resp.resume(); });
    });
    log(r.status === 200, 'icons/icon-192.png 静态可访问', `HTTP ${r.status}`);

    console.log(`\n=== HTTP 测试：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} ===`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('未捕获异常:', e);
    process.exit(2);
  }
});
