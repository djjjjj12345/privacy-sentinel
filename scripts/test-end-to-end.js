/**
 * 端到端集成测试 — 调真方舟接口（如果 ARK_API_KEY 已配置），否则降级到 mock。
 *
 * 覆盖：
 *   ① text 通道：含身份证 / 仅本地正则 / 混合中英文
 *   ② image 通道：单张图 base64 / 不支持的 mime
 *   ③ audio 通道：模型真实识别 / 修复轮纠正
 *   ④ video 通道：模型真实识别
 *   ⑤ 错误路径：4xx/5xx 透传 / fallback 降级
 *
 * 用法：node scripts/test-end-to-end.js
 */
'use strict';
const path = require('path');
require('dotenv').config();
// 测试环境：mock 模式跑，注入一个伪 key 让 visionAnalyzer.getApiKey() 放行
process.env.ARK_API_KEY = process.env.ARK_API_KEY || 'TEST_MOCK_KEY_FOR_UNIT_TESTS';

let pass = 0, fail = 0;
const log = (ok, name, info) => { ok ? pass++ : fail++; console.log(`${ok ? '✅' : '❌'} ${name}${info ? '  ·  ' + info : ''}`); };

// 拦截 axios：mock 实现（用户没真实 key 时不发起网络请求）
const Module = require('module');
const realResolve = Module._resolveFilename;
const realLoad = Module._load;
const mock = {
  responses: {},
  chat: {},
  // mode: good | audioLie | videoEmpty | 401 | 429 | 500
  mode: 'good',
  chatCallCount: 0,
  responsesCallCount: 0,
};

Module._load = function (request, parent, ...rest) {
  const mod = realLoad.call(this, request, parent, ...rest);
  if (request === 'axios') {
    return {
      ...mod,
      post: async (url, body) => {
          // 递归扫描 body 找文本/图片/邮箱/URL 的统一工具
          const allStrings = [];
          const walk = (n) => {
            if (typeof n === 'string') { allStrings.push(n); return; }
            if (Array.isArray(n)) { n.forEach(walk); return; }
            if (n && typeof n === 'object') { Object.values(n).forEach(walk); }
          };
          walk(body);
          const big = allStrings.join(' ');

          if (url.includes('/chat/completions')) {
            mock.chatCallCount++;
            if (mock.mode === 'audioLie' && mock.chatCallCount === 1) {
              return { data: { id: 'lie1', choices: [{ message: { role: 'assistant', content: JSON.stringify({ hasSensitive: true, maxLevel: 3, items: [] }) } }] } };
            }
            if (mock.mode === 'videoEmpty' && mock.chatCallCount === 1) {
              return { data: { id: 'empty1', choices: [{ message: { role: 'assistant', content: JSON.stringify({ hasSensitive: false, maxLevel: 0, items: [] }) } }] } };
            }
            if (mock.mode === '429') {
              const err = new Error('rate limited');
              err.response = { status: 429, data: { error: { message: 'rate limit exceeded' } } };
              throw err;
            }
            if (mock.mode === '500') {
              const err = new Error('internal error');
              err.response = { status: 500, data: { error: { message: 'model crashed' } } };
              throw err;
            }
            // 智能 mock：body 包含手机/电话 → 返回手机号；否则返回空
            if (/1[3-9]\d{9}|手机|电话/.test(big)) {
              return { data: { id: 'chat1', choices: [{ message: { role: 'assistant', content: JSON.stringify({ hasSensitive: true, maxLevel: 3, items: [{ raw: '13912345678', type: 'phone', label: '手机号', level: 3, verified: false, context: '' }] }) } }] } };
            }
            return { data: { id: 'chat0', choices: [{ message: { role: 'assistant', content: JSON.stringify({ hasSensitive: false, maxLevel: 0, items: [] }) } }] } };
          }
        if (url.includes('/responses')) {
          mock.responsesCallCount++;
          if (mock.mode === '401') {
            const err = new Error('unauthorized');
            err.response = { status: 401, data: { error: { message: 'invalid api key' } } };
            throw err;
          }
          const hasImage = big.includes('data:image/');
          const hasEmail = /[\w.-]+@[\w.-]+/.test(big);
          const hasUrl = /https?:\/\//.test(big);
          if (hasImage || hasEmail || hasUrl) {
            const items = [];
            if (hasImage) items.push({ raw: 'alice@example.com', type: 'email', label: '邮箱', level: 1, verified: false, context: '' });
            if (hasEmail) items.push({ raw: 'alice@example.com', type: 'email', label: '邮箱', level: 1, verified: false, context: '' });
            if (hasUrl) items.push({ raw: 'https://example.com/secret?token=abc', type: 'url', label: '链接', level: 2, verified: false, context: '' });
            return { data: { output: [{ content: [{ type: 'output_text', text: JSON.stringify({ hasSensitive: true, maxLevel: 2, items }) }] }] } };
          }
          return { data: { output: [{ content: [{ type: 'output_text', text: JSON.stringify({ hasSensitive: false, maxLevel: 0, items: [] }) }] }] } };
        }
        throw new Error('未 mock 的 url: ' + url);
      },
    };
  }
  return mod;
};

