#!/usr/bin/env node
/**
 * 华为云 MaaS 能力探测脚本
 * ---------------------------------------------------------------
 * 目的：在动手写 provider 之前，先把"华为云这边到底支持什么"摸清楚。
 * 因为不同区域 / 不同账号开通的模型 / 不同模型版本，能力差异很大，
 * 与其照着文档猜，不如直接问服务端。
 *
 * 用法：
 *   1. 在 .env 里填好 HW_MAAS_BASE_URL 与 HW_MAAS_API_KEY（可选 HW_TEXT_MODEL）
 *   2. node scripts/probe-huawei.js
 *   3. 把终端输出（或生成的 probe-report.json）发给开发者
 *
 * 探测内容：
 *   ① 端点与鉴权：哪个 URL 路径 + 哪种 Header 能通
 *   ② 模型列表：账号实际开通了哪些模型
 *   ③ 文本链路：能否稳定返回合规 JSON
 *   ④ 图片链路：base64 data URL 是否被接受，能否逐字抽取号码
 *   ⑤ 音频链路：多种入参形态逐个试，确定有没有"直传音频"通道
 *   ⑥ 视频链路：同上
 *
 * 成本：全程只发十几个请求，文本/图片用极小 max_tokens，花费可忽略。
 */

require('dotenv').config();
const axios = require('axios');
const { TEST_IMAGE_B64, TEST_AUDIO_B64 } = require('./probe-assets');

const BASE = (process.env.HW_MAAS_BASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.HW_MAAS_API_KEY || '';
const TEXT_MODEL = process.env.HW_TEXT_MODEL || '';
const VISION_MODEL = process.env.HW_VISION_MODEL || '';

// 候选端点路径：MaaS 控制台的 OpenAI 兼容接口与 ModelArts Studio 的 V2 接口写法不同，
// 不同区域/版本也可能不一样，所以全部试一遍。
const CANDIDATE_PATHS = [
  '/v1/chat/completions',
  '/api/v2/chat/completions',
  '/chat/completions',
  '/v1/completions',
];
// 候选鉴权：Bearer 是 OpenAI 兼容的常规写法；X-Apig-AppCode 是华为云 APIG 的 Key 写法。
const CANDIDATE_AUTH = ['bearer', 'appcode'];

// 未在 .env 指定模型时，用来做端点探测的候选（按价格从低到高，都是 MaaS 常见预置模型）
const FALLBACK_MODELS = ['DeepSeek-V4.1-Flash', 'Qwen2.5-VL-7B', 'Qwen3-30B-A3B'];

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m',
};
const say = (s = '') => process.stdout.write(s + '\n');
const head = (s) => say(`\n${C.bold}${C.cyan}${'─'.repeat(3)} ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}${C.reset}`);
const ok = (s) => say(`  ${C.green}[通过]${C.reset} ${s}`);
const bad = (s) => say(`  ${C.red}[失败]${C.reset} ${s}`);
const warn = (s) => say(`  ${C.yellow}[提示]${C.reset} ${s}`);
const info = (s) => say(`  ${C.dim}${s}${C.reset}`);

const REPORT = {
  generatedAt: new Date().toISOString(),
  baseUrl: BASE || null,
  endpoint: null,
  auth: null,
  models: [],
  text: null,
  image: null,
  audio: {},
  video: {},
};

/** 统一的请求封装：不抛异常，把结果结构化返回 */
async function probe({ path, auth, body, timeout = 30000, method = 'post' }) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth === 'bearer') headers.Authorization = `Bearer ${KEY}`;
  if (auth === 'appcode') headers['X-Apig-AppCode'] = KEY;
  const startedAt = Date.now();
  try {
    const res = await axios({
      method,
      url: `${BASE}${path}`,
      headers,
      data: method === 'post' ? body : undefined,
      timeout,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: null,
    });
    return {
      ok: res.status < 400,
      status: res.status,
      data: res.data,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      networkError: error.code === 'ECONNABORTED' ? 'timeout' : (error.code || error.message),
      data: error.response ? error.response.data : null,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/** 把各种形态的报错压缩成一句话 */
function brief(result) {
  if (result.status === 0) return `网络层：${result.networkError}`;
  const d = result.data;
  const msg = d && (d.error?.message || d.error_msg || d.message || d.error?.code);
  const text = typeof d === 'string' ? d : (msg ? String(msg) : JSON.stringify(d || {}));
  return `HTTP ${result.status} · ${text.slice(0, 160)}`;
}

function readContent(data) {
  const choice = data && data.choices && data.choices[0];
  if (!choice) return '';
  if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
  if (typeof choice.text === 'string') return choice.text;
  return '';
}

/** 从返回文本里抠出 JSON（与线上 extractJson 同思路，够探测用） */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* 继续 */ }
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch { /* 继续 */ }
  }
  return null;
}

