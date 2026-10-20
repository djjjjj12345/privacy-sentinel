/**
 * providers/huawei-sis.js — 华为云 SIS 录音文件识别转写器
 * ---------------------------------------------------------------
 * 为什么单独存在：华为云 MaaS 预置多模态模型没有音频直传入参，
 * 真正的国产化音频链路是「OBS 临时落地 → SIS 异步转写 → 文本」。
 *
 * 流程：
 *   1. 把音频 buffer 上传到 OBS 临时对象 tmp/sis/{uuid}.{ext}
 *   2. 提交 SIS 录音文件识别任务，拿 job_id
 *   3. 轮询查询结果（1s 间隔，最长 60s）
 *   4. 拼接 segments 里的转写文本
 *   5. finally 删除 OBS 临时对象（删除失败只记日志，不覆盖原始错误）
 *
 * 依赖（均为华为云官方 SDK，Apache-2.0）：
 *   @huaweicloud/huaweicloud-sdk-sis   录音文件识别（pushTranscriberJobs / collectTranscriberJob）
 *   esdk-obs-nodejs                    OBS 上传 / 删除
 *   @huaweicloud/huaweicloud-sdk-core  BasicCredentials（AK/SK + ProjectId 签名）
 *
 * 可测试性：所有云调用通过 getClients() 拿客户端，测试用 setClients()
 * 注入 mock，不触碰真实 SDK、不产生费用、不需要真实凭证。
 *
 * 环境变量：
 *   HW_AK / HW_SK / HW_PROJECT_ID   访问密钥与项目 ID（IAM）
 *   HW_REGION                       区域，如 cn-north-4
 *   HW_SIS_ENDPOINT                 SIS 服务端点，如 https://sis.cn-north-4.myhuaweicloud.com
 *   HW_OBS_BUCKET                   临时落地的 OBS 桶名
 *   HW_OBS_ENDPOINT                 OBS 服务端点，如 https://obs.cn-north-4.myhuaweicloud.com
 *   HW_SIS_PROPERTY                 模型特征串（默认 chinese_16k_media）
 */
'use strict';
const crypto = require('crypto');
const logger = require('../logger');
const { UpstreamError, AUDIO_MIME_TO_FORMAT } = require('./common');

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 60000;
const PROVIDER = 'huawei-sis';

/** 终态集合（大写），命中即停止轮询 */
const STATUS_DONE = new Set(['FINISHED', 'SUCCESS', 'SUCCEEDED', 'COMPLETED']);
const STATUS_FAILED = new Set(['FAILED', 'ERROR', 'CANCELED', 'CANCELLED']);

// —— 客户端注入（测试用） ——
let _clients = null;
function setClients(clients) { _clients = clients; }
function resetClients() { _clients = null; }

function isConfigured() {
  return Boolean(
    process.env.HW_AK && process.env.HW_SK && process.env.HW_PROJECT_ID &&
    process.env.HW_REGION && process.env.HW_SIS_ENDPOINT &&
    process.env.HW_OBS_BUCKET && process.env.HW_OBS_ENDPOINT
  );
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new UpstreamError(
      `未配置 ${name}，SIS 音频转写不可用。请按 docs/huawei-deploy.md 第 6 节配置华为云 SIS + OBS。`,
      500
    );
  }
  return v;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 mime 或文件名推扩展名，给 OBS key 用 */
function extFromMime(mimeType, filename) {
  if (mimeType && AUDIO_MIME_TO_FORMAT[mimeType]) return AUDIO_MIME_TO_FORMAT[mimeType];
  if (filename) {
    const m = String(filename).match(/\.([a-z0-9]+)$/i);
    if (m) return m[1].toLowerCase();
  }
  return 'bin';
}

/**
 * 构造 SIS 要读的 OBS 对象 URL（虚拟主机风格）。
 * 例：bucket=ps-audio, endpoint=https://obs.cn-north-4.myhuaweicloud.com, key=tmp/sis/x.wav
 *   → https://ps-audio.obs.cn-north-4.myhuaweicloud.com/tmp/sis/x.wav
 */
function buildObsUrl(bucket, key, obsEndpoint) {
  const host = String(obsEndpoint).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return `https://${bucket}.${host}/${encodeURI(key)}`;
}

/**
 * 用官方 SDK 创建客户端（生产路径）。懒加载，避免测试 require 时触发。
 * 返回 { sis, obs }，obs 的 putObject/deleteObject 已包装成 Promise。
 */
function createClientsFromEnv() {
  const ak = requireEnv('HW_AK');
  const sk = requireEnv('HW_SK');
  const projectId = requireEnv('HW_PROJECT_ID');
  const sisEndpoint = requireEnv('HW_SIS_ENDPOINT');
  const obsEndpoint = requireEnv('HW_OBS_ENDPOINT');

  const { SisClient } = require('@huaweicloud/huaweicloud-sdk-sis');
  const { BasicCredentials } = require('@huaweicloud/huaweicloud-sdk-core/auth/BasicCredentials');

  const sis = SisClient.newBuilder()
    .withCredential(new BasicCredentials().withAk(ak).withSk(sk).withProjectId(projectId))
    .withEndpoint(sisEndpoint)
    .build();

  const ObsClient = require('esdk-obs-nodejs');
  const rawObs = new ObsClient({
    access_key_id: ak,
    secret_access_key: sk,
    server: obsEndpoint,
  });
  const promisify = (fn) => (param) => new Promise((resolve, reject) => {
    fn.call(rawObs, param, (err, result) => (err ? reject(err) : resolve(result)));
  });
  const obs = {
    putObject: promisify(rawObs.putObject),
    deleteObject: promisify(rawObs.deleteObject),
  };

  return { sis, obs };
}

