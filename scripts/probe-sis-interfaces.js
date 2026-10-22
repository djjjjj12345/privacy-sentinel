/**
 * probe-sis-interfaces.js — 分清「账号被冻结」还是「某个接口没开通」
 * ---------------------------------------------------------------
 * 背景：SIS 报 `SIS.0101 auth failed, the request resource type is RESTRICTED/frozen`
 * 时，可能是两种情况，处置完全不同：
 *
 *   A. 账号级（欠费冻结 / 账号受限）→ 所有 SIS 接口都会失败，只能充值/解冻
 *   B. 接口级（某个接口未在控制台开通）→ 只有一个接口失败，去控制台开通即可
 *
 * 本脚本用同一份 AK/SK + 同一个项目，依次敲三个接口，看谁的 errorCode 不一样：
 *   1. 一句话识别（asr/short-audio，同步、按次计费）
 *   2. 录音文件识别极速版（asr/flash，异步、按音频时长）
 *   3. 录音文件识别普通版（asr/transcriber/jobs，需要 OBS 上的对象）
 *
 * 用法：
 *   node scripts/probe-sis-interfaces.js            # 用合成音（无人声）
 *   node scripts/probe-sis-interfaces.js --audio x.wav
 *
 * 说明：
 *   - 默认用 1 秒 440Hz 合成音，不含任何真人语音，不会外发隐私内容。
 *   - 返回失败的调用不计费；成功的一句话识别按次计费（几分钱量级）。
 *   - 只读诊断：不上传新对象、不删除任何东西（普通版用已存在的临时键探测签名）。
 */
'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  SisClient,
  RecognizeShortAudioRequest,
  PostShortAudioReq,
  Config,
  RecognizeFlashAsrRequest,
  PushTranscriberJobsRequest,
  PostTranscriberJobs,
  TranscriberConfig,
} = require('@huaweicloud/huaweicloud-sdk-sis');
const { BasicCredentials } = require('@huaweicloud/huaweicloud-sdk-core');

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

/** 1 秒 16k/16bit/单声道 440Hz 正弦波（无人声） */
function makeTone() {
  const rate = 16000;
  const n = rate;
  const buf = Buffer.alloc(n * 2 + 44);
  const write = (off, str) => buf.write(str, off, 'ascii');
  write(0, 'RIFF');
  buf.writeUInt32LE(36 + n * 2, 4);
  write(8, 'WAVEfmt ');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  write(36, 'data');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 6000), 44 + i * 2);
  }
  return buf;
}

const REQUIRED = ['HW_AK', 'HW_SK', 'HW_PROJECT_ID', 'HW_SIS_ENDPOINT'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`缺少环境变量：${missing.join(', ')}（读的是项目根目录 .env）`);
  process.exit(1);
}

const audioPath = getArg('--audio');
const wav = audioPath ? fs.readFileSync(path.resolve(audioPath)) : makeTone();

const client = SisClient.newBuilder()
  .withCredential(
    new BasicCredentials()
      .withAk(process.env.HW_AK)
      .withSk(process.env.HW_SK)
      .withProjectId(process.env.HW_PROJECT_ID)
  )
  .withEndpoint(process.env.HW_SIS_ENDPOINT)
  .build();

const rows = [];

function describe(e) {
  const code = (e && (e.errorCode || e.error_code)) || '';
  const msg = (e && (e.errorMsg || e.message)) || String(e);
  // SDK 有时把原始 body 塞在 require_msg / error_msg 里，取最短的可读串
  const body = (e && (e.error_msg || e.errorMessage)) || '';
  const text = String(body || msg).replace(/\s+/g, ' ').slice(0, 160);
  return { code: code || 'HTTP' + ((e && e.statusCode) || '?'), text };
}