/* ══════════════════════════ ① 端点与鉴权探测 ══════════════════════════ */
async function phaseEndpoint() {
  head('① 端点与鉴权探测');
  const modelCandidates = TEXT_MODEL ? [TEXT_MODEL] : FALLBACK_MODELS;

  for (const model of modelCandidates) {
    for (const path of CANDIDATE_PATHS) {
      for (const auth of CANDIDATE_AUTH) {
        const r = await probe({
          path, auth,
          body: { model, messages: [{ role: 'user', content: '回复两个字：收到' }], max_tokens: 16, temperature: 0.1 },
          timeout: 20000,
        });
        if (r.ok && readContent(r.data)) {
          REPORT.endpoint = path;
          REPORT.auth = auth;
          REPORT.probeModel = model;
          ok(`${path}  +  ${auth === 'bearer' ? 'Authorization: Bearer' : 'X-Apig-AppCode'}  → 可用`);
          info(`模型 ${model} · 耗时 ${r.elapsedMs}ms · 返回："${readContent(r.data).slice(0, 40)}"`);
          return { path, auth, model };
        }
        info(`${C.dim}× ${path} / ${auth} / ${model} → ${brief(r)}${C.reset}`);
      }
    }
  }
  bad('所有端点与鉴权组合都失败');
  warn('请核对三件事：① HW_MAAS_BASE_URL 是否从控制台「API 调用」页完整复制；');
  warn('② 账号是否已完成实名且未欠费；③ 是否已在「西南-贵阳一」区域开通预置服务。');
  return null;
}

/* ══════════════════════════ ② 模型列表 ══════════════════════════ */
async function phaseModels(base) {
  head('② 模型列表（账号实际已开通的）');
  if (!base) { warn('跳过：端点未探测成功'); return; }
  const headers = { 'Content-Type': 'application/json' };
  if (base.auth === 'bearer') headers.Authorization = `Bearer ${KEY}`;
  if (base.auth === 'appcode') headers['X-Apig-AppCode'] = KEY;

  for (const p of ['/v1/models', '/api/v2/models', '/models']) {
    const r = await probe({ path: p, auth: base.auth, method: 'get', timeout: 15000 });
    if (r.ok && r.data && Array.isArray(r.data.data)) {
      const ids = r.data.data.map((m) => m.id || m.model || m.name).filter(Boolean);
      REPORT.models = ids;
      ok(`${p} → ${ids.length} 个模型`);
      ids.forEach((id) => info(`· ${id}`));
      return ids;
    }
  }
  warn('模型列表接口不可用（不影响使用，只是没法自动列出）');
  warn('请在控制台「模型推理 > 在线推理 > 预置服务」页手动确认已开通的模型 ID。');
  return [];
}

/* ══════════════════════════ ③ 文本链路 ══════════════════════════ */
async function phaseText(base) {
  head('③ 文本链路：能否稳定吐合规 JSON');
  if (!base) { warn('跳过'); return; }

  const system = '你是一个敏感信息检测引擎。只输出 JSON，不要任何解释文字。';
  const user = `分析下面这段消息，输出 JSON：
{"hasSensitive":true,"items":[{"type":"id","raw":"110105199003071234"}],"advice":"建议","summary":"摘要"}
type 取值只能是 id/bankcard/phone/password/otp/address/name/email/url/passport/uscc/ip/mac/other 之一。
raw 必须逐字符照抄原文。

消息内容：
"你好，我的身份证号是 110105199003071234，手机号 13800138000，麻烦帮我登记一下。"`;

  for (const model of [...new Set([TEXT_MODEL, base.model].filter(Boolean))]) {
    const r = await probe({
      path: base.path, auth: base.auth,
      body: {
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.2, max_tokens: 300,
      },
    });
    if (!r.ok) { bad(`${model} → ${brief(r)}`); continue; }
    const text = readContent(r.data);
    const parsed = extractJson(text);
    const items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
    REPORT.text = { model, ok: Boolean(items && items.length), raw: text.slice(0, 400) };
    if (items && items.length) {
      ok(`${model} → ${items.length} 条，耗时 ${r.elapsedMs}ms`);
      items.forEach((it) => info(`· type=${it.type} raw=${it.raw}`));
      const usage = r.data && r.data.usage;
      if (usage) info(`tokens: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}`);
      return;
    }
    warn(`${model} → 通了但没解析出 JSON：${text.slice(0, 120)}`);
  }
}

