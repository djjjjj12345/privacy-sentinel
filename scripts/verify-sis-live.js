/**
 * verify-sis-live.js — SIS + OBS 真实联调验收脚本（不打 mock，真的调云）
 * ---------------------------------------------------------------
 * 三个检查项，对应 docs/huawei-deploy.md 第 6 节的验收清单：
 *   A. OBS 连通性：上传 → 列出 → 删除 → 再列出（验证 AK/SK、桶名、区域、读写权限）
 *   B. 端到端转写：喂一段真实录音，看 SIS 吐出的文本里有没有身份证号 / 手机号
 *   C. 残留检查：tmp/sis/ 前缀下应为空（转写完必须删干净）
 *
 * 用法：
 *   node scripts/verify-sis-live.js                 # 只做 A + C（不消耗 SIS 配额）
 *   node scripts/verify-sis-live.js --audio a.wav   # 追加 B，用真实录音跑一遍
 *   node scripts/verify-sis-live.js --purge         # 发现残留对象时顺手清掉
 *
 * 说明：
 *   - 会读取项目根目录的 .env（dotenv），不需要手动 export。
 *   - A 阶段用的是本地合成的单频音，不是语音，所以 A 不会提交 SIS 任务，不产生费用。
 *   - B 阶段会真实提交一次录音文件识别任务（SIS 有免费额度，超出后按分钟计费）。
 */
'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sis = require('../services/providers/huawei-sis');

const REQUIRED = [
  'HW_AK', 'HW_SK', 'HW_PROJECT_ID', 'HW_REGION',
  'HW_SIS_ENDPOINT', 'HW_OBS_BUCKET', 'HW_OBS_ENDPOINT',
];

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const audioPath = getArg('--audio');
const purge = args.includes('--purge');

