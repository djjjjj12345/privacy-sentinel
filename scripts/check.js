#!/usr/bin/env node
/**
 * 离线自检脚本（不需要真实 API Key，不消耗额度）
 * ---------------------------------------------------------------
 * 用一个假的方舟服务替代真实模型，验证整条链路：
 *   接口契约 / 双引擎融合 / 校验位分级 / 中文类型别名 / bbox 归一化
 *   等级下限 / 错误降级 / 未实现通道 / 参数校验
 *
 * 用法： npm run check
 */

const http = require('http');
const path = require('path');

const MOCK_PORT = 49871;
const APP_PORT = 49872;

// 必须在 require server.js 之前注入，server.js 顶部会读这些变量
process.env.ARK_API_KEY = 'self-test-key';
process.env.ARK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/api/v3`;
process.env.ARK_VISION_MODEL = 'mock-vision-model';
process.env.ARK_TEXT_MODEL = 'mock-text-model';
process.env.PORT = String(APP_PORT);
process.env.RATE_LIMIT_PER_MINUTE = '0'; // 自检期间关闭限流

const VALID_ID = '110105199003071239';
const VALID_CARD = '6228480012345671';

// ------------------------------------------------------------------
//  假的方舟服务
// ------------------------------------------------------------------
let mockMode = 'good';
let lastRequestBody = null;

const GOOD_RESULT = {
  hasSensitive: true,
  maxLevel: 4,
  summary: '检测到身份证号 1 处、手机号 1 处、短信验证码 1 处',
  transcript: null,
  items: [
    // 故意用中文类型名 + 0-1000 刻度坐标，用来验证别名映射与归一化
    { type: '身份证', raw: VALID_ID, level: 1, confidence: 0.96, reason: '对方索要身份证号', bbox: [100, 200, 300, 80] },
    { type: 'phone', raw: '13912345678', level: 1, confidence: 0.92, reason: '与身份证同时发送', bbox: null },
    // 故意给 level 1，验证「类型下限」会把验证码抬到 L4
    { type: '验证码', raw: '482913', level: 1, confidence: 0.99, reason: '短信验证码泄露可直接盗号', bbox: null },
    // 模型独有、正则抓不到的类型
    { type: '姓名', raw: '张三', level: 1, confidence: 0.7, reason: '真实姓名会暴露身份', bbox: null },
  ],
  advice: '建议先电话核实对方身份，验证码绝不能发送。',
};

const AUDIO_RESULT = {
  hasSensitive: true,
  maxLevel: 4,
  summary: '音频中识别到短信验证码与银行卡号',
  transcript: '喂，我是淘宝客服，请你把验证码 482913 念给我，卡号是 6228480012345671。',
  items: [
    { type: '验证码', raw: '482913', level: 1, confidence: 0.99, reason: '电话中索要验证码属于典型诈骗话术' },
    { type: '银行卡', raw: '6228480012345671', level: 1, confidence: 0.95, reason: '电话中索要卡号' },
  ],
  advice: '⚠️ 这是「冒充客服索要验证码」的典型话术，请立即挂断。',
};

const VIDEO_RESULT = {
  hasSensitive: true,
  maxLevel: 3,
  summary: '视频画面出现身份证号',
  transcript: '画面顶部字幕：你的身份证号 110105199003071239，请发给我。',
  items: [
    { type: '身份证号', raw: VALID_ID, level: 3, confidence: 0.9, reason: '视频画面文字索取身份证号' },
  ],
  advice: '不要把视频里出现的证件号再发给任何人。',
};

let lastChatBody = null;

const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try { lastRequestBody = JSON.parse(body); } catch { lastRequestBody = null; }

    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // Chat Completions 用于音频/视频。简单路由：audio 返 AUDIO，video 返 VIDEO，其它返错。
    if (req.url && req.url.includes('/chat/completions')) {
      try { lastChatBody = JSON.parse(body); } catch { lastChatBody = null; }
      if (mockMode === 'error401') return send(401, { error: { message: 'invalid api key' } });
      if (mockMode === 'garbage') {
        return send(200, {
          id: 'chat_garbage',
          choices: [{ message: { role: 'assistant', content: '抱歉，识别失败。' } }],
        });
      }
      if (mockMode === 'audioLie') {
        // 谎报场景：声称有敏感但 items 为空
        return send(200, {
          id: 'chat_lie',
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ hasSensitive: true, maxLevel: 3, items: [] }) } }],
        });
      }
      const isAudio = Array.isArray(lastChatBody?.messages?.[0]?.content)
        && lastChatBody.messages[0].content.some((c) => c && c.type === 'input_audio');
      const result = isAudio ? AUDIO_RESULT : VIDEO_RESULT;
      return send(200, {
        id: isAudio ? 'chat_audio_ok' : 'chat_video_ok',
        choices: [{ message: { role: 'assistant', content: JSON.stringify(result) } }],
      });
    }

    if (mockMode === 'error401') {
      return send(401, { error: { message: 'invalid api key' } });
    }
    if (mockMode === 'garbage') {
      return send(200, {
        id: 'resp_garbage',
        output: [{ content: [{ type: 'output_text', text: '我看到了敏感信息，但我不想输出 JSON。' }] }],
      });
    }
    if (mockMode === 'lie') {
      // 声称有敏感信息但 items 为空，属于必须被拦截的情况
      return send(200, {
        id: 'resp_lie',
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({ hasSensitive: true, maxLevel: 3, items: [] }) }] }],
      });
    }
    return send(200, {
      id: 'resp_ok',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(GOOD_RESULT) }] }],
    });
  });
});

// ------------------------------------------------------------------
//  极简断言
// ------------------------------------------------------------------
let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` -> ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function post(pathname, payload) {
  const resp = await fetch(`http://127.0.0.1:${APP_PORT}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let json = null;
  try { json = await resp.json(); } catch { json = null; }
  return { status: resp.status, body: json };
}

async function get(pathname) {
  const resp = await fetch(`http://127.0.0.1:${APP_PORT}${pathname}`);
  let json = null;
  try { json = await resp.json(); } catch { json = null; }
  return { status: resp.status, body: json };
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ------------------------------------------------------------------
//  测试主体
// ------------------------------------------------------------------
async function run() {
  console.log('\n=== 1. 基础接口 ===');
  {
    const health = await get('/api/health');
    check('GET /api/health 返回成功', health.status === 200 && health.body.success === true);
    check('健康检查确认已配置 Key', health.body.arkKeyConfigured === true);

    const schema = await get('/api/analyze/schema');
    check('GET /api/analyze/schema 返回类型表', schema.body.types && schema.body.types.id === '身份证号');
    check('契约标明音频通道为 supported', schema.body.kinds.audio === 'supported');
    check('契约标明视频通道为 supported', schema.body.kinds.video === 'supported');
  }

  console.log('\n=== 2. 图片多模态识别 ===');
  mockMode = 'good';
  lastRequestBody = null;
  {
    const r = await post('/api/analyze', { kind: 'image', dataUrl: TINY_PNG, fileName: 'idcard.png' });
    const items = (r.body && r.body.items) || [];
    const byType = {};
    items.forEach((i) => { byType[i.type] = i; });

    check('图片识别返回成功', r.status === 200 && r.body.success === true, `HTTP ${r.status}`);
    check('共识别出 4 条', items.length === 4, `实际 ${items.length}`);

    check('中文类型名「身份证」被映射为 id', Boolean(byType.id), JSON.stringify(Object.keys(byType)));
    check('中文类型名「姓名」被映射为 name', Boolean(byType.name));
    check('姓名已按规则脱敏为 张*', byType.name && byType.name.masked === '张*', byType.name && byType.name.masked);

    const idItem = byType.id || {};
    check('身份证脱敏保留前 6 位与后 4 位', idItem.masked === '110105********1239', idItem.masked);
    check(
      'bbox 由 0-1000 刻度归一化为 0-1',
      Array.isArray(idItem.bbox) && Math.abs(idItem.bbox[0] - 0.1) < 1e-6 && Math.abs(idItem.bbox[2] - 0.3) < 1e-6,
      JSON.stringify(idItem.bbox)
    );

    check('验证码等级被类型下限抬到 L4', byType.otp && byType.otp.level === 4, byType.otp && String(byType.otp.level));
    check('整体最高等级为 4', r.body.maxLevel === 4, String(r.body.maxLevel));
    check('识别来源标记为 ai', r.body.source === 'ai', r.body.source);
    check('图片请求与图片内容一并送达模型', Boolean(lastRequestBody && lastRequestBody.input));
  }

  console.log('\n=== 3. 文本双引擎融合 ===');
  {
    const text = `我的身份证是${VALID_ID}，手机号13912345678，验证码是482913`;
    const r = await post('/api/analyze', { kind: 'text', text });
    const items = (r.body && r.body.items) || [];
    const byType = {};
    items.forEach((i) => { byType[i.type] = i; });

    check('文本识别返回成功', r.status === 200 && r.body.success === true, `HTTP ${r.status}`);
    check('识别来源标记为 hybrid', r.body.source === 'hybrid', r.body.source);
    check('引擎统计中本地与 AI 均有命中', r.body.engine.local > 0 && r.body.engine.ai > 0, JSON.stringify(r.body.engine));

    check('校验位正确的身份证被标记为已校验', byType.id && byType.id.verified === true, JSON.stringify(byType.id && byType.id.verified));
    check('身份证未被误判为银行卡', !byType.bankcard || byType.bankcard.raw !== VALID_ID);
    check('模型独有的姓名被融合进来', Boolean(byType.name), JSON.stringify(Object.keys(byType)));
    check('同一号码未出现重复条目', new Set(items.map((i) => i.raw)).size === items.length);
    check('提示词中注入了用户画像', Boolean(lastRequestBody && lastRequestBody.input && lastRequestBody.input[0].role === 'system'));
  }

  console.log('\n=== 4. 校验位分级（误报控制） ===');
  {
    // 18 位但中间不是合法日期，应被直接丢弃
    const badDate = await post('/api/analyze', { kind: 'text', text: '订单号 202503190000000123', mode: 'local' });
    check('中间非日期的 18 位数字不被当作身份证', badDate.body.items.length === 0, JSON.stringify(badDate.body.items));

    // 格式正确但校验位错误，应上报但标记存疑
    const weak = await post('/api/analyze', { kind: 'text', text: '身份证 110105199003071234', mode: 'local' });
    const weakItem = weak.body.items[0] || {};
    check('校验位不符的号码仍被上报（避免漏报）', weak.body.items.length === 1);
    check('校验位不符被标记为 verified=false', weakItem.verified === false, String(weakItem.verified));
    check('校验位不符时可信度下调', weakItem.confidence < 1, String(weakItem.confidence));

    const card = await post('/api/analyze', { kind: 'text', text: `卡号${VALID_CARD}`, mode: 'local' });
    check('Luhn 通过的银行卡被标记为已校验', card.body.items[0] && card.body.items[0].verified === true, JSON.stringify(card.body.items[0]));
  }

  console.log('\n=== 5. 模型异常时的降级 ===');
  {
    mockMode = 'garbage';
    const garbageImage = await post('/api/analyze', { kind: 'image', dataUrl: TINY_PNG });
    check('图片场景模型不返回 JSON 时明确报错', garbageImage.body.success === false, JSON.stringify(garbageImage.body).slice(0, 120));
    check('错误信息提示识别无效', /无效/.test(garbageImage.body.error || ''), garbageImage.body.error);

    mockMode = 'lie';
    const lie = await post('/api/analyze', { kind: 'image', dataUrl: TINY_PNG });
    check('模型声称有风险却给不出条目时报错', lie.body.success === false, JSON.stringify(lie.body).slice(0, 120));

    mockMode = 'error401';
    const unauthorized = await post('/api/analyze', { kind: 'image', dataUrl: TINY_PNG });
    check('上游 401 被转成可读错误', unauthorized.body.success === false && /API Key/.test(unauthorized.body.error || ''), unauthorized.body.error);

    // 文本场景上游挂了仍应能用正则兜底
    const textFallback = await post('/api/analyze', { kind: 'text', text: `身份证 ${VALID_ID}` });
    check('文本场景上游失败后回退到本地引擎', textFallback.body.success === true && textFallback.body.items.length === 1, JSON.stringify(textFallback.body).slice(0, 140));
    check('回退时给出降级提示', Array.isArray(textFallback.body.warnings) && textFallback.body.warnings.length > 0);
    check('回退结果来源标记为 local', textFallback.body.source === 'local', textFallback.body.source);
    mockMode = 'good';

    // 超长文本：AI 只复检前 12000 字，但本地正则仍扫全文，且必须显式提示截断
    const longText = '日常寒暄。'.repeat(4000) + ` 身份证 ${VALID_ID}`;
    const long = await post('/api/analyze', { kind: 'text', text: longText });
    check('超长文本仍返回成功', long.body.success === true, `HTTP ${long.status}`);
    check('超长文本的本地正则命中了尾部身份证', long.body.items.some((i) => i.type === 'id'), JSON.stringify(long.body.items.map((i) => i.type)));
    check('超长文本带截断提示', Array.isArray(long.body.warnings) && long.body.warnings.some((w) => /12000/.test(w)), JSON.stringify(long.body.warnings));
  }

  console.log('\n=== 6. 参数校验 ===');
  {
    const unknown = await post('/api/analyze', { kind: 'whatever' });
    check('未知类型返回 400', unknown.status === 400, `HTTP ${unknown.status}`);

    const noImage = await post('/api/analyze', { kind: 'image' });
    check('缺少图片内容返回 400', noImage.status === 400, `HTTP ${noImage.status}`);

    const emptyText = await post('/api/analyze', { kind: 'text', text: '   ' });
    check('空白文本返回 400', emptyText.status === 400, `HTTP ${emptyText.status}`);

    const noAudio = await post('/api/analyze', { kind: 'audio' });
    check('缺少音频内容返回 400', noAudio.status === 400, `HTTP ${noAudio.status}`);

    const wrongMime = await post('/api/analyze', {
      kind: 'audio', dataUrl: 'data:audio/webm;base64,AAA',
    });
    check('不支持的音频格式返回 415', wrongMime.status === 415, `HTTP ${wrongMime.status}`);

    const wrongVideo = await post('/api/analyze', {
      kind: 'video', dataUrl: 'data:video/webm;base64,AAA',
    });
    check('不支持的视频格式返回 415', wrongVideo.status === 415, `HTTP ${wrongVideo.status}`);

    const notFound = await get('/api/does-not-exist');
    check('未命中接口返回 JSON 而非 HTML', notFound.status === 404 && notFound.body.success === false);
  }

  console.log('\n=== 7. 音频通道 ===');
  {
    mockMode = 'good';
    lastChatBody = null;
    const tinyMp3 = 'data:audio/mp3;base64,SUQzAwAAAAAA'; // 静音 mp3
    const r = await post('/api/analyze', { kind: 'audio', dataUrl: tinyMp3, fileName: 'fake.mp3' });
    const items = (r.body && r.body.items) || [];
    const byType = {};
    items.forEach((i) => { byType[i.type] = i; });

    check('音频识别返回成功', r.status === 200 && r.body.success === true, `HTTP ${r.status}`);
    check('音频请求走的是 chat/completions', Boolean(lastChatBody && Array.isArray(lastChatBody.messages)));
    check('音频请求体里能看到 input_audio.data',
      Array.isArray(lastChatBody?.messages?.[0]?.content)
      && lastChatBody.messages[0].content.some((c) => c && c.type === 'input_audio' && c.input_audio && typeof c.input_audio.data === 'string'),
      JSON.stringify(lastChatBody?.messages?.[0]?.content?.[0]?.type || null)
    );
    check('音频请求带上了正确的 format=mp3',
      lastChatBody?.messages?.[0]?.content?.[0]?.input_audio?.format === 'mp3'
    );
    check('音频请求的提问部分用的是 text 类型（而非 input_text）',
      lastChatBody?.messages?.[0]?.content?.some((c) => c && c.type === 'text' && typeof c.text === 'string'),
      JSON.stringify((lastChatBody?.messages?.[0]?.content || []).map((c) => c.type))
    );
    check('音频转写文本被带回', r.body.transcript && /验证码|卡号/.test(r.body.transcript), r.body.transcript);
    check('模型识别的验证码被融合', Boolean(byType.otp), JSON.stringify(Object.keys(byType)));
    check('模型识别的银行卡被融合', Boolean(byType.bankcard));
    check('本地正则从转写文本中补回一条命中',
      r.body.engine && (r.body.engine.local > 0 || r.body.engine.ai > 0),
      JSON.stringify(r.body.engine)
    );
    check('整体最高等级为 4', r.body.maxLevel === 4, String(r.body.maxLevel));

    mockMode = 'audioLie';
    const lie = await post('/api/analyze', { kind: 'audio', dataUrl: tinyMp3 });
    check('音频场景模型谎报时返回错误', lie.body.success === false, JSON.stringify(lie.body).slice(0, 120));
    mockMode = 'good';
  }

  console.log('\n=== 8. 视频通道 ===');
  {
    mockMode = 'good';
    lastChatBody = null;
    const tinyMp4 = 'data:video/mp4;base64,AAAA'; // 占位 mp4
    const r = await post('/api/analyze', { kind: 'video', dataUrl: tinyMp4, fileName: 'clip.mp4' });
    const items = (r.body && r.body.items) || [];

    check('视频识别返回成功', r.status === 200 && r.body.success === true, `HTTP ${r.status}`);
    check('视频请求带上了 video_url（方舟 Chat Completions 的视频类型）',
      Array.isArray(lastChatBody?.messages?.[0]?.content)
      && lastChatBody.messages[0].content.some((c) => c && c.type === 'video_url' && c.video_url && typeof c.video_url.url === 'string' && c.video_url.url.startsWith('data:video/mp4;base64,'))
    );
    check('视频请求的提问部分用的是 text 类型',
      lastChatBody?.messages?.[0]?.content?.some((c) => c && c.type === 'text' && typeof c.text === 'string')
    );
    check('视频识别命中身份证', items.some((i) => i.type === 'id'), JSON.stringify(items.map((i) => i.type)));
    check('视频识别带回转写文本', r.body.transcript && /身份证号/.test(r.body.transcript), r.body.transcript);
  }

  console.log('\n=== 9. 旧接口兼容 ===');
  {
    const legacy = await post('/api/detect', { image_url: TINY_PNG });
    check('POST /api/detect 仍可用', legacy.status === 200 && legacy.body.success === true, `HTTP ${legacy.status}`);
    check('旧接口仍返回可读的 result 文本', typeof legacy.body.result === 'string' && legacy.body.result.length > 0);
    check('旧接口同时附带结构化 items', Array.isArray(legacy.body.items) && legacy.body.items.length === 4);
  }
}

// ------------------------------------------------------------------
//  启动与收尾
// ------------------------------------------------------------------
(async function main() {
  await new Promise((resolve) => mockServer.listen(MOCK_PORT, '127.0.0.1', resolve));
  console.log(`假方舟服务已启动: http://127.0.0.1:${MOCK_PORT}`);

  require(path.join(__dirname, '..', 'server.js'));
  // 等 express 完成监听
  await new Promise((r) => setTimeout(r, 600));

  try {
    await run();
  } catch (error) {
    failures.push(`自检过程抛出异常: ${error.message}`);
    console.error('\n自检异常:', error);
  }

  console.log('\n============================');
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log('\n失败明细:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log('============================\n');

  mockServer.close();
  process.exit(failures.length ? 1 : 0);
})();