/* ══════════════════════════ ④ 图片链路 ══════════════════════════ */
async function phaseImage(base, models) {
  head('④ 图片链路：base64 data URL 能否被接受');
  if (!base) { warn('跳过'); return; }

  const visionCandidates = [...new Set([
    VISION_MODEL,
    ...models.filter((m) => /VL|vl|Vision|vision/.test(m)),
    'Qwen2.5-VL-7B',
  ].filter(Boolean))];

  const dataUrl = `data:image/png;base64,${TEST_IMAGE_B64}`;
  const body = (model) => ({
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: '逐字符照抄图中所有身份证号码与手机号，只输出 JSON：{"hasSensitive":true,"items":[{"type":"id","raw":"..."}]}' },
      ],
    }],
    temperature: 0.2, max_tokens: 300,
  });

  for (const model of visionCandidates) {
    const r = await probe({ path: base.path, auth: base.auth, body: body(model), timeout: 45000 });
    if (!r.ok) {
      bad(`${model} → ${brief(r)}`);
      continue;
    }
    const text = readContent(r.data);
    const parsed = extractJson(text);
    const items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
    REPORT.image = { model, ok: Boolean(items && items.length), raw: text.slice(0, 400) };
    if (items && items.length) {
      ok(`${model} → ${items.length} 条，耗时 ${r.elapsedMs}ms`);
      items.forEach((it) => info(`· type=${it.type} raw=${it.raw}`));
      // 关键校验：身份证号是否被完整照抄（图里是 110105199003071234）
      const hit = items.find((it) => String(it.raw || '').replace(/\D/g, '') === '110105199003071234');
      if (hit) ok('OCR 精度校验：18 位身份证号逐字符完全正确');
      else warn('OCR 精度存疑：号码未完整匹配，需人工核对是否为模型漏字');
      return;
    }
    warn(`${model} → 通了但没解析出 JSON：${text.slice(0, 120)}`);
  }
  bad('没有可用的图像理解模型。请在控制台开通 Qwen2.5-VL 系列后重试。');
}

/* ══════════════════════════ ⑤ 音频链路 ══════════════════════════ */
async function phaseAudio(base, models) {
  head('⑤ 音频链路：有没有「直传音频」通道（本次迁移的关键）');
  if (!base) { warn('跳过'); return; }

  const candidates = [...new Set([
    ...models.filter((m) => /VL|vl|Omni|omni|Audio|audio/.test(m)),
    ...models.slice(0, 3),
  ].filter(Boolean))];
  if (!candidates.length) candidates.push(base.model);

  // 业界常见的四种音频入参写法，逐个试
  const FORMS = [
    { name: 'OpenAI 风格 input_audio', part: { type: 'input_audio', input_audio: { data: TEST_AUDIO_B64, format: 'wav' } } },
    { name: '火山风格 input_audio（data+format）', part: { type: 'input_audio', input_audio: { data: TEST_AUDIO_B64, format: 'mp3' } } },
    { name: 'audio_url（data URL）', part: { type: 'audio_url', audio_url: { url: `data:audio/wav;base64,${TEST_AUDIO_B64}` } } },
    { name: 'image_url 变通（不靠谱，仅对照）', part: { type: 'image_url', image_url: { url: `data:audio/wav;base64,${TEST_AUDIO_B64}` } } },
  ];

  const model = candidates[0];
  for (const form of FORMS) {
    const r = await probe({
      path: base.path, auth: base.auth,
      body: {
        model,
        messages: [{
          role: 'user',
          content: [form.part, { type: 'text', text: '转写这段音频内容' }],
        }],
        max_tokens: 64,
      },
      timeout: 30000,
    });
    REPORT.audio[form.name] = { ok: r.ok, status: r.status, detail: brief(r) };
    if (r.ok) ok(`${form.name} → 服务端接受（HTTP ${r.status}）`);
    else info(`${C.dim}× ${form.name} → ${brief(r)}${C.reset}`);
  }

  const anyOk = Object.values(REPORT.audio).some((v) => v.ok);
  if (anyOk) {
    ok('存在音频直传通道，可按原架构改造');
  } else {
    warn('未发现音频直传通道（与预期一致）');
    warn('结论：音频必须改造成「SIS 录音文件识别转写 → 转写稿走本地正则 + 文本模型」的两级流水线。');
    warn('下一步需要你额外开通 SIS 语音交互服务，并创建 AK/SK 用于换取 IAM Token。');
  }
}

