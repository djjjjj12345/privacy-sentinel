/**
 * 隐私优先加固测试（v3.6）
 * ---------------------------------------------------------------
 * 针对「在线检测工具本身的隐私风险」与「正则为主的漏检」两类硬伤：
 *   A. 抗变形：零宽字符、全角字符、数字间分隔符；IP 的点号不能被折叠
 *   B. 双端同源：用浏览器方式加载引擎（vm + 全局桩），与 Node require 结果一致
 *   C. 位置回映射：start/end 指向原文，脱敏文本能按区间精确重建
 *   D. SSRF 守卫：私网 / 环回 / 云元数据 / 协议 / 超长 / 带账号密码
 *   E. HTTP 契约：内网图片地址被拦时返回 400 + invalid_url
 *
 * 全部离线可跑，不访问外网、不需要真实密钥。
 *
 * 用法：node scripts/test-v36-hardening.js
 */
'use strict';

process.env.RATE_LIMIT_PER_MINUTE = process.env.RATE_LIMIT_PER_MINUTE || '100000';

const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const express = require('express');

let pass = 0;
let fail = 0;
const log = (ok, name, info) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}${info ? '  ·  ' + info : ''}`);
};

const ROOT = path.join(__dirname, '..');
const localDetector = require(path.join(ROOT, 'services', 'localDetector'));
const { checkImageUrl, isPrivateIPv4 } = require(path.join(ROOT, 'services', 'urlGuard'));
const errors = require(path.join(ROOT, 'services', 'errors'));

const typesOf = (items) => items.map((i) => i.type).join(',');

// ================= A. 抗变形 =================
console.log('\n--- A. 抗变形 ---');
{
  const phone = '联系电话 138 0013 8000';
  const r1 = localDetector.detect(phone);
  log(r1.some((i) => i.type === 'phone' && i.raw === '13800138000'), '空格分隔的手机号能识别', typesOf(r1));

  const r2 = localDetector.detect('手机：138-0013-8000');
  log(r2.some((i) => i.type === 'phone'), '连字符分隔的手机号能识别', typesOf(r2));

  const r3 = localDetector.detect('号码１３８００１３８０００');
  log(r3.some((i) => i.type === 'phone' && i.raw === '13800138000'), '全角数字能识别', typesOf(r3));

  // 零宽字符（U+200B/U+200D）夹在号码中间
  const zero = '身份证 110105\u200b1949\u200d1231\u200b002X';
  const r4 = localDetector.detect(zero);
  log(r4.some((i) => i.type === 'id' && i.raw === '11010519491231002X'), '零宽字符插入后仍能识别身份证', typesOf(r4));

  const r5 = localDetector.detect('卡号 4111 1111 1111 1111');
  log(r5.some((i) => i.type === 'bankcard'), '分组空格的银行卡能识别', typesOf(r5));

  // 回归：点号不能折叠，否则 IP 会漏检
  const r6 = localDetector.detect('服务器 192.168.1.100 端口 22');
  log(r6.some((i) => i.type === 'ip' && i.raw === '192.168.1.100'), 'IP 点号不被折叠', typesOf(r6));

  // 回归：普通文本不能被粘连（会破坏上下文规则）
  const r7 = localDetector.detect('我的密码是 Abc2024xyz');
  log(r7.some((i) => i.type === 'password' && i.raw === 'Abc2024xyz'), '空格不被误折叠，上下文规则仍生效', typesOf(r7));

  const r8 = localDetector.detect('订单号 202503190000000123');
  log(r8.length === 0, '订单号仍不被误判为身份证');
}

// ================= B. 双端同源 =================
console.log('\n--- B. 浏览器加载与后端同源 ---');
{
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  let browserApi = null;
  try {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'services', 'schema.js'), 'utf8'), sandbox, { filename: 'schema.js' });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'services', 'localDetector.js'), 'utf8'), sandbox, { filename: 'localDetector.js' });
    browserApi = sandbox.PSLocal || (sandbox.window && sandbox.window.PSLocal) || null;
  } catch (e) {
    log(false, '引擎能在浏览器式全局环境里加载', e.message);
  }

  log(!!browserApi && typeof browserApi.detect === 'function', '浏览器端暴露 PSLocal.detect');
  log(!!(sandbox.PSSchema || (sandbox.window && sandbox.window.PSSchema)), '浏览器端暴露 PSSchema');

  // 关键：两端对同一语料必须给出同样的结论，否则前端本地模式会静默漏报
  const corpus = [
    '我叫张三，身份证11010519491231002X，手机号13800138000',
    '手机 138 0013 8000，邮箱 zhangsan@example.com',
    'key: sk-abcdefghijklmnop123456',
    '服务器 10.0.0.8，卡号 4111111111111111',
    '普通文本，没有任何敏感信息',
    '验证码是 883291，密码是 MyPass2024',
  ];
  let same = 0;
  const diff = [];
  for (const t of corpus) {
    const a = typesOf(localDetector.detect(t));
    const b = browserApi ? typesOf(browserApi.detect(t)) : '<无引擎>';
    if (a === b) same++;
    else diff.push(`「${t.slice(0, 12)}」后端=${a} 浏览器=${b}`);
  }
  log(same === corpus.length, '同一语料两端识别结果一致', diff[0] || `${corpus.length} 条`);

  // 浏览器端也必须保留校验位能力，否则测试值会被当成真号
  if (browserApi) {
    const bad = browserApi.detect('身份证 110105194912310021'); // 校验位错
    log(bad.length === 1 && bad[0].verified === false, '浏览器端保留校验位判定');
  }
}

// ================= C. 位置回映射 =================
console.log('\n--- C. 位置回映射与脱敏重建 ---');
{
  const text = '联系电话 138 0013 8000，身份证 11010519491231002X';
  const items = localDetector.detect(text);
  const phone = items.find((i) => i.type === 'phone');
  const id = items.find((i) => i.type === 'id');

  log(phone && Number.isInteger(phone.start) && Number.isInteger(phone.end), '条目带 start/end');
  log(phone && text.slice(phone.start, phone.end).replace(/[ \-_]/g, '') === phone.raw,
    '变形文本的区间能映射回原文', phone ? JSON.stringify(text.slice(phone.start, phone.end)) : '');
  log(id && text.slice(id.start, id.end) === id.raw, '无变形的区间原样对应');

  // 按区间重建脱敏文本（与前端 buildMaskedText 同算法）
  const spans = items.filter((i) => Number.isInteger(i.start)).sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const sp of spans) {
    out += text.slice(pos, sp.start) + sp.masked;
    pos = sp.end;
  }
  out += text.slice(pos);

  log(!/13800138000|11010519491231002X/.test(out), '重建后的文本不含任何原始敏感值', out.slice(0, 40));
  log(/138\*\*\*\*8000/.test(out), '掩码保留可辨认前后位');
}

// ================= D. SSRF 守卫 =================
console.log('\n--- D. SSRF 守卫 ---');
{
  const blocked = [
    'http://127.0.0.1/a.png',
    'http://localhost/a.png',
    'http://[::1]/a.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.8/a.png',
    'http://172.16.3.4/a.png',
    'http://192.168.1.10/a.png',
    'http://100.100.100.200/a.png',
    'http://metadata.google.internal/x',
    'http://user:pass@example.com/a.png',
    'file:///etc/passwd',
    'ftp://example.com/a.png',
    'not-a-url',
    'https://example.com/' + 'a'.repeat(2100),
  ];
  const leaked = blocked.filter((u) => checkImageUrl(u).ok);
  log(leaked.length === 0, '内网/环回/元数据/非 http 协议全部拦截', leaked[0] || `${blocked.length} 条`);

  const allowed = [
    'https://example.com/a.png',
    'http://img.example.org/pic.jpg?x=1',
    'data:image/png;base64,iVBORw0KGgo=',
  ];
  const rejected = allowed.filter((u) => !checkImageUrl(u).ok);
  log(rejected.length === 0, '公网地址与本地 data URL 正常放行', rejected[0] || `${allowed.length} 条`);

  log(isPrivateIPv4([192, 168, 1, 1]) && !isPrivateIPv4([8, 8, 8, 8]), '私网判定符合预期');

  const e = errors.get('invalid_url');
  log(e && e.http === 400 && !!e.action, '错误目录登记 invalid_url 并给出解决办法');
}

// ================= E. HTTP 契约 =================
console.log('\n--- E. HTTP 契约 ---');
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/analyze', require(path.join(ROOT, 'routes', 'analyze')));

const post = (port, payload) =>
  new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/analyze',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (err) { json = null; }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', () => resolve({ status: 0, json: null }));
    req.write(body);
    req.end();
  });

const srv = app.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;

  {
    const r = await post(port, { kind: 'image', image_url: 'http://127.0.0.1:8080/secret.png' });
    log(r.status === 400 && r.json && r.json.code === 'invalid_url', '内网图片地址请求被 400 拦截',
      `status=${r.status} code=${r.json && r.json.code}`);
    log(r.json && !!r.json.action, '拦截响应带解决办法，不是裸错误');
  }

  {
    // 本地模式：纯文本检测走本地引擎，不需要模型
    const r = await post(port, { kind: 'text', text: '手机号 138 0013 8000', mode: 'local' });
    log(r.status === 200 && r.json && r.json.success, '本地模式文本检测可用');
    log(r.json && r.json.items && r.json.items[0] && r.json.items[0].raw === '13800138000',
      '本地模式同样抗变形', r.json && r.json.items && r.json.items[0] && r.json.items[0].masked);
  }

  {
    const r = await post(port, { kind: 'text', text: 'x'.repeat(10) });
    log(r.json && r.json.items && r.json.items.length === 0, '普通文本不误报');
  }

  console.log('\n========================================');
  console.log(`  隐私优先加固：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
  console.log('========================================\n');

  srv.close();
  process.exit(fail > 0 ? 1 : 0);
});