function getClients() {
  return _clients || createClientsFromEnv();
}

/**
 * 提交 SIS 录音文件识别任务，返回 job_id。
 */
async function submitJob(sis, obsUrl) {
  const { PostTranscriberJobs, PushTranscriberJobsRequest, TranscriberConfig } = require('@huaweicloud/huaweicloud-sdk-sis');

  const config = new TranscriberConfig()
    .withAudioFormat('auto')
    .withProperty(process.env.HW_SIS_PROPERTY || 'chinese_16k_media')
    .withAddPunc('yes')
    .withDigitNorm('yes');

  const body = new PostTranscriberJobs().withConfig(config).withDataUrl(obsUrl);
  const req = new PushTranscriberJobsRequest().withBody(body);

  let resp;
  try {
    resp = await sis.pushTranscriberJobs(req);
  } catch (e) {
    throw new UpstreamError(
      `SIS 提交识别任务失败：${(e && e.message) || String(e)}`,
      502
    );
  }
  const jobId = resp && resp.jobId;
  if (!jobId) {
    throw new UpstreamError('SIS 提交识别任务未返回 job_id', 502);
  }
  return jobId;
}

/**
 * 轮询查询结果，直到终态或超时。
 */
async function pollUntilDone(sis, jobId) {
  const { CollectTranscriberJobRequest } = require('@huaweicloud/huaweicloud-sdk-sis');
  const timeoutMs = Number(process.env.HW_SIS_POLL_TIMEOUT_MS) || POLL_TIMEOUT_MS;
  const intervalMs = Number(process.env.HW_SIS_POLL_INTERVAL_MS) || POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let resp;
    try {
      resp = await sis.collectTranscriberJob(new CollectTranscriberJobRequest().withJobId(jobId));
    } catch (e) {
      throw new UpstreamError(
        `SIS 查询识别结果失败：${(e && e.message) || String(e)}`,
        502
      );
    }

    const status = String((resp && resp.status) || '').toUpperCase();
    if (STATUS_DONE.has(status)) return resp;
    if (STATUS_FAILED.has(status)) {
      throw new UpstreamError(`SIS 转写失败（status=${status}，job_id=${jobId}）`, 502);
    }
    if (Date.now() >= deadline) {
      throw new UpstreamError(
        `SIS 转写轮询超时（${timeoutMs / 1000}s 内未完成，job_id=${jobId}）`,
        504
      );
    }
    await sleep(intervalMs);
  }
}

/** 从 FINISHED 响应里拼出纯文本与时长 */
function extractText(resp) {
  const segments = Array.isArray(resp && resp.segments) ? resp.segments : [];
  const text = segments
    .map((s) => (s && s.result && s.result.text) || '')
    .filter(Boolean)
    .join('');
  const durationMs = typeof resp.audioDuration === 'number' && resp.audioDuration > 0
    ? Math.round(resp.audioDuration * 1000)
    : null;
  return { text, durationMs };
}

/**
 * 转写一段音频。
 * @param {object} input
 * @param {Buffer}  input.buffer    音频二进制
 * @param {string} [input.mimeType] 如 audio/wav
 * @param {string} [input.filename] 仅用于推扩展名
 * @returns {Promise<{text:string, durationMs:number|null, provider:string}>}
 */
async function transcribe({ buffer, mimeType, filename } = {}) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new UpstreamError('缺少音频 buffer', 400);
  }

  const bucket = requireEnv('HW_OBS_BUCKET');
  const obsEndpoint = requireEnv('HW_OBS_ENDPOINT');
  const { sis, obs } = getClients();

  const ext = extFromMime(mimeType, filename);
  const key = `tmp/sis/${crypto.randomUUID()}.${ext}`;
  const obsUrl = buildObsUrl(bucket, key, obsEndpoint);

  let uploaded = false;
  try {
    try {
      await obs.putObject({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType || 'application/octet-stream',
      });
      uploaded = true;
    } catch (e) {
      throw new UpstreamError(
        `OBS 上传失败：${(e && e.message) || String(e)}`,
        502
      );
    }

    const jobId = await submitJob(sis, obsUrl);
    const resp = await pollUntilDone(sis, jobId);
    const { text, durationMs } = extractText(resp);

    return { text, durationMs, provider: PROVIDER };
  } finally {
    if (uploaded) {
      try {
        await obs.deleteObject({ Bucket: bucket, Key: key });
      } catch (e) {
        // 删除失败不致命：临时对象有生命周期兜底，且不能覆盖原始错误
        logger.warn('[sis] 删除 OBS 临时对象失败', { key, error: (e && e.message) || String(e) });
      }
    }
  }
}

module.exports = {
  name: PROVIDER,
  isConfigured,
  transcribe,
  // 测试 / 诊断钩子
  setClients,
  resetClients,
  // 暴露给单测的常量与纯函数
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  buildObsUrl,
  extFromMime,
  extractText,
};