let pass = 0;
let fail = 0;
const log = (ok, name, info) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}${info ? '  ·  ' + info : ''}`);
};
const warn = (name, info) => console.log(`⚠️  ${name}${info ? '  ·  ' + info : ''}`);
const step = (t) => console.log(`\n── ${t} ──`);

/** 合成一段 16kHz / 16bit / 单声道 / 1 秒的 WAV，只用于验证链路，不含语音 */
function makeProbeWav() {
  const rate = 16000;
  const samples = rate;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + buf.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);   // PCM
  header.writeUInt16LE(1, 22);   // 单声道
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(buf.length, 40);
  return Buffer.concat([header, buf]);
}

/** 用官方 SDK 建 OBS 客户端（回调式 → Promise） */
function createObs() {
  const ak = process.env.HW_AK;
  const sk = process.env.HW_SK;
  const server = process.env.HW_OBS_ENDPOINT;
  const ObsClient = require('esdk-obs-nodejs');
  const raw = new ObsClient({ access_key_id: ak, secret_access_key: sk, server });
  const p = (fn) => (param) => new Promise((resolve, reject) => {
    fn.call(raw, param, (err, result) => (err ? reject(err) : resolve(result)));
  });
  return {
    putObject: p(raw.putObject),
    deleteObject: p(raw.deleteObject),
    listObjects: p(raw.listObjects),
  };
}

/**
 * 取 listObjects 结果里的对象 key 列表。
 * 注意：esdk-obs-nodejs 的返回是 { CommonMsg, InterfaceResult }，
 * 对象列表在 InterfaceResult.Contents，不在顶层 —— 读错字段会得到空数组，
 * 让"无残留"这类断言变成假通过。
 */
function listKeys(res) {
  const iface = res && res.InterfaceResult;
  if (!iface) throw new Error('listObjects 返回结构异常：缺少 InterfaceResult');
  const c = iface.Contents;
  const arr = Array.isArray(c) ? c : (c ? [c] : []);
  return arr.map((o) => o && o.Key).filter(Boolean);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 列表接口偶有毫秒级延迟，命中即返回，最多试 3 次 */
async function listKeysUntil(obs, bucket, prefix, predicate) {
  let keys = [];
  for (let i = 0; i < 3; i++) {
    keys = listKeys(await obs.listObjects({ Bucket: bucket, Prefix: prefix, MaxKeys: 100 }));
    if (predicate(keys)) return keys;
    await sleep(200);
  }
  return keys;
}

const EXT_MIME = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
};

function hintFor(errMsg) {
  const m = String(errMsg || '');
  if (/InvalidAccessKeyId/i.test(m)) return 'AK 不对：到「我的凭证 → 访问密钥」核对，注意别把 SK 填进 AK';
  if (/SignatureDoesNotMatch/i.test(m)) return 'SK 不对：SK 只在创建时显示一次，错了只能重建访问密钥';
  if (/NoSuchBucket/i.test(m)) return '桶名或区域不对：桶名要全局唯一，且必须与 HW_OBS_ENDPOINT 同区域';
  if (/AccessDenied|403/i.test(m)) return '没权限：检查账号是否实名/欠费，以及 AK 所在账号是否有该桶的读写权限（建议用 IAM 子账号并授予 OBS Buckets Viewer/Editor）';
  if (/NoSuchKey/i.test(m)) return '对象不存在：可能在别的前缀下，去控制台确认';
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED/i.test(m)) return '网络/端点不通：检查 HW_OBS_ENDPOINT 拼写（要带 https://，不能带桶名）';
  if (/Cannot find module 'uuid'/.test(m)) return "官方 SIS SDK 漏声明依赖，执行 npm i uuid";
  return '看上面的原始报错，对照 docs/huawei-deploy.md 第 6 节';
}

(async () => {
  console.log('========================================');
  console.log('  SIS + OBS 真实联调验收（会真的调云）');
  console.log('========================================');

  // ---------- 0. 环境变量 ----------
  step('0. 环境变量检查');
  const bucket = process.env.HW_OBS_BUCKET || '';
  console.log(`  区域 HW_REGION      = ${process.env.HW_REGION || '(空)'}`);
  console.log(`  SIS  HW_SIS_ENDPOINT= ${process.env.HW_SIS_ENDPOINT || '(空)'}`);
  console.log(`  OBS  桶名           = ${bucket || '(空)'}`);
  console.log(`  OBS  HW_OBS_ENDPOINT= ${process.env.HW_OBS_ENDPOINT || '(空)'}`);
  console.log(`  AK/SK               = ${process.env.HW_AK ? '已设置(前4位 ' + process.env.HW_AK.slice(0, 4) + '…)' : '未设置'}`);
  console.log(`  Project ID          = ${process.env.HW_PROJECT_ID ? '已设置' : '未设置'}`);

  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    log(false, '7 个 HW_* 变量齐全', '缺少：' + missing.join(', '));
    console.log('\n把缺的填进项目根目录的 .env，然后重跑本脚本。');
    console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
    process.exit(1);
  }
  log(true, '7 个 HW_* 变量齐全');
  log(sis.isConfigured() === true, 'sis.isConfigured() 为 true（服务会声明 audio=true）');

  const obs = createObs();

  // ---------- A. OBS 连通性 ----------
  step('A. OBS 连通性（上传 → 列出 → 删除）');
  const probeKey = `tmp/sis/_verify_${crypto.randomUUID()}.wav`;
  try {
    await obs.putObject({
      Bucket: bucket,
      Key: probeKey,
      Body: makeProbeWav(),
      ContentType: 'audio/wav',
    });
    log(true, '上传临时对象成功（AK/SK + 桶写权限 OK）', probeKey);

    const keys1 = await listKeysUntil(obs, bucket, 'tmp/sis/', (ks) => ks.includes(probeKey));
    log(keys1.includes(probeKey), '能在 tmp/sis/ 前缀下列到刚传的对象', `共 ${keys1.length} 个对象`);

    await obs.deleteObject({ Bucket: bucket, Key: probeKey });
    const keys2 = await listKeysUntil(obs, bucket, 'tmp/sis/', (ks) => !ks.includes(probeKey));
    log(!keys2.includes(probeKey), '删除后立即查不到了（deleteObject 生效）');
  } catch (e) {
    log(false, 'OBS 连通性', (e && e.message) || String(e));
    console.log(`  → ${hintFor(e && e.message)}`);
    console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
    process.exit(1);
  }

  // ---------- B. 端到端真实转写 ----------
  step('B. 端到端转写（需要 --audio 指定录音文件）');
  if (!audioPath) {
    warn('跳过：未传 --audio。录一段 5–10 秒含身份证号或手机号的语音，再跑：');
    console.log('     node scripts/verify-sis-live.js --audio 你的录音.wav');
  } else {
    const abs = path.resolve(audioPath);
    if (!fs.existsSync(abs)) {
      log(false, '录音文件存在', abs);
    } else {
      const size = fs.statSync(abs).size;
      log(true, '录音文件存在', `${path.basename(abs)}（${(size / 1024).toFixed(1)} KB）`);
      if (size > 5 * 1024 * 1024) warn('文件超过 5MB，上传和转写都会变慢');

      const mime = EXT_MIME[path.extname(abs).toLowerCase()] || 'audio/wav';
      try {
        const t0 = Date.now();
        const r = await sis.transcribe({
          buffer: fs.readFileSync(abs),
          mimeType: mime,
          filename: path.basename(abs),
        });
        log(r.provider === 'huawei-sis', '转写来源为 huawei-sis', r.provider);
        log(Boolean(r.text), '拿到转写文本', JSON.stringify(r.text));
        console.log(`  时长：${r.durationMs != null ? r.durationMs + 'ms' : '未提供'}   耗时：${Date.now() - t0}ms`);

        const hasId = /\b\d{17}[\dXx]\b/.test(r.text.replace(/\s/g, ''));
        const hasPhone = /\b1[3-9]\d{9}\b/.test(r.text.replace(/\s/g, ''));
        log(hasId || hasPhone, '转写文本里识别出身份证号或手机号',
          hasId ? '身份证号 ✔' : (hasPhone ? '手机号 ✔' : '都没匹配到'));
        if (!hasId && !hasPhone) {
          warn('可能是录音不清晰、采样率不是 16k，或 HW_SIS_PROPERTY 选错了。' +
               '试试 HW_SIS_PROPERTY=chinese_8k_common，或重新录一段更清楚的。');
        }
      } catch (e) {
        log(false, '端到端转写', `${e && e.status ? e.status + ' ' : ''}${(e && e.message) || String(e)}`);
        console.log(`  → ${hintFor(e && e.message)}`);
      }
    }
  }

  // ---------- C. 残留检查 ----------
  step('C. 残留检查（tmp/sis/ 下应为 0 个对象）');
  try {
    const res = await obs.listObjects({ Bucket: bucket, Prefix: 'tmp/sis/', MaxKeys: 100 });
    const leftover = listKeys(res).filter((k) => !k.includes('_verify_'));
    if (leftover.length === 0) {
      log(true, 'tmp/sis/ 下无残留对象（转写用完即删生效）');
    } else {
      log(false, 'tmp/sis/ 下无残留对象', `发现 ${leftover.length} 个：${leftover.slice(0, 5).join(', ')}…`);
      if (purge) {
        for (const k of leftover) {
          await obs.deleteObject({ Bucket: bucket, Key: k });
        }
        console.log(`  已清理 ${leftover.length} 个残留对象`);
      } else {
        console.log('  加 --purge 可以顺手清掉；长期建议在桶上配「1 天后删除 tmp/sis/」生命周期规则兜底。');
      }
    }
  } catch (e) {
    log(false, '残留检查', (e && e.message) || String(e));
    console.log(`  → ${hintFor(e && e.message)}`);
  }

  console.log(`\n========================================`);
  console.log(`  总计：${pass} 通过 / ${fail} 失败`);
  console.log(`========================================`);
  if (fail === 0 && !audioPath) {
    console.log('下一步：录一段真实录音，跑 --audio 走完整链路（B 阶段）。');
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('未捕获异常:', e);
  console.log(`  → ${hintFor(e && e.message)}`);
  process.exit(2);
});
