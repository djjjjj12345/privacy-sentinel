/**
 * 华为云适配专项测试（v3.3）
 * ---------------------------------------------------------------
 * 覆盖：
 *   A. provider 路由（默认 ark / 切 huawei / 未知回退）
 *   B. 华为云 MaaS 请求体（端点拼接、鉴权头、图片/文本消息结构、别名解析）
 *   C. 错误翻译（401 提示看 HW_MAAS_API_KEY、缺 BASE_URL 的指引）
 *   D. 能力降级（音视频回退 ark；无回退时 501 而不是假成功）
 *   E. 存储层（SQLite 异步 CRUD：用户 / 会话 / 历史裁剪）
 *   F. Redis 与限流（未配置时降级、内存计数触发 429、limit=0 放行）
 *   G. 兼容门面（visionAnalyzer 旧导出仍然可用）
 *
 * 全程 mock axios，不产生真实网络请求，不依赖任何云资源。
 * 用法：node scripts/test-huawei-cloud.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// —— 环境必须在 require 业务模块之前设置 ——
process.env.SQLITE_PATH = path.join(os.tmpdir(), `ps-hw-${Date.now()}.db`);
process.env.ARK_API_KEY = 'ark-test-key';
process.env.AI_PROVIDER = 'ark';
process.env.HW_MAAS_BASE_URL = 'https://maas.example.com/v1';
process.env.HW_MAAS_API_KEY = 'hw-test-key';
process.env.HW_VISION_MODEL = 'Qwen2.5-VL-7B-Instruct';
process.env.HW_TEXT_MODEL = 'DeepSeek-V4.1-Flash';
process.env.HW_MAAS_AUTH = 'bearer';
delete process.env.REDIS_URL;
delete process.env.AI_FALLBACK_PROVIDER;

let pass = 0;
let fail = 0;
const log = (ok, name, info) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}${info ? '  ·  ' + info : ''}`);
};

// —— axios mock ——
const axios = require('axios');
const realPost = axios.post;
let calls = [];
let stubMode = 'good';

function chatOk(payload) {
  return {
    status: 200,
    data: {
      id: 'mock-chat-1',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(payload) } }],
    },
  };
}

axios.post = async (url, body, opts = {}) => {
  const call = { url, body, headers: (opts && opts.headers) || {} };
  calls.push(call);
  const serialized = JSON.stringify(body);

  if (stubMode === '401') {
    return { status: 401, data: { error: { message: 'invalid api key' } } };
  }
  if (stubMode === 'notjson') {
    return { status: 200, data: { id: 'mock-2', choices: [{ message: { content: '抱歉，我无法处理这段内容。' } }] } };
  }
  if (serialized.includes('"input_audio"')) {
    return chatOk({ hasSensitive: true, items: [{ type: 'phone', raw: '13800138000' }] });
  }
  // 图片/文本统一返回别名键 sensitiveItems，验证字段容错
  return chatOk({
    hasSensitive: true,
    sensitiveItems: [{ type: 'id', raw: '110105199003071239' }],
    advice: '不要发送身份证号',
    summary: '检测到身份证号',
  });
};

const providers = require('../services/providers');
const huawei = providers.getProvider('huawei');
const store = require('../services/store');
const redis = require('../services/redis');
const { createRateLimiter } = require('../services/rateLimiter');
const vision = require('../services/visionAnalyzer');

const lastCall = () => calls[calls.length - 1] || {};

function mkRes() {
  return {
    headers: {},
    statusCode: 200,
    payload: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.payload = b; return this; },
  };
}

(async () => {
  // ================= A. provider 路由 =================
  process.env.AI_PROVIDER = 'ark';
  log(providers.getProvider().name === 'ark', '默认通道是 ark（不改变线上行为）', providers.getProvider().label);

  process.env.AI_PROVIDER = 'huawei';
  log(providers.getProvider().name === 'huawei', 'AI_PROVIDER=huawei 时切到华为云', providers.getProvider().label);

  process.env.AI_PROVIDER = 'not-exist';
  log(providers.getProvider().name === 'ark', '未知供应商自动回退 ark，不崩溃');

  log(
    huawei.capabilities.text === true && huawei.capabilities.image === true &&
    huawei.capabilities.audio === false && huawei.capabilities.video === false,
    '华为云能力声明：文本/图片 true，音视频 false（如实声明的关键）'
  );

  log(huawei.isConfigured() === true, 'HW_MAAS_BASE_URL + API Key 齐全时视为已配置');

  // ================= B. 华为云请求体 =================
  process.env.AI_PROVIDER = 'huawei';
  log(
    huawei.chatEndpoint() === 'https://maas.example.com/v1/chat/completions',
    '端点拼接：base 以 /v1 结尾时补 /chat/completions',
    huawei.chatEndpoint()
  );

  process.env.HW_MAAS_BASE_URL = 'https://maas.example.com/v1/chat/completions';
  log(huawei.chatEndpoint().endsWith('/chat/completions') && !huawei.chatEndpoint().includes('/chat/completions/chat'),
    '控制台直接给完整地址时不会重复拼接');
  process.env.HW_MAAS_BASE_URL = 'https://maas.example.com/v1';

  calls = [];
  process.env.HW_MAAS_AUTH = 'bearer';
  await huawei.analyzeText('我的身份证是 110105199003071239');
  log(lastCall().headers.Authorization === 'Bearer hw-test-key', '默认用 Bearer 鉴权');

  calls = [];
  process.env.HW_MAAS_AUTH = 'apig';
  await huawei.analyzeText('测试 apig 鉴权');
  log(lastCall().headers['X-Apig-AppCode'] === 'hw-test-key', 'HW_MAAS_AUTH=apig 时改用 X-Apig-AppCode');
  process.env.HW_MAAS_AUTH = 'bearer';

  calls = [];
  await huawei.analyzeImage('data:image/png;base64,AAAA');
  const imgBody = lastCall().body;
  const userParts = imgBody.messages[1].content;
  log(
    Array.isArray(userParts) &&
    userParts.some((p) => p.type === 'image_url' && p.image_url && p.image_url.url.startsWith('data:image/png')),
    '图片走 OpenAI 兼容 image_url 入参'
  );
  log(/JSON/.test(imgBody.messages[0].content) && /json/i.test(imgBody.messages[0].content),
    'system prompt 完整注入（不是只发用户消息）');

  calls = [];
  await huawei.analyzeText('银行卡 6222020200112233445');
  const txtBody = lastCall().body;
  log(txtBody.messages[0].role === 'system' && typeof txtBody.messages[1].content === 'string' &&
      txtBody.messages[1].content.includes('6222020200112233445'),
    '文本走 system + user 两段消息，原文完整带上');

  const parsedResult = await huawei.analyzeText('再测一次别名解析');
  log(parsedResult.ok === true && parsedResult.items.length === 1 &&
      parsedResult.items[0].label === '身份证号',
    '模型用 sensitiveItems 别名也能解析成标准条目', `items=${parsedResult.items.length}`);

  // ================= C. 错误翻译 =================
  calls = [];
  stubMode = '401';
  let err401 = null;
  try { await huawei.analyzeText('触发 401'); } catch (e) { err401 = e; }
  stubMode = 'good';
  log(err401 && err401.status === 401 && err401.message.includes('HW_MAAS_API_KEY'),
    '401 提示指向 HW_MAAS_API_KEY（而不是误导去查方舟 Key）', err401 && err401.message.slice(0, 60));

  const savedBase = process.env.HW_MAAS_BASE_URL;
  delete process.env.HW_MAAS_BASE_URL;
  let errBase = null;
  try { huawei.chatEndpoint(); } catch (e) { errBase = e; }
  process.env.HW_MAAS_BASE_URL = savedBase;
  log(errBase && errBase.status === 500 && errBase.message.includes('HW_MAAS_BASE_URL'),
    '缺 BASE_URL 时给出可执行的配置指引');

  calls = [];
  stubMode = 'notjson';
  const notJson = await huawei.analyzeText('模型不吐 JSON');
  stubMode = 'good';
  log(notJson.ok === false && notJson.reason === 'model_output_not_json',
    '模型不吐 JSON 时返回结构化失败，交给本地规则兜底');

  // ================= D. 能力降级 =================
  delete process.env.AI_FALLBACK_PROVIDER;
  calls = [];
  const audioFallback = await providers.analyzeAudio('data:audio/wav;base64,AAAA');
  const usedArkChat = calls.some((c) => JSON.stringify(c.body).includes('"input_audio"'));
  log(audioFallback.ok === true && audioFallback.items.length === 1 && usedArkChat,
    '音频请求自动回退到 ark，检测能力不中断', `items=${audioFallback.items.length}`);

  process.env.AI_FALLBACK_PROVIDER = '';
  const savedArkKey = process.env.ARK_API_KEY;
  delete process.env.ARK_API_KEY;
  let errNoFb = null;
  try { await providers.analyzeAudio('data:audio/wav;base64,AAAA'); } catch (e) { errNoFb = e; }
  process.env.ARK_API_KEY = savedArkKey;
  process.env.AI_FALLBACK_PROVIDER = '';
  log(errNoFb && errNoFb.status === 501 && errNoFb.message.includes('SIS'),
    '没有可用回退时明确报 501 并指向 SIS 方案（不假装成功）');
  delete process.env.AI_FALLBACK_PROVIDER;

  // ================= E. 存储层 =================
  log(store.driver === 'sqlite', '未设置 DB_DRIVER 时使用 SQLite（本地/Render 不受影响）', store.label);

  const u = await store.createUser('huawei_tester', 'hash-64', 'salt-64');
  log(u && u.id > 0, '创建用户返回自增 id', `id=${u.id}`);

  let dupErr = null;
  try { await store.createUser('huawei_tester', 'h2', 's2'); } catch (e) { dupErr = e; }
  log(dupErr && /UNIQUE|Duplicate/i.test(dupErr.message), '重复用户名被唯一约束拒绝');

  const found = await store.findUserByUsername('huawei_tester');
  log(found && found.username === 'huawei_tester', '按用户名查回用户');

  await store.createSession('tok-abc', u.id, Date.now() + 60000);
  const sessUser = await store.findUserBySession('tok-abc', Date.now());
  log(sessUser && Number(sessUser.id) === Number(u.id), '会话可关联回用户');

  const expired = await store.findUserBySession('tok-abc', Date.now() + 120000);
  log(expired === null, '过期会话不再返回用户');

  const mk = (level, action) => ({
    level, action, content: 'c', detections: '[]', time: '21:00', date: '2026/10/18',
  });
  await store.addHistory(u.id, mk(1, 'A'));
  await store.addHistory(u.id, mk(2, 'B'));
  await store.addHistory(u.id, mk(3, 'C'));
  const list3 = await store.listHistory(u.id, 50);
  log(list3.length === 3 && Number(list3[0].level) === 3, '历史按 id 倒序返回', `${list3.length} 条`);

  await store.trimHistory(u.id, 2);
  const list2 = await store.listHistory(u.id, 50);
  log(list2.length === 2, '超出上限自动裁剪到 2 条', `${list2.length} 条`);

  await store.clearHistory(u.id);
  const list0 = await store.listHistory(u.id, 50);
  log(list0.length === 0, '清空历史生效');

  // ================= F. Redis 与限流 =================
  log(redis.status() === 'disabled', '未配置 REDIS_URL 时 Redis 状态为 disabled（自动降级）', redis.status());

  const limiter = createRateLimiter({ limit: 2, windowMs: 60000, prefix: 'ps:test' });
  const req = { ip: '10.0.0.9', headers: {} };
  let nextCount = 0;
  const next = () => { nextCount++; };
  const res1 = mkRes(); await limiter(req, res1, next);
  const res2 = mkRes(); await limiter(req, res2, next);
  const res3 = mkRes(); await limiter(req, res3, next);
  log(nextCount === 2 && res3.statusCode === 429, '内存兜底限流：第 3 次触发 429', `${res3.statusCode}`);

  const bypass = createRateLimiter({ limit: 0, windowMs: 60000 });
  let bypassNext = false;
  await bypass({ ip: '10.0.0.10', headers: {} }, mkRes(), () => { bypassNext = true; });
  log(bypassNext === true, 'RATE_LIMIT_PER_MINUTE=0 时放行（可关闭限流）');

  // ================= G. 兼容门面 =================
  log(vision.extractJson('```json\n{"items":[]}\n```') !== null,
    'visionAnalyzer 旧导出 extractJson 仍可用（老测试不回归）');
  process.env.AI_PROVIDER = 'ark';
  log(vision.providerInfo().provider === 'ark', '健康检查可读到当前供应商');

  // ================= 收尾 =================
  axios.post = realPost;
  try { await store.close(); } catch (e) { /* 忽略 */ }
  try { fs.unlinkSync(process.env.SQLITE_PATH); } catch (e) { /* 忽略 */ }

  console.log(`\n=== 华为云适配：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  axios.post = realPost;
  console.error('未捕获异常:', e);
  process.exit(2);
});
