'use strict';

/**
 * 音频转码：任意常见音频 → 华为云 SIS 唯一接受的输入格式
 *   PCM signed 16-bit / 小端 / 16 kHz / 单声道（裸流，无 WAV 头）
 *
 * 为什么要这个模块：
 *   华为云 SIS 录音文件识别的 audio_format 只接受裸 PCM 系列
 *   （pcm16k16bit / pcm8k16bit / ulaw / alaw / vox，见 SDK 的 TranscriberConfigAudioFormatEnum），
 *   **不接受 mp3 / m4a / wav 容器**。传 mp3 时：
 *     - audio_format=mp3 → 提交即拒（SIS.0032 request body invalid）
 *     - audio_format=auto → 任务能建，转写时报 SIS.0535 wrong audio format
 *   两种报错都不指向"容器不受支持"，极易被误判成权限或采样率问题。
 *   所以必须在上传前转成 16k/16bit/单声道裸 PCM。
 *
 * 两条转换路径：
 *   1. WAV → PCM：纯 JS，零依赖，本机就能跑（覆盖大部分测试与浏览器采集场景）
 *   2. 其他（mp3/m4a/aac/ogg/webm）→ PCM：调 ffmpeg。找不到 ffmpeg 时抛带指引的错误。
 *
 * 更彻底的方案是前端就产出 16k PCM（Web Audio 重采样），后端转码只作为兜底。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TARGET_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

/** 解析 WAV，返回 { sampleRate, channels, bitsPerSample, samples: Int16Array } */
function decodeWav(buffer) {
  if (buffer.length < 44) throw new Error('文件太短，不是合法 WAV');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 容器（缺少 RIFF/WAVE 标识）');
  }

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataStart = -1;
  let dataLen = 0;

  let pos = 12;
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('ascii', pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    const body = pos + 8;

    if (id === 'fmt ') {
      audioFormat = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataStart = body;
      dataLen = Math.min(size, buffer.length - body);
      break; // data 之后可能有 LIST 等无关块，提前结束
    }
    pos = body + size + (size % 2); // chunk 按偶数字节对齐
  }

  if (dataStart < 0 || dataLen <= 0) throw new Error('WAV 里找不到 data 块');
  if (!sampleRate || !channels) throw new Error('WAV 头缺少 fmt 信息');
  // 1 = PCM，3 = IEEE float；a-law(6)/mu-law(7) 等交给 ffmpeg 处理
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error(`WAV 编码格式 ${audioFormat} 不支持（仅支持 PCM=1 / float=3）`);
  }
  if (audioFormat === 3 && bitsPerSample !== 32 && bitsPerSample !== 64) {
    throw new Error(`float WAV 仅支持 32/64 位，实际 ${bitsPerSample}`);
  }

  // 帧 = 一次采样点上所有声道的数据；dataLen / (声道数 × 每采样字节)
  const bytesPerFrame = channels * (bitsPerSample / 8);
  const frames = Math.max(0, Math.floor(dataLen / bytesPerFrame));
  const samples = new Int16Array(frames);
  const maxOffset = dataStart + dataLen - (bitsPerSample / 8); // 防止坏文件读越界

  const guard = (off) => (off >= dataStart && off <= maxOffset);

  for (let i = 0; i < samples.length; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const idx = i * channels + c;
      const off = dataStart + idx * (bitsPerSample / 8);
      let v = 0;
      if (!guard(off)) break; // 坏文件：data 长度与实际不符时截断，不让它把进程拖崩
      if (audioFormat === 3) {
        v = bitsPerSample === 64
          ? buffer.readDoubleLE(off) * 32767
          : buffer.readFloatLE(off) * 32767;
      } else if (bitsPerSample === 16) {
        v = buffer.readInt16LE(off);
      } else if (bitsPerSample === 8) {
        v = (buffer.readUInt8(off) - 128) * 256; // 8 位 WAV 是无符号
      } else if (bitsPerSample === 24) {
        v = (buffer[off] | (buffer[off + 1] << 8) | (buffer[off + 2] << 16)) >> 8;
      } else if (bitsPerSample === 32) {
        v = Math.max(-32768, Math.min(32767, buffer.readInt32LE(off) / 65536));
      } else {
        throw new Error(`WAV 位深 ${bitsPerSample} 不支持`);
      }
      sum += v;
    }
    samples[i] = Math.round(sum / channels); // 多声道直接平均成单声道
  }

  return { sampleRate, channels, bitsPerSample, samples };
}

/** 线性插值重采样到 16 kHz */
function resample(samples, srcRate, dstRate = TARGET_RATE) {
  if (srcRate === dstRate) return samples;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcPos - i0;
    out[i] = Math.round(samples[i0] * (1 - frac) + samples[i1] * frac);
  }
  return out;
}

