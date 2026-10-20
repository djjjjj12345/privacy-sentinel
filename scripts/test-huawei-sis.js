/**
 * 华为云 SIS 音频转写专项测试
 * ---------------------------------------------------------------
 * 覆盖：
 *   A. 配置判定（缺任一变量即视为未配置）
 *   B. 能力声明（capabilities.audio 随 SIS 配置动态变化）
 *   C. 纯函数（OBS URL 拼接、扩展名推断、转写结果拼接）
 *   D. 主流程（上传 → 提交 → 轮询 → 删除，四步顺序与参数）
 *   E. 失败路径（OBS 上传失败、SIS 任务失败、轮询超时）
 *   F. 收尾语义（删除失败不覆盖结果、空转写不报错）
 *   G. 轮询细节（多轮 WAITING/RUNNING/终态别名、extractText 边界值）
 *   H. 上层集成（huawei.analyzeAudio：SIS 转写 → MaaS 文本模型 → items）
 *
 * 全程通过 setClients() 注入 mock，不触网、不需要真实凭证、不产生费用。
 * 用法：node scripts/test-huawei-sis.js
 */
'use strict';

// —— 环境必须在 require 业务模块之前设置 ——
process.env.HW_AK = 'test-ak';
process.env.HW_SK = 'test-sk';
process.env.HW_PROJECT_ID = 'test-project';
process.env.HW_REGION = 'cn-north-4';
process.env.HW_SIS_ENDPOINT = 'https://sis-ext.cn-north-4.myhuaweicloud.com';
process.env.HW_OBS_BUCKET = 'ps-test-bucket';
process.env.HW_OBS_ENDPOINT = 'https://obs.cn-north-4.myhuaweicloud.com';
// 轮询间隔压到 1ms：多轮轮询测试不必真的等 1 秒
process.env.HW_SIS_POLL_INTERVAL_MS = '1';
// MaaS 配置：analyzeAudio 集成测试只需要"有配置"，网络由 axios mock 拦掉
process.env.HW_MAAS_BASE_URL = 'https://maas.cn-southwest-2.myhuaweicloud.com/v1';
process.env.HW_MAAS_API_KEY = 'test-maas-key';

const axios = require('axios');
const sis = require('../services/providers/huawei-sis');
const huawei = require('../services/providers/huawei');