const verdict = (r) => {
  if (!r.code) return '✅ 可用';
  if (/RESTRICTED|frozen/i.test(r.text) && /SIS\.0101/.test(r.code)) return '⛔ 被拦截';
  if (/not subscribe/i.test(r.text)) return '⚠️ 未开通';
  return '❌ ' + r.code;
};

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const resp = await fn();
    const text = resp && (resp.result && (resp.result.text || resp.result.words)) || '';
    rows.push({
      name,
      code: '',
      text: (Array.isArray(text) ? text.map((w) => w.word || '').join('') : String(text)).slice(0, 60),
      ms: Date.now() - t0,
    });
  } catch (e) {
    const d = describe(e);
    rows.push({ name, code: d.code, text: d.text, ms: Date.now() - t0 });
  }
}

(async () => {
  console.log(`\n探测 SIS 三个接口（region 由 endpoint 决定：${process.env.HW_SIS_ENDPOINT}）`);
  console.log(`project_id=${process.env.HW_PROJECT_ID}  音频=${audioPath || '1s 合成音（无人声）'} ${wav.length}B\n`);

  // 1. 一句话识别
  await step('一句话识别 short-audio', () => {
    const body = new PostShortAudioReq()
      .withConfig(new Config().withAudioFormat('wav').withProperty('chinese_16k_common'))
      .withData(wav.toString('base64'));
    return client.recognizeShortAudio(new RecognizeShortAudioRequest().withBody(body));
  });

  // 2. 录音文件识别极速版（用 OBS 对象键；这里复用 .env 的桶，键故意指向不存在对象）
  await step('极速版 asr/flash', () => {
    const req = new RecognizeFlashAsrRequest()
      .withAudioFormat('wav')
      .withProperty('chinese_16k_conversation')
      .withObsBucketName(process.env.HW_OBS_BUCKET || '')
      .withObsObjectKey('tmp/diagnose/nonexistent.wav');
    return client.recognizeFlashAsr(req);
  });

  // 3. 录音文件识别普通版（data_url 指向桶内一个不存在的键，只为触发鉴权与开通校验）
  await step('普通版 asr/transcriber', () => {
    const cfg = new TranscriberConfig()
      .withAudioFormat('pcm16k16bit')
      .withProperty(process.env.HW_SIS_PROPERTY || 'chinese_16k_media');
    const url = `${process.env.HW_OBS_ENDPOINT || ''}`.replace(/^https?:\/\//, '');
    const body = new PostTranscriberJobs()
      .withConfig(cfg)
      .withDataUrl(`https://${process.env.HW_OBS_BUCKET}.${url}/tmp/diagnose/nonexistent.pcm`);
    return client.pushTranscriberJobs(new PushTranscriberJobsRequest().withBody(body));
  });

  console.log('接口'.padEnd(26) + '结果'.padEnd(12) + '耗时'.padEnd(8) + '详情');
  console.log('-'.repeat(96));
  for (const r of rows) {
    console.log(
      r.name.padEnd(24) + verdict(r).padEnd(12) + `${r.ms}ms`.padEnd(8) + r.text
    );
  }

  const blocked = rows.filter((r) => /SIS\.0101/.test(r.code) && /RESTRICTED|frozen/i.test(r.text));
  const notSub = rows.filter((r) => /not subscribe/i.test(r.text));
  const ok = rows.filter((r) => !r.code);

  console.log('\n结论：');
  if (ok.length === rows.length) {
    console.log('  三个接口都通，链路配置没问题。');
  } else if (blocked.length === rows.length) {
    console.log('  三个接口全被同一原因拦下 → 账号级问题（欠费冻结/账号受限），不是某个接口没开通。');
    console.log('  去 费用与成本 → 总览 看余额与欠费状态；充值后 1 分钟再重试。');
  } else if (blocked.length > 0) {
    console.log('  只有部分接口被拦 → 更像「该接口未开通」，去 SIS 控制台「开通管理」按接口开通。');
  } else if (notSub.length) {
    console.log('  报 not subscribe → 服务未开通，去 SIS 控制台「开通管理」，按项目开通（注意项目维度）。');
  } else {
    console.log('  既有成功也有其他错误，逐行看上面的 errorCode。');
  }
  console.log('');
})();
