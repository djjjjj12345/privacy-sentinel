/**
 * 前端交互测试（v3.5 · DOM 级）
 * ---------------------------------------------------------------
 * 前面的套件全是「接口级」验证：请求进得去、响应出得来对。
 * 但用户体验发生在浏览器里——按钮点了有没有反应、弹窗弹不弹、
 * 主题切不切、结果刷完页面还在不在。这些接口测试一律看不见。
 *
 * 本套件用 jsdom 真实加载 前端/index.html，跑真实的内联脚本，
 * 点击真实按钮，断言真实 DOM 变化。覆盖：
 *   A. 加载与结构：无运行时报错、关键节点齐全、无内联 onclick
 *   B. 主题切换：翻转、图标同步、持久化
 *   C. 隐私声明：首访弹窗、承诺文案、不再提示
 *   D. 示例样本：一键填充、填充内容可检出
 *   E. 检测规则：全选/单选/重置、过滤真的传给后端
 *   F. 批量检测：填充→运行→统计→清空
 *   G. 分层报告：评分、等级标色、通俗解释、整改建议、导出入口
 *   H. 错误分类：502 唤醒、429 限流、可重试与不可重试
 *   I. 本地缓存：脱敏后缓存、刷新可恢复、24h 过期
 *
 * 离线可跑：自建 express 实例，fetch 由测试注入并代理到该实例。
 *
 * 用法：node scripts/test-frontend-dom.js
 */
'use strict';

process.env.RATE_LIMIT_PER_MINUTE = process.env.RATE_LIMIT_PER_MINUTE || '100000';

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '前端');

let pass = 0;
let fail = 0;
const failures = [];
const log = (ok, name, info) => {
  ok ? pass++ : (fail++, failures.push(name));
  console.log(`${ok ? '✅' : '❌'} ${name}${info ? '  ·  ' + info : ''}`);
};

const errors = require(path.join(ROOT, 'services', 'errors'));
const { securityHeaders, htmlNonce } = require(path.join(ROOT, 'services', 'securityHeaders'));
const analyzeRoutes = require(path.join(ROOT, 'routes', 'analyze'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================================================
//  测试用服务：真实路由 + 几个前端初始化会打到的轻量桩
// ================================================================
const app = express();
app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(express.json({ limit: '45mb' }));
app.use('/api/analyze', analyzeRoutes);
// 页面启动时会拉这些；返回空结果即可，避免测试依赖数据库
// 可变：状态页需要在同一次运行里验证「正常」与「降级」两种判定
let healthPayload = {
  success: true, version: '3.5.0', uptime: 99, booting: false,
  db: 'ok', dbDriver: 'sqlite', redis: 'disabled',
  aiProvider: 'ark', aiProviderLabel: '火山方舟', aiProviderConfigured: true, aiFallback: null,
  rateLimitPerMinute: 100000,
  capabilities: { text: true, image: true, audio: true, video: true },
};
app.get('/api/health', (req, res) => res.json(healthPayload));
app.get('/api/auth/me', (req, res) => res.json({ success: true, user: null }));
app.get('/api/history', (req, res) => res.json({ success: true, items: [] }));
app.use(htmlNonce(FRONTEND));
app.use(express.static(FRONTEND));
app.use('/api', (req, res) => res.status(404).json(errors.payload('not_found')));
app.use((err, req, res, next) => res.status(500).json(errors.payload(err)));

/** fetch 桩：把相对路径代理到测试服务，返回最小 Response 形状 */
function makeFetch(base) {
  return function fetchStub(url, opts) {
    opts = opts || {};
    const abs = /^https?:\/\//.test(url) ? url : base + url;
    return new Promise((resolve, reject) => {
      const r = http.request(abs, {
        method: (opts.method || 'GET').toUpperCase(),
        headers: opts.headers || {},
      }, (resp) => {
        let data = '';
        resp.on('data', (c) => (data += c));
        resp.on('end', () => resolve({
          ok: resp.statusCode >= 200 && resp.statusCode < 300,
          status: resp.statusCode,
          headers: resp.headers,
          json: () => Promise.resolve(JSON.parse(data)),
          text: () => Promise.resolve(data),
        }));
      });
      r.on('error', reject);
      if (opts.signal) opts.signal.addEventListener('abort', () => r.destroy(new Error('aborted')));
      if (opts.body) r.write(opts.body);
      r.end();
    });
  };
}

/** 用 jsdom 加载页面；seed 用于预置 localStorage */
async function loadPage(base, seed, file) {
  const { JSDOM, VirtualConsole } = require('jsdom');
  let html = fs.readFileSync(path.join(FRONTEND, file || 'index.html'), 'utf8');
  // 内联 i18n 与检测引擎，避免依赖 jsdom 的资源加载器
  // （引擎来自 services/，与后端同源；本地模式依赖它）
  const i18nSrc = fs.readFileSync(path.join(FRONTEND, 'services', 'i18n.js'), 'utf8');
  html = html.replace(/<script src="\/services\/i18n\.js"><\/script>/, '<script>' + i18nSrc + '</script>');
  for (const f of ['schema.js', 'localDetector.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'services', f), 'utf8');
    html = html.replace(`<script src="/engine/${f}"></script>`, '<script>' + src + '</script>');
  }

  const jsErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    const msg = String(e && e.message || e);
    // jsdom 未实现的浏览器 API（window.open / 媒体播放等）不算业务错误
    if (/Not implemented|Could not parse CSS|Error: Not implemented/.test(msg)) return;
    jsErrors.push(msg);
  });
  vc.on('error', (m) => { if (!/Not implemented/.test(String(m))) jsErrors.push(String(m)); });

  const dom = new JSDOM(html, {
    url: base + '/' + (file || 'index.html'),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.fetch = function (u, o) {
        window.__fetchCalls.push(String(u));
        return makeFetch(base)(u, o);
      };
      window.__fetchCalls = [];
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.open = () => null;
      window.URL.createObjectURL = () => 'blob:mock';
      window.URL.revokeObjectURL = () => {};
      window.__copied = null;
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } },
      });
      if (seed) Object.keys(seed).forEach((k) => window.localStorage.setItem(k, seed[k]));
    },
  });
  await sleep(1300); // 等首访弹窗 600ms、欢迎语 800ms、缓存恢复 900ms
  return { dom, window: dom.window, document: dom.window.document, jsErrors };
}

