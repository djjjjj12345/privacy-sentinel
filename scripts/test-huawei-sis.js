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
process.env.HW_SIS_ENDPOINT = 'https://sis.cn-north-4.myhuaweicloud.com';
process.env.HW_OBS_BUCKET = 'ps-test-bucket';
process.env.HW_OBS_ENDPOINT = 'https://obs.cn-north-4.myhuaweicloud.com';

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
      collectTranscriberJob: async () => {
        calls.push(['collect']);
        if (overrides.collectError) throw new Error(overrides.collectError);
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

const AUDIO = {
  buffer: Buffer.from('fake-audio-bytes'),
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

  // ================= D. 主流程 =================
  const cloud = mkCloud();
  sis.setClients(cloud);
  const r = await sis.transcribe(AUDIO);

  log(r.text === '我的身份证号是110105199003071234', '正常转写返回完整文本', JSON.stringify(r.text));
  log(r.durationMs === 3200, 'audioDuration 秒换算为 durationMs', String(r.durationMs));
  log(r.provider === 'huawei-sis', '返回值标注转写来源 provider');

  const put = cloud.calls.find((c) => c[0] === 'put');
  const del = cloud.calls.find((c) => c[0] === 'delete');
  log(
    Boolean(put) && /^tmp\/sis\/[0-9a-f-]{36}\.wav$/.test(put[1].Key),
    'OBS 对象落在 tmp/sis/{uuid}.wav',
    put && put[1].Key
  );
  log(put && put[1].ContentType === 'audio/wav', 'OBS 上传带 ContentType（便于浏览器直接播放）');

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
  log(r6.text === '' && r6.durationMs === null, '静音/空转写返回空字符串而非抛错');

  // ================= 收尾 =================
  sis.resetClients();

  console.log(`\n=== 华为云 SIS 转写：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  sis.resetClients();
  console.error('未捕获异常:', e);
  process.exit(2);
});
