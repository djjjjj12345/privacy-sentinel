/**
 * 认证 + 云端历史 测试 — 全程本地，SQLite 指向临时文件，无外部依赖
 *
 * 用法：node scripts/test-auth-history.js
 * 输出格式：=== 认证/历史：X 通过 / Y 失败 / 共 Z ===（供 test-all.js 解析）
 */
'use strict';
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

// 独立临时库，避免污染本地 data/privacy-sentinel.db
process.env.SQLITE_PATH = path.join(os.tmpdir(), `ps-test-${Date.now()}.db`);

let pass = 0, fail = 0;
const log = (ok, name, info) => { ok ? pass++ : fail++; console.log(`${ok ? '✅' : '❌'} ${name}${info ? '  ·  ' + info : ''}`); };

const express = require('express');
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

const authRoutes = require(path.join(__dirname, '..', 'routes', 'auth'));
const historyRoutes = require(path.join(__dirname, '..', 'routes', 'history'));
app.use('/api/auth', authRoutes);
app.use('/api/history', historyRoutes);

const srv = app.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookieJar = '';

  const req = (method, url, body, useCookie = true) => new Promise((resolve) => {
    const headers = { 'Content-Type': 'application/json' };
    if (useCookie && cookieJar) headers['Cookie'] = cookieJar;
    const r = http.request(base + url, { method, headers }, (resp) => {
      let data = '';
      resp.on('data', (c) => data += c);
      resp.on('end', () => {
        const setCookie = resp.headers['set-cookie'];
        if (setCookie) {
          const sess = [].concat(setCookie).find((c) => c.startsWith('ps_session='));
          if (sess) {
            if (/ps_session=;/.test(sess) || /Max-Age=0/.test(sess)) cookieJar = '';
            else cookieJar = sess.split(';')[0];
          }
        }
        let json = null; try { json = JSON.parse(data); } catch (e) { /* 忽略 */ }
        resolve({ status: resp.statusCode, body: json, raw: data, setCookie });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: null, raw: e.message }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });

  try {
    // ---- 注册 ----
    let r = await req('POST', '/api/auth/register', { username: 'alice', password: 'hunter22' });
    log(r.status === 201 && r.body?.success === true, '注册成功返回 201', `user=${r.body?.user?.username}`);
    log(!!(r.setCookie || []).join('').match(/HttpOnly/i), '会话 Cookie 带 HttpOnly', (r.setCookie || [])[0] || '');
    log(!JSON.stringify(r.body).includes('hunter22'), '响应不泄露明文密码');

    r = await req('POST', '/api/auth/register', { username: 'alice', password: 'another99' }, false);
    log(r.status === 409, '重复用户名被 409 拒绝', `HTTP ${r.status}`);

    r = await req('POST', '/api/auth/register', { username: 'bob', password: '123' }, false);
    log(r.status === 400, '弱密码（<6 位）被 400 拒绝', r.body?.error || '');

    r = await req('POST', '/api/auth/register', { username: 'x!', password: 'longenough' }, false);
    log(r.status === 400, '非法用户名字符被 400 拒绝', r.body?.error || '');

    // ---- 登录 ----
    cookieJar = '';
    r = await req('POST', '/api/auth/login', { username: 'alice', password: 'wrong-pass' }, false);
    log(r.status === 401, '错误密码返回 401', `HTTP ${r.status}`);

    r = await req('POST', '/api/auth/login', { username: 'alice', password: 'hunter22' }, false);
    log(r.status === 200 && !!cookieJar, '正确密码登录并种下 Cookie', `cookie=${cookieJar ? 'yes' : 'no'}`);

    r = await req('GET', '/api/auth/me', null);
    log(r.status === 200 && r.body?.user?.username === 'alice', '/me 返回当前用户', `user=${r.body?.user?.username}`);

    // ---- 历史 CRUD ----
    r = await req('GET', '/api/history', null, false);
    log(r.status === 401, '未登录访问历史返回 401', `HTTP ${r.status}`);

    const entry = {
      level: 3, action: '已脱敏发送',
      content: '我的身份证是110105199003071239',
      detections: [{ label: '身份证号', value: '110105199003071239' }],
      time: '21:30', date: '2026/10/12',
    };
    r = await req('POST', '/api/history', entry);
    log(r.status === 201 && r.body?.id > 0, '添加历史返回条目 id', `id=${r.body?.id}`);

    await req('POST', '/api/history', { ...entry, level: 1, action: '自动脱敏' });
    await req('POST', '/api/history', { ...entry, level: 4, action: '已阻止发送' });

    r = await req('GET', '/api/history', null);
    log(r.status === 200 && r.body?.items?.length === 3, '历史列表返回 3 条', `${r.body?.items?.length} items`);
    log(r.body?.items?.[0]?.level === 4 && r.body?.items?.[0]?.detections?.[0]?.label === '身份证号',
      '按时间倒序 + detections 结构完整', `first.level=L${r.body?.items?.[0]?.level}`);
    log(!JSON.stringify(r.body).includes('hunter22') && !JSON.stringify(r.body).includes('pass_hash'),
      '历史响应不含密码字段');

    // 超长内容截断
    r = await req('POST', '/api/history', { level: 1, action: 'x', content: 'A'.repeat(5000), detections: [] });
    log(r.status === 201, '超长 content 被接受（入库前截断）', `HTTP ${r.status}`);

    // ---- 导入 ----
    r = await req('POST', '/api/history/import', { entries: [
      { level: 2, action: '备份条目A', content: 'a', detections: [], time: '10:00', date: '2026/10/01' },
      { level: 1, action: '备份条目B', content: 'b', detections: [], time: '10:01', date: '2026/10/01' },
    ] });
    log(r.status === 200 && r.body?.imported === 2, '批量导入 2 条备份', `imported=${r.body?.imported}`);

    r = await req('POST', '/api/history/import', { entries: [] });
    log(r.status === 400, '空导入被 400 拒绝', `HTTP ${r.status}`);

    // ---- 清空 + 登出 ----
    r = await req('DELETE', '/api/history', null);
    log(r.status === 200, '清空历史成功', `HTTP ${r.status}`);
    r = await req('GET', '/api/history', null);
    log(r.body?.items?.length === 0, '清空后列表为空');

    r = await req('POST', '/api/auth/logout', null);
    log(r.status === 200 && cookieJar === '', '登出并清 Cookie', `cookie=${cookieJar || '已清'}`);
    r = await req('GET', '/api/auth/me', null, false);
    log(r.status === 200 && r.body?.user === null, '登出后 /me 返回 user=null');

    // ---- 密码是 scrypt 哈希存储（直接查库验证） ----
    const db = require(path.join(__dirname, '..', 'services', 'db'));
    const row = db.prepare('SELECT pass_hash, pass_salt FROM users WHERE username = ?').get('alice');
    log(row && row.pass_hash !== 'hunter22' && row.pass_hash.length === 64 && row.pass_salt.length === 64,
      '数据库中密码为 64 位 scrypt 哈希 + 64 位盐', `hash=${row?.pass_hash?.slice(0, 8)}...`);

    console.log(`\n=== 认证/历史：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} ===`);
    srv.close();
    try { fs.unlinkSync(process.env.SQLITE_PATH); } catch (e) { /* 忽略 */ }
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('未捕获异常:', e);
    srv.close();
    process.exit(2);
  }
});