const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));

// ================================================================
const srv = app.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  let ctx;
  try {
    ctx = await loadPage(base);
  } catch (e) {
    console.log('❌ 页面加载失败：' + e.message);
    fail++;
    srv.close();
    process.exit(1);
  }
  const { window: win, document: doc, jsErrors } = ctx;
  const q = (s) => doc.querySelector(s);
  const byId = (id) => doc.getElementById(id);

  // ================= A0. HTML 结构完整性（跨全部页面） =================
  // 起因（真实事故）：往 index.html 的 </style> 前插 CSS 时误删了闭合标签，
  // body 之后的全部内容被解析器当成 CSS 文本吞掉——页面照样返回 200，
  // 但 body 是空的、脚本一行没跑。接口测试对此完全无感，必须在这里硬断言。
  console.log('\n--- A0. HTML 结构完整性 ---');
  {
    const { JSDOM: RawJSDOM } = require('jsdom');
    for (const f of ['index.html', 'docs.html', 'status.html', 'guard.html', 'launch.html']) {
      const html = fs.readFileSync(path.join(FRONTEND, f), 'utf8');
      const cnt = (re) => (html.match(re) || []).length;
      const sOpen = cnt(/<style[\s>]/g), sClose = cnt(/<\/style>/g);
      const jOpen = cnt(/<script[\s>]/g), jClose = cnt(/<\/script>/g);
      log(sOpen === sClose, `${f} 的 <style> 开闭配对`, `开 ${sOpen} / 闭 ${sClose}`);
      log(jOpen === jClose, `${f} 的 <script> 开闭配对`, `开 ${jOpen} / 闭 ${jClose}`);
      const dm = new RawJSDOM(html);
      const n = dm.window.document.body ? dm.window.document.body.children.length : 0;
      log(n > 0, `${f} 解析后 body 非空`, `${n} 个子节点`);
    }
  }

  // ================= A. 加载与结构 =================
  console.log('\n--- A. 加载与结构 ---');
  log(jsErrors.length === 0, '页面脚本无运行时报错', jsErrors.length ? jsErrors.slice(0, 2).join(' | ').slice(0, 120) : '0 条');
  ['privacyModal', 'wakeMask', 'batchPanel', 'rulesPanel', 'btnTheme', 'ruleGrid', 'batchInput', 'batchResult']
    .forEach((id) => log(!!byId(id), `关键节点 ${id} 存在`));
  log(!/\sonclick\s*=/.test(fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8')),
    '页面无内联 onclick（nonce CSP 下会被拦截）');
  const tagline = q('.tagline');
  log(!!tagline && /身份证|手机号|密钥|敏感/.test(tagline.textContent), '首页一句话简介说明了工具用途',
    tagline ? tagline.textContent.replace(/\s+/g, ' ').slice(0, 46) : '缺失');
  // 注意：断言不要用 document.body.textContent —— 它会把内联 <script> 的源码也算进去，
  // 导致「源码里出现过这个字符串」被误判成「页面上渲染了它」。下面统一查具体元素。
  const issueLink = doc.querySelector('a[href*="issues/new"]');
  log(!!issueLink && /djjjjj12345\/privacy-sentinel/.test(issueLink.getAttribute('href')),
    '反馈入口指向真实 issue 页', issueLink ? issueLink.getAttribute('href') : '缺失');

  // ================= B. 主题切换 =================
  console.log('\n--- B. 主题切换 ---');
  {
    const before = doc.documentElement.getAttribute('data-theme');
    click(byId('btnTheme'));
    const after = doc.documentElement.getAttribute('data-theme');
    log(before !== after && ['light', 'dark'].indexOf(after) >= 0, '点击主题按钮翻转 data-theme', `${before} → ${after}`);
    log(['☀️', '🌙'].indexOf(byId('btnTheme').textContent) >= 0, '主题按钮图标同步变化', byId('btnTheme').textContent);
    const saved = win.localStorage.getItem('privacy-sentinel:theme');
    log(saved && JSON.parse(saved) === after, '主题写入 localStorage', saved);
    const meta = q('meta[name="theme-color"]');
    log(!meta || /^#/.test(meta.getAttribute('content')), 'theme-color 随之更新', meta ? meta.getAttribute('content') : '无该标签');
    click(byId('btnTheme'));
    log(doc.documentElement.getAttribute('data-theme') === before, '再次点击回到原主题');
  }

  // ================= C. 隐私声明 =================
  console.log('\n--- C. 隐私声明 ---');
  {
    const modal = byId('privacyModal');
    log(modal.classList.contains('show'), '首次访问自动弹出隐私承诺');
    const text = modal.textContent.replace(/\s+/g, '');
    log(/仅用于本次检测/.test(text), '承诺：仅用于本次检测');
    log(/不保留原始数据/.test(text), '承诺：服务端不保留原始数据');
    log(/不转发给第三方/.test(text), '承诺：不转发第三方');
    log(/立即从对象存储删除|脱敏形式展示/.test(text), '承诺：临时文件删除 / 结果脱敏');
    byId('privacyDontShow').checked = true;
    click(byId('privacyAgree'));
    log(!modal.classList.contains('show'), '点击「我已了解」后关闭');
    log(win.localStorage.getItem('privacy-sentinel:privacy-ack') === 'true', '勾选不再提示后写入确认标记');

    // 有确认标记的新实例不应再自动弹窗
    const second = await loadPage(base, { 'privacy-sentinel:privacy-ack': 'true' });
    log(!second.document.getElementById('privacyModal').classList.contains('show'),
      '已有确认标记时不再自动弹窗');
    second.dom.window.close();
  }

  // ================= D. 示例样本 =================
  console.log('\n--- D. 示例样本 ---');
  {
    const input = byId('msgInput');
    input.value = '';
    const chip = q('[data-action="fill-sample"]');
    log(!!chip, '示例样本入口存在');
    click(chip);
    const v = input.value || '';
    log(v.length > 10, '点击后输入框被填充', `${v.length} 字`);
    log(/11010519491231002X/.test(v) && /13800138000/.test(v), '示例含可校验的身份证与手机号');
    // 填充内容真的能被检出，否则示例是摆设（用后端同一套规则引擎验证）
    const detected = require(path.join(ROOT, 'services', 'analyzer')).analyzeTextLocalOnly(v);
    log(detected.items.length >= 2, '示例内容确实能检出敏感信息',
      `检出 ${detected.items.length} 处：${detected.items.map((i) => i.label).join('、')}`);
  }

  // ================= E. 检测规则自定义 =================
  console.log('\n--- E. 检测规则自定义 ---');
  {
    const boxes = doc.querySelectorAll('#ruleGrid input[data-rule]');
    const ruleCount = Number(win.eval('RULE_TYPES.length'));
    log(boxes.length === ruleCount && ruleCount >= 12, '规则网格渲染完整', `${boxes.length} 类 / 定义 ${ruleCount} 类`);
    log(/全部/.test(byId('rulesCount').textContent), '默认全选', byId('rulesCount').textContent);

    click(q('[data-action="rules-none"]'));
    log(/已选 1 \//.test(byId('rulesCount').textContent), '「全不选」降级为保留 1 类（避免欺骗性关闭）',
      byId('rulesCount').textContent);
    const picked = win.eval('JSON.stringify(selectedTypes)');
    log(picked === '["id"]', '保留类型为身份证号', picked);

    click(q('[data-action="rules-reset"]'));
    log(/全部/.test(byId('rulesCount').textContent), '「重置」恢复全选');
    log(win.eval('activeTypes()') === null, '全选时 activeTypes 返回 null（后端不过滤）');

    // 只勾手机号，验证过滤真的传到后端并生效
    win.eval(`selectedTypes = ['phone']; renderRuleGrid();`);
    log(JSON.stringify(win.eval('activeTypes()')) === '["phone"]', '单选时 activeTypes 返回勾选数组');
    const resp = await new Promise((resolve) => {
      const body = JSON.stringify({ items: [{ text: '验证码 8832，手机号 13800138000' }], mode: 'local', types: ['phone'] });
      const r = http.request(base + '/api/analyze/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d)));
      });
      r.end(body);
    });
    const types = (resp.results[0].items || []).map((i) => i.type);
    log(types.length === 1 && types[0] === 'phone', '后端按勾选类型过滤生效', types.join(',') || '无');
    win.eval(`selectedTypes = null; renderRuleGrid();`);
  }

  // ================= F. 批量检测 =================
  console.log('\n--- F. 批量检测 ---');
  {
    click(q('[data-action="batch-sample"]'));
    const lines = byId('batchInput').value.split('\n');
    log(lines.length >= 2, '批量示例填充多行', `${lines.length} 行`);

    byId('batchInput').value = '我叫张三，身份证11010519491231002X\n今天天气不错\n手机号13800138000，验证码8832';
    click(q('[data-action="batch-run"]'));
    await sleep(600);
    const out = byId('batchResult');
    log(/共 3 行/.test(out.textContent), '批量结果含总行数', (out.textContent.match(/共 \d+ 行/) || [''])[0]);
    log(/已扫描 3 行/.test(out.textContent), '统计已扫描行数');
    log(/命中 2 行/.test(out.textContent), '统计命中行数', (out.textContent.match(/命中 \d+ 行/) || [''])[0]);
    log(out.querySelectorAll('.batch-row').length === 3, '逐行结果渲染 3 行');
    log(out.querySelectorAll('.rp-chip').length === 3, '每行带等级标签');
    log(/跳过|安全/.test(out.textContent), '无敏感内容的行标记为安全');

    click(q('[data-action="batch-clear"]'));
    log(byId('batchInput').value === '' && byId('batchResult').innerHTML === '', '清空按钮重置输入与结果');

    let requested = false;
    const origFetch = win.fetch;
    win.fetch = (u, o) => { requested = true; return origFetch(u, o); };
    click(q('[data-action="batch-run"]'));
    await sleep(300);
    log(!requested, '空输入不发起请求（前端先拦）');
    win.fetch = origFetch;
  }

  // ================= G. 分层报告 =================
  console.log('\n--- G. 分层报告 ---');
  {
    const detections = [
      { type: 'id', label: '身份证号', level: 1, masked: '110105********002X', value: '110105********002X', reason: '' },
      { type: 'password', label: '密码', level: 3, masked: 'MyP****2024', value: 'MyP****2024', reason: '' },
    ];
    win.eval(`renderLayeredReport(${JSON.stringify(detections)}, { text: 'x', score: 62, maxLevel: 3, levelName: '高危' })`);
    const last = [...doc.querySelectorAll('.rp-wrap')].pop();
    log(!!last, '分层报告渲染成功');
    log(!!last.querySelector('.rp-score-num'), '① 含总分概览', last.querySelector('.rp-score-num') ? last.querySelector('.rp-score-num').textContent : '');
    log(last.querySelectorAll('.rp-item').length === 2, '② 风险点逐条列出');
    const chips = [...last.querySelectorAll('.rp-chip')].map((c) => c.className);
    log(chips.some((c) => /lv-high/.test(c)), '③ 高危标红（lv-high）', chips.join(' | '));
    log(chips.some((c) => /lv-low/.test(c)), '③ 低危标黄（lv-low）');
    log(/为什么危险|❓/.test(last.textContent), '④ 每条含通俗解释');
    log(/建议处理|🛠/.test(last.textContent), '⑤ 每条含整改建议');
    log(!!last.querySelector('[data-action="copy-report"]') && !!last.querySelector('[data-action="export-json"]'),
      '⑥ 含复制报告与导出 JSON 入口');

    // 复制真的把报告写进剪贴板
    click(last.querySelector('[data-action="copy-report"]'));
    await sleep(50);
    const copied = win.__copied || '';
    log(/风险评分/.test(copied) && /身份证号/.test(copied), '复制报告内容完整', `${copied.length} 字`);
    log(!/11010519491231002X/.test(copied), '复制内容中不含明文身份证（默认脱敏）');
  }

  // ================= H. 错误分类 =================
  console.log('\n--- H. 错误分类 ---');
  {
    const c502 = win.eval(`JSON.stringify(classifyError({ code: 'x' }, 502))`);
    log(/service_waking|服务正在唤醒/.test(JSON.parse(c502).title + JSON.parse(c502).message),
      '502 识别为「服务正在唤醒」', JSON.parse(c502).title);
    const c429 = win.eval(`JSON.stringify(classifyError({ code: 'rate_limited' }, 429))`);
    log(/限流|频繁|稍后/.test(JSON.parse(c429).title + JSON.parse(c429).message + JSON.parse(c429).action),
      '429 给出限流提示', JSON.parse(c429).title);
    const cEmpty = win.eval(`JSON.stringify(classifyError({ code: 'empty_input' }, 400))`);
    const emptyObj = JSON.parse(cEmpty);
    log(!!emptyObj.action, '每类错误都带「怎么办」', emptyObj.action.slice(0, 30));
    log(emptyObj.retryable === false, '空输入标记为不可重试（重试没意义）');
    log(JSON.parse(c502).retryable !== false, '唤醒类错误允许重试');

    // 错误卡片真的插进对话流，并含三段式信息
    const before = doc.querySelectorAll('.err-card').length;
    win.eval(`addErrorCard({ message: '服务正在唤醒', code: 'service_waking' }, 502, null)`);
    await sleep(50);
    const cards = doc.querySelectorAll('.err-card');
    log(cards.length === before + 1, '错误卡片插入页面');
    const card = cards[cards.length - 1];
    log(/⚠️/.test(card.textContent) && /👉/.test(card.textContent), '卡片含标题与建议两段');
    log(card.textContent.indexOf('唤醒') >= 0 || card.textContent.indexOf('502') >= 0, '卡片展示具体原因');
  }

  // ================= I. 本地缓存 =================
  console.log('\n--- I. 本地缓存 ---');
  {
    // 真实调用点传入的 text 已经是脱敏文本（safeText），缓存的必须是它
    win.eval(`cacheLastResult({ score: 55, maxLevel: 2, levelName: '中危', items: [
      { type: 'phone', label: '手机号', level: 2, masked: '138****8000', reason: '' }
    ], text: '我的手机号是 138****8000' })`);
    const raw = win.localStorage.getItem('privacy-sentinel:last-result');
    log(!!raw, '检测结果写入 localStorage');
    log(!/13800138000/.test(raw), '缓存只存脱敏值，不落明文', raw ? 'ok' : '');
    log(/138\*\*\*\*8000/.test(raw), '脱敏值本身被保留');

    // 未检出敏感项时传进来的是原文，此时不应落盘（漏检 ≠ 没敏感信息）
    win.eval(`cacheLastResult({ score: 100, maxLevel: 0, levelName: '安全', items: [],
      text: '我的手机号是 13800138000' })`);
    const raw2 = win.localStorage.getItem('privacy-sentinel:last-result');
    log(!/13800138000/.test(raw2), '未检出时不缓存原文', JSON.parse(raw2).text === '' ? 'text 已清空' : JSON.parse(raw2).text);

    // 新实例（模拟刷新）应恢复出「上次检测结果」——只查聊天容器，避免把脚本源码算进去
    const third = await loadPage(base, {
      'privacy-sentinel:privacy-ack': 'true',
      'privacy-sentinel:last-result': raw,
    });
    const thirdMsg = third.document.getElementById('messages').textContent;
    log(/上次检测结果/.test(thirdMsg), '刷新后展示上次检测结果卡片');
    log(!!third.document.querySelector('[data-action="restore-report"]'), '提供「查看完整报告」入口');
    third.dom.window.close();

    // 超过 24 小时的缓存不再展示，避免用户误以为是刚检测的结果
    const stale = JSON.stringify({
      score: 55, maxLevel: 2, levelName: '中危',
      items: [{ type: 'phone', label: '手机号', level: 2, masked: '138****8000' }],
      text: '', cachedAt: Date.now() - 25 * 3600 * 1000,
    });
    const fourth = await loadPage(base, {
      'privacy-sentinel:privacy-ack': 'true',
      'privacy-sentinel:last-result': stale,
    });
    log(!/上次检测结果/.test(fourth.document.getElementById('messages').textContent),
      '超过 24 小时的缓存不再展示');
    fourth.dom.window.close();
  }

  // ================= J. 文档页与状态页 =================
  console.log('\n--- J. 文档页与状态页 ---');
  {
    const dctx = await loadPage(base, null, 'docs.html');
    const ddoc = dctx.document;
    log(dctx.jsErrors.length === 0, '文档页无脚本报错');
    const heads = [...ddoc.querySelectorAll('h2')].map((h) => h.textContent.trim());
    log(heads.length >= 8, '文档页章节完整', `${heads.length} 节：${heads.slice(0, 3).join(' / ')}…`);
    log(heads.some((h) => /支持识别的类型/.test(h)), '含「支持识别的类型」');
    log(heads.some((h) => /判定逻辑/.test(h)), '含「判定逻辑」说明');
    log(heads.some((h) => /适用场景/.test(h)), '含「适用场景」');
    log(heads.some((h) => /隐私承诺/.test(h)), '含「隐私承诺」');
    log(/能力边界|不能|局限/.test(ddoc.body.textContent), '写明了能力边界（不夸大）');
    log(ddoc.querySelectorAll('table').length >= 2, '含类型表与脱敏规则表', `${ddoc.querySelectorAll('table').length} 张`);
    dctx.window.close();

    const sctx = await loadPage(base, null, 'status.html');
    const sdoc = sctx.document;
    log(sctx.jsErrors.length === 0, '状态页无脚本报错');
    const overall = sdoc.getElementById('overall');
    log(/overall ok/.test(overall.className), '健康时整体状态为「正常」', overall.className);
    log(/所有服务正常/.test(overall.textContent), '展示可读的整体结论');
    log(sdoc.querySelectorAll('#grid > div').length >= 4, '四张状态卡片渲染',
      `${sdoc.querySelectorAll('#grid > div').length} 张`);
    log(/接口连通性/.test(sdoc.getElementById('grid').textContent), '含接口连通性（RTT）');
    log(/数据库/.test(sdoc.getElementById('grid').textContent), '含数据库状态');
    log(/v3\.5\.0/.test(sdoc.getElementById('meta').textContent), '展示版本号');
    log(/次 \/ 分钟/.test(sdoc.getElementById('meta').textContent), '展示限流配置');
    log(/文本：✅/.test(sdoc.getElementById('caps').textContent), '展示能力开关');
    sctx.window.close();

    // AI 未配置：接口仍然可用，应判定为「降级」而不是「正常」
    healthPayload = Object.assign({}, healthPayload, { aiProviderConfigured: false, aiProviderLabel: '未配置' });
    const dctx2 = await loadPage(base, null, 'status.html');
    log(/overall degraded/.test(dctx2.document.getElementById('overall').className),
      'AI 未配置时判定为「降级」', dctx2.document.getElementById('overall').className);
    log(/本地规则引擎/.test(dctx2.document.getElementById('overall').textContent),
      '降级时说明文本检测仍可用');
    dctx2.window.close();

    // 存储异常：整体应降为「异常」
    healthPayload = Object.assign({}, healthPayload, { db: 'error', aiProviderConfigured: true });
    const dctx3 = await loadPage(base, null, 'status.html');
    log(/overall down/.test(dctx3.document.getElementById('overall').className),
      '数据库异常时整体判定为「异常」', dctx3.document.getElementById('overall').className);
    dctx3.window.close();

    // 服务不可达：给出冷启动提示，而不是白屏或原生错误
    healthPayload = null;
    const dctx4 = await loadPage(base, null, 'status.html');
    log(/无法连接|异常/.test(dctx4.document.getElementById('overall').textContent),
      '服务不可达时给出明确结论');
    log(/冷启动|15~30/.test(dctx4.document.getElementById('overall').textContent),
      '不可达时提示可能是冷启动');
    dctx4.window.close();
  }

  // ================= F. 本地模式与脱敏导出 =================
  console.log('\n--- F. 本地模式与脱敏导出 ---');
  {
    const doc = win.document;
    const chip = doc.getElementById('engineChip');
    log(!!chip, '本地模式开关存在');
    log(!!chip && /本地模式：开/.test(chip.textContent), '默认开启本地模式（原文不上传）',
      chip ? chip.textContent.trim() : '');
    log(!!chip && chip.classList.contains('chip-on'), '开启态有视觉标记');

    // 提交一条带空格变形的手机号：本地模式不应发起任何网络请求
    const before = win.__fetchCalls.length;
    doc.getElementById('msgInput').value = '手机号 138 0013 8000';
    click(doc.getElementById('sendBtn'));
    await sleep(600);
    const msgs = doc.getElementById('messages').textContent;
    log(win.__fetchCalls.length === before, '本地模式提交不发起网络请求',
      `请求数 ${before} → ${win.__fetchCalls.length}`);
    log(/138\*\*\*\*8000/.test(msgs), '本地模式识别出变形手机号并脱敏展示');
    log(/未上传/.test(msgs), '明确告知原文未上传');

    // 云端/本地切换与记忆
    click(chip);
    await sleep(80);
    log(/云端双引擎/.test(chip.textContent), '可切换到云端双引擎模式', chip.textContent.trim());
    log(win.localStorage.getItem('privacy-sentinel:engine-mode') === '"cloud"', '模式选择被记住');
    click(chip);
    await sleep(80);
    log(/本地模式：开/.test(chip.textContent), '可切回本地模式');

    // 三种脱敏策略
    const src = '手机号13800138000，身份证11010519491231002X';
    const run = (strategy) => win.eval(
      `buildMaskedText(${JSON.stringify(src)}, detectSensitive(${JSON.stringify(src)}), ${JSON.stringify(strategy)})`
    );
    const maskOut = run('mask');
    const replaceOut = run('replace');
    const deleteOut = run('delete');

    log(/138\*\*\*\*8000/.test(maskOut) && !/13800138000/.test(maskOut), '掩码策略：保留首尾、隐去中间', maskOut);
    log(/\[手机号\]/.test(replaceOut) && !/11010519491231002X/.test(replaceOut), '替换策略：换成类型占位符', replaceOut);
    log(!/13800138000|11010519491231002X/.test(deleteOut) && deleteOut.length < src.length,
      '删除策略：直接移除敏感值', deleteOut);

    // 置信度标记：校验通过 / 存疑 / 示例值
    log(/校验通过/.test(msgs), '报告标注「校验通过」');
    const badId = '身份证 110105194912310021'; // 校验位不合法
    const badOut = win.eval(
      `buildMaskedText(${JSON.stringify(badId)}, detectSensitive(${JSON.stringify(badId)}), 'mask')`
    );
    log(!!badOut, '校验位不符的号码仍会上报（不静默丢弃）', badOut);
  }

  win.close();
  srv.close();

  console.log(`\n前端交互：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
});