/** 给裸 PCM 加 44 字节 WAV 头（极速版接受 wav，不接受裸 pcm） */
function pcmToWav(pcm, sampleRate = TARGET_RATE, channels = 1, bits = 16) {
  const h = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bits) / 8;
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE((channels * bits) / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function toS16leBuffer(int16) {
  const buf = Buffer.allocUnsafe(int16.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < int16.length; i++) buf.writeInt16LE(int16[i], i * BYTES_PER_SAMPLE);
  return buf;
}

/** 找 ffmpeg：环境变量 → ffmpeg-static 包 → 系统 PATH */
function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  // ffmpeg-static 优先（版本新），但它的 postinstall 要从 GitHub 下二进制，国内常失败，
  // 所以保留 @ffmpeg-installer/ffmpeg 作为备选——它的二进制是随 npm 包分发的，一定能装上。
  for (const mod of ['ffmpeg-static', '@ffmpeg-installer/ffmpeg']) {
    try {
      const m = require(mod);
      const p = typeof m === 'string' ? m : m.path;
      if (p && fs.existsSync(p)) return p;
    } catch (_) {
      /* 没装就试下一个 */
    }
  }
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], {
    encoding: 'utf8',
  });
  if (which.status === 0 && which.stdout) {
    const first = String(which.stdout).split(/\r?\n/).find((s) => s && s.trim());
    if (first && fs.existsSync(first.trim())) return first.trim();
  }
  return null;
}

/** 用 ffmpeg 把任意音频转成 16k/16bit/单声道裸 PCM */
function ffmpegToPcm16k(buffer, extHint) {
  const bin = findFfmpeg();
  if (!bin) {
    const e = new Error(
      `需要 ffmpeg 才能把 ${extHint || '该格式'} 转成 SIS 要求的 16k/16bit/单声道 PCM。`
        + '安装方式：npm i -D ffmpeg-static（推荐，自动带二进制），或系统安装 ffmpeg 后设置 FFMPEG_PATH。'
        + '更彻底的做法：前端录音时用 Web Audio 重采样成 16k PCM 再上传，后端就不需要转码。'
    );
    e.code = 'NO_FFMPEG';
    throw e;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-audio-'));
  const inFile = path.join(dir, `in.${extHint || 'audio'}`);
  const outFile = path.join(dir, 'out.pcm');
  try {
    fs.writeFileSync(inFile, buffer);
    const r = spawnSync(
      bin,
      ['-y', '-i', inFile, '-vn', '-ar', String(TARGET_RATE), '-ac', '1', '-f', 's16le', outFile],
      { encoding: 'utf8', timeout: 120000 }
    );
    if (r.status !== 0 || !fs.existsSync(outFile)) {
      const tail = String(r.stderr || '').split(/\r?\n/).slice(-6).join(' ');
      throw new Error(`ffmpeg 转码失败：${tail || '未知错误'}`);
    }
    return fs.readFileSync(outFile);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* 临时目录清理失败不影响主流程 */
    }
  }
}

/**
 * 主入口：任意音频 → SIS 可直接使用的裸 PCM
 * @param {Buffer} buffer 原始音频
 * @param {{ext?: string, mimeType?: string}} [opts]
 * @returns {{pcm: Buffer, durationMs: number, source: 'wav-native'|'ffmpeg', srcSampleRate?: number}}
 */
function toSisPcm(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('音频内容为空');
  }
  const isWav = buffer.length > 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WAVE';

  if (isWav) {
    try {
      const { sampleRate, samples } = decodeWav(buffer);
      const pcm = toS16leBuffer(resample(samples, sampleRate));
      return {
        pcm,
        durationMs: Math.round((pcm.length / BYTES_PER_SAMPLE / TARGET_RATE) * 1000),
        source: 'wav-native',
        srcSampleRate: sampleRate,
      };
    } catch (e) {
      // 自研解析兜不住时（如 a-law WAV）交给 ffmpeg
      if (/不支持|找不到|不是 WAV|太短/.test(e.message) && findFfmpeg()) {
        const pcm = ffmpegToPcm16k(buffer, 'wav');
        return {
          pcm,
          durationMs: Math.round((pcm.length / BYTES_PER_SAMPLE / TARGET_RATE) * 1000),
          source: 'ffmpeg',
        };
      }
      throw e;
    }
  }

  // 裸 PCM 流：ffmpeg 解不了没有容器头的裸流（会报 Invalid data found），
  // 而裸流本身通常就是 16k/s16le，直接按目标格式透传（调用方可给 srcSampleRate 修正）
  const ext = String(opts.ext || guessExt(opts.mimeType) || '').toLowerCase();
  if (ext === 'pcm' || ext === 'raw' || ext === 's16le') {
    const srcRate = Number(opts.srcSampleRate) || TARGET_RATE;
    const pcm = srcRate === TARGET_RATE ? buffer : toS16leBuffer(resample(toInt16(buffer), srcRate));
    return {
      pcm,
      durationMs: Math.round((pcm.length / BYTES_PER_SAMPLE / TARGET_RATE) * 1000),
      source: 'pcm-passthrough',
      srcSampleRate: srcRate,
    };
  }

  const pcm = ffmpegToPcm16k(buffer, ext);
  return {
    pcm,
    durationMs: Math.round((pcm.length / BYTES_PER_SAMPLE / TARGET_RATE) * 1000),
    source: 'ffmpeg',
  };
}

/** s16le Buffer → Int16Array */
function toInt16(buf) {
  const out = new Int16Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

function guessExt(mimeType) {
  const m = String(mimeType || '');
  if (m.includes('mp3') || m.includes('mpeg')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('webm')) return 'webm';
  if (m.includes('flac')) return 'flac';
  if (m.includes('wav')) return 'wav';
  return 'audio';
}

module.exports = {
  TARGET_RATE,
  decodeWav,
  resample,
  pcmToWav,
  toS16leBuffer,
  toSisPcm,
  findFfmpeg,
  guessExt,
};