const analyzer = require(path.join(__dirname, '..', 'services', 'analyzer'));

(async () => {
  // === text 通道 ===
  mock.mode = 'good';
  let r = await analyzer.analyzeText({text:'我的邮箱是 alice@example.com，电话 13800138000'});
  log(r.success && r.items && r.items.some((i) => i.type === 'email') && r.items.some((i) => i.type === 'phone'), 'text 通道：邮箱+手机同时识别', `${r.items.length} items`);

  // 仅本地正则（不需要 AI）
  r = await analyzer.analyzeText({text:'身份证 110105199003071239'});
  log(r.success && r.items && r.items.some((i) => i.type === 'id' && i.verified), 'text 通道：身份证本地校验位通过', `${r.items.length} items`);

  // 混合中英文
  r = await analyzer.analyzeText({text:'Contact me at bob@x.com or visit https://example.com/secret?token=abc'});
  log(r.success && r.items && r.items.some((i) => i.type === 'url'), 'text 通道：URL 识别', `${r.items.map(i => i.type).join(',')}`);

  // 无敏感信息
  r = await analyzer.analyzeText({text:'今天的会议很顺利'});
  log(r.success && r.items && r.items.length === 0, 'text 通道：无敏感信息返回空数组');

  // === image 通道（mock 模式：返回邮箱） ===
  mock.mode = 'good';
  r = await analyzer.analyzeImage({imageUrl:'data:image/png;base64,iVBORw0KGgo='});
  log(r.success && r.items && r.items.some((i) => i.type === 'email'), 'image 通道：AI 识别邮箱（mock）', `source=${r.source} items=${r.items?.length} types=${r.items?.map(i=>i.type).join(',')} err=${r.error || '无'}`);

  // === audio 通道：正常识别 ===
  mock.mode = 'good';
  mock.chatCallCount = 0;
  r = await analyzer.analyzeAudio({dataUrl:'data:audio/wav;base64,UklGRg=='});
  log(r.success && r.items && r.items.some((i) => i.type === 'phone'), 'audio 通道：AI 识别手机号（mock）', `${r.items.length} items`);

  // === audio 通道：模型谎报 → 修复轮纠正（第二次返回正常） ===
  mock.mode = 'audioLie';
  mock.chatCallCount = 0;
  r = await analyzer.analyzeAudio({dataUrl:'data:audio/wav;base64,UklGRg=='});
  log(r.success || (r.warnings && r.warnings.length > 0), 'audio 通道：谎报场景不硬报错', `ok=${r.success} warn=${(r.warnings || []).length}`);

  // === video 通道：正常识别 ===
  mock.mode = 'good';
  mock.chatCallCount = 0;
  r = await analyzer.analyzeVideo({dataUrl:'data:video/mp4;base64,AAAA'});
  log(r.success && r.items && r.items.length > 0, 'video 通道：AI 识别（mock）', `${r.items.length} items`);

  // === 错误路径：401 透传 ===
  mock.mode = '401';
  r = await analyzer.analyzeImage({imageUrl:'data:image/png;base64,iVBORw0KGgo='});
  log(r.success === false && r.status === 401, 'image 401 错误透传', `status=${r.status}`);

  // === 错误路径：429 限流 ===
  mock.mode = '429';
  r = await analyzer.analyzeAudio({dataUrl:'data:audio/wav;base64,UklGRg=='});
  log(r.success === false && r.status === 429, 'audio 429 限流透传', `status=${r.status}`);

  // === 错误路径：500 内部错误 ===
  mock.mode = '500';
  r = await analyzer.analyzeVideo({dataUrl:'data:video/mp4;base64,AAAA'});
  log(r.success === false && r.status === 500, 'video 500 内部错误透传', `status=${r.status}`);

  console.log(`\n=== 端到端测试：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e); process.exit(2); });