let pass = 0;
let fail = 0;
const log = (ok, name, info) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}${info ? '  ·  ' + info : ''}`);
};

/** 造一个可控的假云：记录调用顺序与参数 */
function mkCloud(overrides = {}) {
  const calls = [];
  // collectSeq：模拟多轮轮询（前 n-1 次返回值，最后一次之后固定重复最后一个）
  const queue = Array.isArray(overrides.collectSeq) ? overrides.collectSeq.slice() : null;
  const cloud = {
    calls,
    obs: {
      putObject: async (p) => {
        calls.push(['put', p]);
        if (overrides.putError) throw new Error(overrides.putError);
        return {};
      },
      deleteObject: async (p) => {
        calls.push(['delete', p]);
        if (overrides.deleteError) throw new Error(overrides.deleteError);
        return {};
      },
    },
    sis: {
      pushTranscriberJobs: async () => {
        calls.push(['push']);
        if (overrides.pushError) throw new Error(overrides.pushError);
        return overrides.noJobId ? {} : { jobId: 'job-test-1' };
      },
      // 极速版：同步返回；入参是桶名 + 对象 key，不是 data_url
      recognizeFlashAsr: async (req) => {
        calls.push(['flash', req && req.obs_bucket_name, req && req.obs_object_key, req && req.audio_format]);
        if (overrides.flashError) {
          const e = new Error(overrides.flashError);
          if (overrides.flashErrorCode) e.errorCode = overrides.flashErrorCode;
          throw e;
        }
        return overrides.flashResult || {
          flashResult: {
            status: 'FINISHED',
            audio_duration: 3210,
            segments: [
              { result: { text: '我的手机号是' } },
              { result: { text: '13800138000' } },
            ],
          },
        };
      },
      collectTranscriberJob: async () => {
        calls.push(['collect']);
        if (overrides.collectError) throw new Error(overrides.collectError);
        if (queue) return queue.length > 1 ? queue.shift() : queue[0];
        return overrides.collectResult || {
          status: 'FINISHED',
          audioDuration: 3.2,
          segments: [
            { result: { text: '我的身份证号是' } },
            { result: { text: '110105199003071234' } },
          ],
        };
      },
    },
  };
  return cloud;
}

/** 一段真实可解析的 16k/16bit/单声道 WAV（0.1 秒正弦音）。
 *  不能再用 'fake-audio-bytes' 这类假数据：转码环节会真的去解析它。 */
function makeWav(seconds = 0.1, sampleRate = 16000) {
  const n = Math.round(sampleRate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), 44 + i * 2);
  }
  return b;
}

const AUDIO = {
  buffer: makeWav(),
  mimeType: 'audio/wav',
  filename: 'voice.wav',
};

(async () => {
  // ================= A. 配置判定 =================
  log(sis.isConfigured() === true, '全部变量齐全时 isConfigured() 为 true');

  const savedBucket = process.env.HW_OBS_BUCKET;
  delete process.env.HW_OBS_BUCKET;
  log(sis.isConfigured() === false, '缺 HW_OBS_BUCKET 时 isConfigured() 为 false');
  process.env.HW_OBS_BUCKET = savedBucket;

  // ================= B. 能力声明 =================
  log(huawei.capabilities.audio === true, 'SIS 已配置时 capabilities.audio 为 true');

  const savedAk = process.env.HW_AK;
  delete process.env.HW_AK;
  log(huawei.capabilities.audio === false, 'SIS 未配置时 capabilities.audio 回落为 false');
  log(sis.isConfigured() === false, 'SIS 未配置时 isConfigured() 为 false（不会假成功）');
  process.env.HW_AK = savedAk;

  // ================= C. 纯函数 =================
  const url = sis.buildObsUrl('ps-audio', 'tmp/sis/a b.wav', 'https://obs.cn-north-4.myhuaweicloud.com/');
  log(
    url === 'https://ps-audio.obs.cn-north-4.myhuaweicloud.com/tmp/sis/a%20b.wav',
    'OBS URL 拼接（虚拟主机风格、去协议尾斜杠、key 转义）',
    url
  );

  log(
    sis.extFromMime('audio/mpeg', 'x.bin') === 'mp3' &&
    sis.extFromMime('audio/wav', 'x.bin') === 'wav' &&
    sis.extFromMime('', 'unknown.ogg') === 'ogg' &&
    sis.extFromMime('', 'noext') === 'bin',
    '扩展名推断：mime 优先，其次文件后缀，兜底 bin'
  );

  log(
    sis.extractText({
      audioDuration: 3.2,
      segments: [{ result: { text: '甲' } }, { result: { text: '乙' } }, {}],
    }).text === '甲乙',
    '转写结果：多段 segments 顺序拼接，空段跳过'
  );

  // ================= D. 主流程（普通版） =================
  // 默认 HW_SIS_MODE=auto 会先走极速版，这一段要测的是普通版，所以显式指定
  const savedMode = process.env.HW_SIS_MODE;
  process.env.HW_SIS_MODE = 'standard';
  const cloud = mkCloud();
  sis.setClients(cloud);
  const r = await sis.transcribe(AUDIO);

  log(r.text === '我的身份证号是110105199003071234', '正常转写返回完整文本', JSON.stringify(r.text));
  log(r.durationMs === 3200, 'audioDuration 秒换算为 durationMs', String(r.durationMs));
  log(r.provider === 'huawei-sis', '返回值标注转写来源 provider');

  const put = cloud.calls.find((c) => c[0] === 'put');
  const del = cloud.calls.find((c) => c[0] === 'delete');
  // 普通版只接受裸 PCM，所以落地的必须是 .pcm（不是原始 wav/mp3）
  log(
    Boolean(put) && /^tmp\/sis\/[0-9a-f-]{36}\.pcm$/.test(put[1].Key),
    'OBS 对象落在 tmp/sis/{uuid}.pcm（普通版只吃裸 PCM）',
    put && put[1].Key
  );
  log(
    put && put[1].ContentType === 'application/octet-stream',
    '裸 PCM 的 ContentType 为 octet-stream（不是 audio/wav）'
  );
  log(
    put && put[1].Body.length === 3200,
    '上传的是转码后的 PCM（0.1s × 16k × 2 字节 = 3200）',
    put && String(put[1].Body.length)
  );

  const order = cloud.calls.map((c) => c[0]).join('>');
  log(order === 'put>push>collect>delete', '四步顺序：上传 → 提交 → 轮询 → 删除', order);

  log(del && put && del[1].Key === put[1].Key, '删除的就是上传的同一个对象（无残留）');

  // ================= E. 失败路径 =================
  const c1 = mkCloud({ putError: 'AccessDenied' });
  sis.setClients(c1);
  let e1 = null;
  try { await sis.transcribe(AUDIO); } catch (e) { e1 = e; }
  log(
    e1 && e1.status === 502 && /OBS 上传失败/.test(e1.message),
    'OBS 上传失败 → UpstreamError 502',
    e1 && `${e1.status} ${e1.message.slice(0, 30)}`
  );
  log(!c1.calls.some((c) => c[0] === 'push'), '上传失败后不再提交 SIS（不浪费配额）');

  const c2 = mkCloud({ noJobId: true });
  sis.setClients(c2);
  let e2 = null;
  try { await sis.transcribe(AUDIO); } catch (e) { e2 = e; }
  log(e2 && e2.status === 502 && /job_id/.test(e2.message), 'SIS 未返回 job_id → 502');
  log(c2.calls.some((c) => c[0] === 'delete'), 'SIS 失败时临时对象仍被删除');

  const c3 = mkCloud({
    collectResult: { status: 'FAILED' },
  });
  sis.setClients(c3);
  let e3 = null;
  try { await sis.transcribe(AUDIO); } catch (e) { e3 = e; }
  log(
    e3 && e3.status === 502 && /job-test-1/.test(e3.message),
    'SIS 任务 FAILED → 502 且带 job_id 便于排障'
  );

  // 轮询超时：把时钟往前拨，避免真的等 60 秒
  const c4 = mkCloud({ collectResult: { status: 'RUNNING' } });
  sis.setClients(c4);
  const realNow = Date.now;
  let tick = 0;
  Date.now = () => realNow() + (tick++ === 0 ? 0 : 10 * 60 * 1000);
  let e4 = null;
  try { await sis.transcribe(AUDIO); } catch (e) { e4 = e; }
  Date.now = realNow;
  log(
    e4 && e4.status === 504 && /超时/.test(e4.message),
    '轮询超过 60s 上限 → 504（不无限挂起）',
    e4 && String(e4.status)
  );

  // ================= F. 收尾语义 =================
  const c5 = mkCloud({ deleteError: 'NoSuchBucket' });
  sis.setClients(c5);
  let r5 = null;
  let e5 = null;
  try { r5 = await sis.transcribe(AUDIO); } catch (e) { e5 = e; }
  log(
    !e5 && r5 && r5.text.length > 0,
    '删除临时对象失败不影响转写结果（只记日志）'
  );

  const c6 = mkCloud({ collectResult: { status: 'FINISHED', segments: [] } });
  sis.setClients(c6);
  const r6 = await sis.transcribe(AUDIO);
  // 空 segments 时 text 为空串；时长回落到转码后的 PCM 长度（0.1s WAV → 100ms）
  log(r6.text === '' && r6.durationMs === 100, '静音/空转写返回空字符串而非抛错', `durationMs=${r6.durationMs}`);

  // ================= F2. 极速版（obs 桶名 + key，同步返回） =================
  process.env.HW_SIS_MODE = 'flash';

  // mp3 原样上传，不转码
  const cF1 = mkCloud();
  sis.setClients(cF1);
  const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(2048)]);
  const rF1 = await sis.transcribe({ buffer: mp3, mimeType: 'audio/mpeg', filename: 'a.mp3' });
  const flashCall = cF1.calls.find((c) => c[0] === 'flash');
  log(
    rF1.text === '我的手机号是13800138000',
    '极速版返回文本（segments 拼接）',
    JSON.stringify(rF1.text)
  );
  log(
    flashCall && flashCall[1] === process.env.HW_OBS_BUCKET && /\.mp3$/.test(flashCall[2] || ''),
    '极速版传的是桶名 + 对象 key，且 mp3 未被转码',
    flashCall && `${flashCall[1]} / ${flashCall[2]}`
  );
  log(flashCall && flashCall[3] === 'mp3', '极速版 audio_format = mp3（原样提交）');
  log(rF1.provider === 'huawei-sis-flash', 'provider 标记为 huawei-sis-flash');
  log(
    cF1.calls.filter((c) => c[0] === 'delete').length === 1,
    '极速版同样用完即删 OBS 临时对象'
  );

  // 裸 pcm 不在极速版支持列表里 → 包成 wav 再传
  const cF2 = mkCloud();
  sis.setClients(cF2);
  // 裸 PCM（无容器头）：ffmpeg 解不了，应按目标格式透传再包 wav
  const rawPcm = Buffer.alloc(3200);
  for (let i = 0; i < rawPcm.length / 2; i++) rawPcm.writeInt16LE(1000, i * 2);
  await sis.transcribe({ buffer: rawPcm, mimeType: 'application/octet-stream', filename: 'x.pcm' });
  const flashCall2 = cF2.calls.find((c) => c[0] === 'flash');
  log(
    flashCall2 && /\.wav$/.test(flashCall2[2] || '') && flashCall2[3] === 'wav',
    '裸 pcm 被包成 wav 后再提交（极速版不认裸流）',
    flashCall2 && flashCall2[2]
  );

  // 模型映射：极速版只支持 8k_common / 16k_conversation
  const savedProp = process.env.HW_SIS_PROPERTY;
  process.env.HW_SIS_PROPERTY = 'chinese_16k_media';
  log(
    sis.resolveFlashProperty() === 'chinese_16k_conversation',
    '极速版不支持 chinese_16k_media 时降级为 chinese_16k_conversation'
  );
  process.env.HW_SIS_PROPERTY = 'chinese_8k_common';
  log(sis.resolveFlashProperty() === 'chinese_8k_common', '极速版支持的 property 原样保留');
  process.env.HW_SIS_PROPERTY = savedProp;

  // extractFlashText 边界
  log(sis.extractFlashText(null).text === '', 'extractFlashText(null) 不抛错、返回空串');
  log(
    sis.extractFlashText({ segments: [{ result: { text: '甲' } }, { result: null }, {}] }).text === '甲',
    'extractFlashText 跳过空段'
  );
  log(
    sis.extractFlashText({ flash_result: { segments: [{ result: { text: '乙' } }], audio_duration: 2000 } })
      .durationMs === 2000,
    'extractFlashText 兼容蛇形 flash_result 与 audio_duration'
  );

  // ================= F3. auto 模式：极速版未开通 → 回退普通版 =================
  process.env.HW_SIS_MODE = 'auto';
  const cF3 = mkCloud({ flashError: 'not subscribe this service.', flashErrorCode: 'SIS.0004' });
  sis.setClients(cF3);
  const rF3 = await sis.transcribe(AUDIO);
  log(
    rF3.text === '我的身份证号是110105199003071234' && rF3.provider === 'huawei-sis',
    '极速版未开通（SIS.0004）时自动回退普通版',
    rF3.provider
  );

  // 极速版"其他错误"不该被当成未开通而静默回退
  const cF4 = mkCloud({ flashError: 'connect ECONNREFUSED' });
  sis.setClients(cF4);
  let eF4 = null;
  try { await sis.transcribe(AUDIO); } catch (e) { eF4 = e; }
  log(eF4 && eF4.status === 502, '极速版非「未开通」类错误直接抛出（不静默回退）');

  process.env.HW_SIS_MODE = 'standard'; // 后续 H 段仍测普通版

  // ================= G. 轮询细节与 extractText 边界 =================
  const c7 = mkCloud({
    collectSeq: [
      { status: 'WAITING' },
      { status: 'RUNNING' },
      { status: 'FINISHED', audioDuration: 1.5, segments: [{ result: { text: '多轮' } }] },
    ],
  });
  sis.setClients(c7);
  const r7 = await sis.transcribe(AUDIO);
  const collectTimes = c7.calls.filter((c) => c[0] === 'collect').length;
  log(
    r7.text === '多轮' && collectTimes === 3,
    '多轮轮询 WAITING → RUNNING → FINISHED（collect 3 次）',
    `collect×${collectTimes}`
  );

  let aliasOk = true;
  for (const status of ['SUCCESS', 'SUCCEEDED', 'COMPLETED']) {
    const ca = mkCloud({
      collectResult: { status, audioDuration: 1, segments: [{ result: { text: status } }] },
    });
    sis.setClients(ca);
    const ra = await sis.transcribe(AUDIO);
    if (ra.text !== status) aliasOk = false;
  }
  log(aliasOk, '终态别名 SUCCESS / SUCCEEDED / COMPLETED 都能停止轮询');

  log(
    [null, undefined, 0, -1, '3.2'].every(
      (v) => sis.extractText({ audioDuration: v, segments: [] }).durationMs === null
    ),
    'audioDuration 为 null/undefined/0/负数/字符串 → durationMs 为 null（不产出 NaN）'
  );

  log(
    sis.extractText({
      audioDuration: 1,
      segments: [null, { result: null }, { result: { text: '' } }, { result: { text: '甲' } }],
    }).text === '甲' && sis.extractText({}).text === '',
    'segments 含 null / result 为空 / text 空串时跳过，缺 segments 不报错'
  );

  // ================= H. analyzeAudio 集成（SIS → MaaS 文本模型） =================
  const realPost = axios.post;
  const requests = [];
  axios.post = async (url, body) => {
    requests.push({ url, body });
    return {
      status: 200,
      data: {
        id: 'chatcmpl-sis-test',
        choices: [{
          message: {
            content: JSON.stringify({
              hasSensitive: true,
              items: [{ type: 'id', text: '110105199003071234', level: 'L3' }],
              transcript: '我的身份证号是110105199003071234',
              advice: '不要在聊天中发送身份证号',
              summary: '含 1 项敏感信息',
            }),
          },
        }],
      },
    };
  };

  const DATA_URL = `data:audio/wav;base64,${AUDIO.buffer.toString('base64')}`;

  // H1. 未配置 SIS → 501，且不浪费一次模型调用
  const akBackup = process.env.HW_AK;
  delete process.env.HW_AK;
  let e8 = null;
  try { await huawei.analyzeAudio(DATA_URL); } catch (e) { e8 = e; }
  process.env.HW_AK = akBackup;
  log(e8 && e8.status === 501 && /SIS/.test(e8.message), '未配置 SIS 时 analyzeAudio 抛 501 并指向 SIS');
  log(requests.length === 0, '未配置 SIS 时不会调用 MaaS');

  // H2. 正常链路：SIS 转写 → MaaS 文本模型 → items
  const c8 = mkCloud();
  sis.setClients(c8);
  const r8 = await huawei.analyzeAudio(DATA_URL);
  log(
    r8.ok === true && r8.items.length === 1 && r8.items[0].type === 'id',
    'analyzeAudio 返回 MaaS 解析后的 items',
    r8.items[0] && r8.items[0].masked
  );
  log(r8.transcript === '我的身份证号是110105199003071234', 'analyzeAudio 把 SIS 转写原文带回 transcript');
  log(
    r8.audioDurationMs === 3200 && r8.transcribeProvider === 'huawei-sis',
    'analyzeAudio 标注音频时长与转写来源'
  );
  log(
    requests.length === 1 &&
    /\/chat\/completions$/.test(requests[0].url) &&
    requests[0].body.model === huawei.TEXT_MODEL,
    '转写文本交给 MaaS 文本模型（不是视觉模型）',
    requests[0] && requests[0].body.model
  );
  const sent = JSON.stringify(requests[0].body.messages);
  log(
    sent.includes('---转写开始---') && sent.includes('110105199003071234'),
    'prompt 里带的是转写文本原文'
  );
  log(c8.calls.some((c) => c[0] === 'delete'), '集成链路结束后 OBS 临时对象已删除');

  // H3. 空转写：不调用模型
  requests.length = 0;
  const c9 = mkCloud({ collectResult: { status: 'FINISHED', segments: [] } });
  sis.setClients(c9);
  const r9 = await huawei.analyzeAudio(DATA_URL);
  log(r9.ok === true && r9.items.length === 0 && /为空/.test(r9.advice), '空转写返回空结果与提示');
  log(requests.length === 0, '空转写不调用 MaaS（避免无意义计费）');

  // H4. 转写失败要向上抛，不能伪装成"没检测到"
  const c10 = mkCloud({ collectResult: { status: 'FAILED' } });
  sis.setClients(c10);
  let e10 = null;
  try { await huawei.analyzeAudio(DATA_URL); } catch (e) { e10 = e; }
  log(e10 && e10.status === 502, 'SIS 转写失败时 analyzeAudio 抛 502（不静默吞）');

  axios.post = realPost;

  // ================= 收尾 =================
  sis.resetClients();

  console.log(`\n=== 华为云 SIS 转写：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  sis.resetClients();
  console.error('未捕获异常:', e);
  process.exit(2);
});