/* ══════════════════════════ ⑥ 视频链路 ══════════════════════════ */
async function phaseVideo(base, models) {
  head('⑥ 视频链路：有没有「直传视频」通道');
  if (!base) { warn('跳过'); return; }

  const candidates = [...new Set([
    ...models.filter((m) => /VL|vl|Video|video/.test(m)),
    'Qwen2.5-VL-7B',
  ].filter(Boolean))];

  // 用一个极小 mp4 的 data URL 试探入参是否被接受（内容无意义，只看服务端是否接收）
  const tinyMp4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=';
  const FORMS = [
    { name: 'video_url（data URL）', part: { type: 'video_url', video_url: { url: tinyMp4 } } },
    { name: 'input_video（data+format）', part: { type: 'input_video', input_video: { data: 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=', format: 'mp4' } } },
  ];

  const model = candidates[0];
  for (const form of FORMS) {
    const r = await probe({
      path: base.path, auth: base.auth,
      body: {
        model,
        messages: [{ role: 'user', content: [form.part, { type: 'text', text: '描述这段视频' }] }],
        max_tokens: 64,
      },
      timeout: 30000,
    });
    REPORT.video[form.name] = { ok: r.ok, status: r.status, detail: brief(r) };
    if (r.ok) ok(`${form.name} → 服务端接受（HTTP ${r.status}）`);
    else info(`${C.dim}× ${form.name} → ${brief(r)}${C.reset}`);
  }

  const anyOk = Object.values(REPORT.video).some((v) => v.ok);
  if (anyOk) ok('存在视频直传通道');
  else {
    warn('未发现视频直传通道');
    warn('结论：视频改造成「ffmpeg 抽关键帧 → 帧走图像理解」+「音轨 → SIS 转写」。');
  }
}

/* ══════════════════════════ 主流程 ══════════════════════════ */
async function main() {
  say(`${C.bold}隐私哨兵 · 华为云 MaaS 能力探测${C.reset}`);
  say(`${C.dim}${new Date().toLocaleString('zh-CN')}${C.reset}`);

  head('⓪ 配置检查');
  if (!BASE) {
    bad('缺少 HW_MAAS_BASE_URL');
    say('\n请先在 .env 里配置（值都从华为云控制台复制）：');
    say('  HW_MAAS_BASE_URL=https://控制台「API 调用」页给出的地址');
    say('  HW_MAAS_API_KEY=你的 API Key');
    say('\n获取路径：控制台 → ModelArts Studio / MaaS → 模型推理 > 在线推理');
    say('         → 在「API 调用」页签复制调用地址；在「API Key 管理」页创建 Key。');
    process.exit(1);
  }
  if (!KEY) {
    bad('缺少 HW_MAAS_API_KEY');
    say('\n获取路径：MaaS 控制台 → API Key 管理 → 创建 API Key（明文只显示一次）。');
    process.exit(1);
  }
  ok(`BASE_URL = ${BASE}`);
  ok(`API_KEY  = ${KEY.slice(0, 6)}...${KEY.slice(-4)}（已脱敏）`);
  if (TEXT_MODEL) ok(`文本模型 = ${TEXT_MODEL}`); else warn('未设置 HW_TEXT_MODEL，将自动尝试常见模型');
  if (VISION_MODEL) ok(`视觉模型 = ${VISION_MODEL}`); else warn('未设置 HW_VISION_MODEL，将自动尝试 Qwen2.5-VL 系列');

  const base = await phaseEndpoint();
  const models = await phaseModels(base);
  if (base) {
    await phaseText(base);
    await phaseImage(base, models);
    await phaseAudio(base, models);
    await phaseVideo(base, models);
  }

  head('探测结论摘要');
  say(JSON.stringify(REPORT, null, 2));
  say(`\n${C.dim}完整结果已写入 probe-report.json，可直接发给开发者。${C.reset}`);

  require('fs').writeFileSync(
    require('path').join(__dirname, '..', 'probe-report.json'),
    JSON.stringify(REPORT, null, 2),
    'utf8'
  );
}

main().catch((e) => {
  say(`${C.red}探测脚本异常：${e.message}${C.reset}`);
  process.exit(1);
});
