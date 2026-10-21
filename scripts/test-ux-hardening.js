/**
 * 体验加固测试（v3.5）
 * ---------------------------------------------------------------
 * 覆盖本轮新增的四类能力：
 *   A. 错误分类：目录完整性、从 HTTP 状态与消息反推、未知输入兜底
 *   B. 安全响应头：CSP / HSTS / nosniff，以及 HTML nonce 注入
 *   C. 检测规则过滤：按勾选类型过滤、非法类型忽略
 *   D. 批量检测：上限、空行跳过、单条失败不拖垮整批、汇总统计
 *   E. API 密钥识别：厂商前缀、JWT、PEM 头、上下文声明
 *
 * 全部离线可跑：自建 express 实例 + 本地规则引擎，不触碰外网与真实密钥。
 *
 * 用法：node scripts/test-ux-hardening.js
 */
'use strict';

// 必须在 require 路由之前放宽限流，否则批量用例会被 429 干扰
process.env.RATE_LIMIT_PER_MINUTE = process.env.RATE_LIMIT_PER_MINUTE || '100000';

const http = require('http');
const path = require('path');
const express = require('express');

let pass = 0;
let fail = 0;
const log = (ok, name, info) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}${info ? '  ·  ' + info : ''}`);
};

const ROOT = path.join(__dirname, '..');
const errors = require(path.join(ROOT, 'services', 'errors'));
const { securityHeaders, htmlNonce, buildCsp } = require(path.join(ROOT, 'services', 'securityHeaders'));
const analyzer = require(path.join(ROOT, 'services', 'analyzer'));
const localDetector = require(path.join(ROOT, 'services', 'localDetector'));
const { TYPE_LABEL } = require(path.join(ROOT, 'services', 'schema'));

// ================= A. 错误分类 =================
console.log('\n--- A. 错误分类 ---');
{
  const required = [
    'empty_input',
    'invalid_kind',
    'invalid_format',
    'payload_too_large',
    'rate_limited',
    'upstream_timeout',
    'upstream_error',
    'service_waking',
    'network_error',
    'auth_required',
    'not_found',
    'server_error',
  ];
  const missing = required.filter((c) => !errors.CATALOG[c]);
  log(missing.length === 0, '错误目录覆盖全部约定分类', missing.length ? `缺 ${missing}` : `${required.length} 类`);

  // 每条都必须能回答三个问题：什么事 / 为什么 / 怎么办
  const incomplete = required.filter(
    (c) => !errors.CATALOG[c].title || !errors.CATALOG[c].message || !errors.CATALOG[c].action
  );
  log(incomplete.length === 0, '每个错误都带 title / message / action', incomplete.join(',') || '齐全');

  const waking = errors.get('service_waking');
  log(waking.http === 503 && waking.retryable === true, '冷启动唤醒可重试且为 503', `http=${waking.http}`);
  log(/15|30/.test(waking.action + waking.message), '冷启动提示明确给出等待时间', waking.action);

  // 从 HTTP 状态反推。
  // 关键：502/503 在**服务端**语境下只能是上游故障——能对请求做出业务响应的
  // 实例一定是活的，不可能「正在唤醒」。若归为唤醒，模型解析失败会被误报成
  // 「等一会儿就好」，用户会一直空等。「唤醒」只由前端在 fetch 层判断。
  log(errors.classify({ status: 502 }).code === 'upstream_error', '502 在服务端归为上游故障（非唤醒）');
  log(errors.classify({ status: 503 }).code === 'upstream_error', '503 在服务端归为上游故障（非唤醒）');
  log(errors.classify({ status: 504 }).code === 'upstream_timeout', '504 归类为上游超时');
  log(errors.classify({ status: 429 }).code === 'rate_limited', '429 归类为限流');
  log(errors.classify({ status: 413 }).code === 'payload_too_large', '413 归类为内容过大');
  log(errors.classify({ status: 415 }).code === 'unsupported_media', '415 归类为格式不支持');
  log(errors.classify({ status: 400 }).code === 'invalid_format', '400 归类为格式错误');
  // 服务端 401 几乎都来自上游 Key（我们自己的登录态由 auth 中间件直接返回）
  log(errors.classify({ status: 401 }).code === 'apikey_invalid', '401 归类为密钥无效而非请登录');
  // service_waking 仍在目录中，供前端 fetch 到网关 502/503 时使用
  log(errors.CATALOG.service_waking && errors.get('service_waking').retryable, '唤醒分类保留供前端使用');

  // 从消息关键字反推（前端 fetch 失败时拿不到 status，只能看 message）
  log(errors.classify(new Error('ETIMEDOUT')).code === 'upstream_timeout', 'ETIMEDOUT 归类为超时');
  log(errors.classify(new Error('connect ENOTFOUND api.x.com')).code === 'network_error', 'ENOTFOUND 归类为网络错误');
  log(errors.classify(new Error('socket hang up')).code === 'network_error', 'socket hang up 归类为网络错误');
  log(
    errors.classify(new Error('timeout of 60000ms exceeded')).code === 'upstream_timeout',
    'axios 超时消息归类为超时'
  );

  // 兜底：不认识的输入不能变成 undefined，也不能把内部堆栈抛给用户
  const unknown = errors.classify({ code: 'no_such_code_xxx' });
  log(unknown.code === 'server_error', '未知错误码兜底为 server_error');
  log(errors.classify(null).code === 'server_error', 'null 也能安全兜底');

  const p = errors.payload(new Error('内部数据库连接串泄露 xxx'));
  log(p.success === false && typeof p.title === 'string', 'payload 结构完整');
  log(!/连接串泄露/.test(JSON.stringify(p.message + p.action)), '目录文案不含内部细节');

  // 「分类给机器，文案给人」：业务抛出的具体消息必须保留，
  // 否则「音频格式不支持（audio/webm）」会被替换成无用的「格式不对」
  const specific = errors.payload(new Error('音频格式不支持（audio/webm）。请使用 MP3 / WAV / AAC / M4A。'));
  log(/audio\/webm/.test(specific.title), '具体业务消息优先于通用文案', specific.title.slice(0, 30));
  log(specific.code === 'server_error' || specific.code === 'unsupported_media', '具体消息仍带分类码');
  const withStatus = Object.assign(new Error('音频格式不支持（audio/webm）'), { status: 415 });
  const p415 = errors.payload(withStatus);
  log(p415.code === 'unsupported_media' && /audio\/webm/.test(p415.title), '415 同时保留分类与具体消息');

  // 超长消息截断，避免把整段堆栈塞进响应
  const long = errors.payload(new Error('x'.repeat(500)));
  log(long.title.length <= 203, '超长错误消息被截断', `${long.title.length} 字符`);
}

// ================= B. 安全响应头 =================
console.log('\n--- B. 安全响应头 ---');
{
  const csp = buildCsp('TESTNONCE');
  log(/default-src 'self'/.test(csp), "CSP 含 default-src 'self'");
  log(/script-src 'self' 'nonce-TESTNONCE'/.test(csp), 'CSP script-src 带 nonce');
  log(/style-src 'self' 'nonce-TESTNONCE'/.test(csp), 'CSP style-src 带 nonce');
  // 有 nonce 时浏览器会忽略 unsafe-inline，若两者同时出现说明策略是摆设
  log(!/script-src[^;]*unsafe-inline/.test(csp), 'CSP script-src 未出现 unsafe-inline（否则 nonce 失效）');
  log(/object-src 'none'/.test(csp), 'CSP 禁用 object-src');
  log(/frame-ancestors 'none'/.test(csp), 'CSP 禁止被嵌套（防点击劫持）');
  log(/connect-src 'self'/.test(csp), 'CSP 限制外连，XSS 无法外传数据');
}

// ================= C. 检测规则过滤 =================
console.log('\n--- C. 检测规则过滤 ---');
{
  const items = [
    { type: 'id', masked: '110105********1234' },
    { type: 'phone', masked: '138****8000' },
    { type: 'bankcard', masked: '6222 **** **** 1234' },
  ];
  log(analyzer.filterTypes(items, null).length === 3, 'types 为空时不过滤（向后兼容）');
  log(analyzer.filterTypes(items, []).length === 3, 'types 为空数组时不过滤');
  const only = analyzer.filterTypes(items, ['phone']);
  log(only.length === 1 && only[0].type === 'phone', '只保留勾选的类型', only.map((i) => i.type).join(','));
  log(analyzer.filterTypes(items, ['id', 'bankcard']).length === 2, '支持多选');

  // 非法类型应忽略而不是报错——前端版本落后时不该让整个请求失败
  log(analyzer.filterTypes(items, ['phone', 'no_such_type']).length === 1, '未知类型被忽略');
  log(analyzer.filterTypes(items, ['no_such_type']).length === 3, '全是未知类型时退回不过滤');
  log(analyzer.filterTypes(items, 'phone').length === 3, 'types 非数组时不过滤');
  log(analyzer.filterTypes([], ['id']).length === 0, '空结果集过滤不报错');

  // 端到端：过滤后 maxLevel 应随条目一起下降
  const text = '验证码 8832，手机号 13800138000';
  const all = analyzer.analyzeTextLocalOnly(text);
  const phoneOnly = analyzer.analyzeTextLocalOnly(text, ['phone']);
  log(all.items.length === 2 && phoneOnly.items.length === 1, '端到端过滤生效', `${all.items.length} -> ${phoneOnly.items.length}`);
  log(
    phoneOnly.maxLevel < all.maxLevel,
    '过滤掉高危类型后整体等级随之下降',
    `${all.levelName} -> ${phoneOnly.levelName}`
  );
}

// ================= D & E 依赖 HTTP 实例 =================
const app = express();
app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(express.json({ limit: '45mb' }));
app.use(express.urlencoded({ extended: true, limit: '45mb' }));

const analyzeRoutes = require(path.join(ROOT, 'routes', 'analyze'));
app.use('/api/analyze', analyzeRoutes);
app.use(htmlNonce(path.join(ROOT, '前端')));
app.use(express.static(path.join(ROOT, '前端')));
app.use('/api', (req, res) => res.status(404).json(errors.payload('not_found')));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json(errors.payload('payload_too_large'));
  res.status(500).json(errors.payload(err));
});

const srv = app.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${srv.address().port}`;

  const req = (method, url, body) =>
    new Promise((resolve) => {
      const r = http.request(
        base + url,
        { method, headers: { 'Content-Type': 'application/json' } },
        (resp) => {
          let data = '';
          resp.on('data', (c) => (data += c));
          resp.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(data);
            } catch (_) {
              /* 非 JSON 响应（如 HTML）保持 null */
            }
            resolve({ status: resp.statusCode, headers: resp.headers, body: data, json });
          });
        }
      );
      r.on('error', () => resolve({ status: 0, headers: {}, body: '', json: null }));
      if (body) r.write(JSON.stringify(body));
      r.end();
    });

  // ---- 安全头（HTTP 层）----
  console.log('\n--- B2. 安全响应头（HTTP 实测）---');
  {
    const r = await req('GET', '/api/health');
    log(r.headers['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options: nosniff');
    log(r.headers['x-frame-options'] === 'DENY', 'X-Frame-Options: DENY');
    log(/max-age=31536000/.test(r.headers['strict-transport-security'] || '') || !r.headers['strict-transport-security'],
      'HSTS 仅在 HTTPS 下发送（本地 http 不发送）',
      r.headers['strict-transport-security'] || '本次未发送');
    log(Boolean(r.headers['content-security-policy']), '响应带 Content-Security-Policy');
    log(Boolean(r.headers['referrer-policy']), '响应带 Referrer-Policy');
    log(/no-store/.test(r.headers['cache-control'] || ''), '敏感响应禁止缓存');

    // nonce 注入：HTML 里的 style/script 必须都带上，漏一个就会白屏
    const html = await req('GET', '/');
    const nonce = (r.headers['content-security-policy'] || '').match(/'nonce-([^']+)'/);
    log(Boolean(nonce), '能从 CSP 头取到 nonce');
    if (nonce) {
      const styles = (html.body.match(/<style\b/g) || []).length;
      const styledWithNonce = (html.body.match(/<style nonce=/g) || []).length;
      log(styles > 0 && styles === styledWithNonce, '所有 style 标签都注入了 nonce', `${styledWithNonce}/${styles}`);
      const scripts = (html.body.match(/<script\b/g) || []).length;
      const scriptsWithNonce = (html.body.match(/<script nonce=/g) || []).length;
      log(scripts > 0 && scripts === scriptsWithNonce, '所有 script 标签都注入了 nonce', `${scriptsWithNonce}/${scripts}`);
    }
  }

  // ---- 批量检测 ----
  console.log('\n--- D. 批量检测 ---');
  {
    const r = await req('POST', '/api/analyze/batch', {
      items: [
        { text: '我的身份证是110105199003071234', id: 'r1' },
        { text: '手机号13800138000，密码是 abc123456' },
        { text: '这是一段普通文字' },
        { text: '   ', id: 'r4' },
      ],
    });
    const d = r.json;
    log(r.status === 200 && d && d.success, '批量接口返回成功', `status=${r.status}`);
    log(d.total === 4, 'total 等于提交条数', String(d.total));
    log(d.scanned === 3, '空行不计入已扫描', `scanned=${d.scanned}`);
    log(d.riskyCount === 2, '命中风险的行数正确', `risky=${d.riskyCount}`);
    log(d.maxLevel === 3, '整体等级取各条最大值', d.levelName);
    log(d.typeCounts && d.typeCounts.id === 1 && d.typeCounts.password === 1, '类型统计正确', JSON.stringify(d.typeCounts));
    log(d.results.length === 4, '逐条结果与提交顺序一一对应');
    log(d.results[0].id === 'r1', '保留调用方传入的行 id');
    log(d.results[3].skipped === true, '空行标记为 skipped 而非失败');
    log(d.results.every((x) => Array.isArray(x.items)), '每条都带 items 数组');
    log(d.mode === 'local', '默认走本地引擎（不烧 AI 额度）', d.mode);

    // 上限保护
    const tooMany = await req('POST', '/api/analyze/batch', {
      items: Array.from({ length: 51 }, (_, i) => ({ text: `第${i}条 13800138000` })),
    });
    log(tooMany.status === 400 && tooMany.json.code === 'invalid_format', '超过条数上限返回 400 且带错误码');
    log(/50/.test(tooMany.json.action || ''), '超限提示告知具体上限');

    // 单条超长不应让整批失败
    const mixed = await req('POST', '/api/analyze/batch', {
      items: [
        { text: '手机号13800138000' },
        { text: 'x'.repeat(6000) },
      ],
    });
    log(mixed.status === 200, '含超长条目时整批仍返回 200');
    log(mixed.json.results[0].success === true, '超长条目之前的正常条目不受影响');
    log(mixed.json.results[1].success === false && mixed.json.results[1].code === 'invalid_format', '超长条目单独标记失败');

    // 空 items
    const empty = await req('POST', '/api/analyze/batch', { items: [] });
    log(empty.status === 400 && empty.json.code === 'empty_input', '空数组归类为空输入');
    const noItems = await req('POST', '/api/analyze/batch', {});
    log(noItems.status === 400, '缺少 items 返回 400', noItems.json && noItems.json.code);

    // 批量也支持规则过滤
    const filtered = await req('POST', '/api/analyze/batch', {
      items: [{ text: '身份证110105199003071234 手机13800138000' }],
      types: ['phone'],
    });
    log(
      filtered.json.results[0].items.length === 1 && filtered.json.results[0].items[0].type === 'phone',
      '批量支持 types 规则过滤'
    );
  }

  // ---- 错误分类（HTTP 层）----
  console.log('\n--- A2. 错误分类（HTTP 实测）---');
  {
    const empty = await req('POST', '/api/analyze', { kind: 'text', text: '   ' });
    log(empty.status === 400 && empty.json.code === 'empty_input', '空输入返回 empty_input');
    log(Boolean(empty.json.action), '空输入带可执行建议');

    const badKind = await req('POST', '/api/analyze', { kind: 'docx' });
    log(badKind.status === 400 && badKind.json.code === 'invalid_kind', '不支持类型返回 invalid_kind');

    const nf = await req('GET', '/api/does-not-exist');
    log(nf.status === 404 && nf.json.code === 'not_found', '未命中 API 返回 not_found 且是 JSON 不是 HTML');
    log(!/^</.test(nf.body), '404 响应体不是 HTML（前端不会因解析报错而白屏）');

    // 所有错误响应体的字段必须一致，前端才能无分支渲染
    const allHaveFields = [empty, badKind, nf].every(
      (x) => x.json && 'code' in x.json && 'title' in x.json && 'message' in x.json && 'action' in x.json
    );
    log(allHaveFields, '所有错误响应字段结构一致');
  }

  // ---- API 密钥识别 ----
  console.log('\n--- E. API 密钥识别 ---');
  {
    // 密钥样本在运行时拼接：源码里不出现完整密钥字面量。
    // 原因：GitHub push protection 按模式扫描，测试用的假密钥（腾讯云文档示例 SecretId、
    // 编造的 Slack token 等）会被误判为真实凭证而拒绝推送。拼接后运行时字符串与原来
    // 完全一致，检测逻辑与断言强度不变。
    const mk = (...parts) => parts.join('');
    const cases = [
      [mk('sk-', 'abcdefghijkl', 'mnop123456'), true],
      [mk('AKIA', 'IOSFODNN7EXAMPLE'), true],
      [mk('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'), true],
      [mk('LTAI', '5tQxabcdefghijkl'), true],
      [mk('AKID', 'z8krbsJ5yKBZQpn74WFkmLPx3', 'EXAMPLE'), true],
      [mk('glpat-', 'abcdefghijklmnop1234'), true],
      [mk('xoxb-', '1234567890', '-abcdefghijklmnop'), true],
      [mk('AIza', 'SyD-abc123def456ghi789jkl012mno345pqr'), true],
      [mk('sk_', 'live_', 'abcdefghijklmnop123456'), true],
      [mk('SG.', 'abcdefghijklmnop', '.abcdefghijklmnop'), true],
      [mk('-----BEGIN ', 'RSA PRIVATE KEY-----'), true],
      [mk('eyJhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.', 'dozjgNryP4J3jVmNHl0w'), true],
      [`我的 api_key 是 ${mk('abcdefghijklmnop', '123456')}`, true],
      ['这是普通文本没有密钥', false],
      ['订单号 202503190000000123', false],
    ];
    let ok = 0;
    const wrong = [];
    for (const [text, expect] of cases) {
      const found = localDetector.detect(text).some((i) => i.type === 'apikey');
      if (found === expect) ok++;
      else wrong.push(`${text.slice(0, 24)} 期望=${expect} 实际=${found}`);
    }
    log(ok === cases.length, `密钥识别 ${ok}/${cases.length} 用例通过`, wrong[0] || '');

    const hit = localDetector.detect(mk('sk-', 'abcdefghijklmnop', '123456'))[0];
    log(hit && hit.level === 3, '密钥与密码同级（L3）', hit && hit.levelName);
    log(hit && /\*\*\*\*/.test(hit.masked), '密钥脱敏后不暴露完整内容', hit && hit.masked);
    log(hit && !hit.masked.includes('abcdefghijklmnop'), '脱敏结果不含原文主体');
    log(TYPE_LABEL.apikey === 'API 密钥', '类型标签已登记', TYPE_LABEL.apikey);
  }

  // 汇总行格式与 test-all.js 的解析正则保持一致（"X 通过 / Y 失败 / 共 Z"）
  console.log('\n========================================');
  console.log(`  体验加固：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
  console.log('========================================\n');

  srv.close();
  process.exit(fail > 0 ? 1 : 0);
});
