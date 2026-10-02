/**
 * 真实端到端验证：生成真实 WAV 音频 + 下载真实 MP4 视频，
 * 通过本地服务真调方舟（消耗极少量额度），验证音视频修复是否生效。
 * 用法: node scripts/e2e-real.js [mp4路径(可选)]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');

const analyzer = require('../services/analyzer');

/** 生成 2 秒 16kHz 单声道静音 WAV（合法 RIFF，方舟可接受） */
function makeSilenceWav() {
  const sampleRate = 16000;
  const seconds = 2;
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  // 数据区全 0 = 静音
  return 'data:audio/wav;base64,' + buf.toString('base64');
}

(async () => {
  console.log('--- 1. 真实 WAV（静音 2s）走音频通道 ---');
  try {
    const r = await analyzer.analyzeAudio({ dataUrl: makeSilenceWav() });
    console.log('success:', r.success, '| source:', r.source, '| transcript:', JSON.stringify(r.transcript), '| items:', r.items.length, '| maxLevel:', r.maxLevel);
    if (!r.success) console.log('error:', r.error);
  } catch (e) {
    console.log('异常:', e.message);
  }

  console.log('\n--- 2. 真实 MP4 走视频通道 ---');
  const mp4Path = process.argv[2];
  if (mp4Path && fs.existsSync(mp4Path)) {
    const size = fs.statSync(mp4Path).size;
    console.log('视频文件:', path.basename(mp4Path), (size / 1024).toFixed(0) + 'KB');
    try {
      const dataUrl = 'data:video/mp4;base64,' + fs.readFileSync(mp4Path).toString('base64');
      const r = await analyzer.analyzeVideo({ dataUrl });
      console.log('success:', r.success, '| source:', r.source, '| transcript:', JSON.stringify((r.transcript || '').slice(0, 80)), '| items:', r.items.length, '| maxLevel:', r.maxLevel);
      if (!r.success) console.log('error:', r.error);
    } catch (e) {
      console.log('异常:', e.message);
    }
  } else {
    console.log('跳过（未提供 mp4 路径）');
  }

  console.log('\n--- 3. 超长文本（13000 字，尾部藏身份证）---');
  try {
    const r = await analyzer.analyzeText({ text: '日常寒暄。'.repeat(4000) + ' 身份证 110105199003071239' });
    console.log('success:', r.success, '| source:', r.source, '| items:', r.items.map((i) => i.type).join(','), '| warnings:', JSON.stringify(r.warnings));
  } catch (e) {
    console.log('异常:', e.message);
  }
})();
