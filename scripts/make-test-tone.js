/**
 * make-test-tone.js — 生成一段不含任何真实语音的合成测试音频（16kHz / 单声道 / 16bit PCM）
 *
 * 为什么需要它：
 *   验证 SIS 链路是否可用时，不需要真实说话内容——要验证的是
 *   「OBS 能写入 → SIS 能读到桶 → 服务授权委托存在」这三件事。
 *   用合成音即可完成，避免把含真实人声的录音上传到云端。
 *
 * 用法：node scripts/make-test-tone.js [秒数] [输出文件]
 */
const fs = require('fs');
const path = require('path');

const seconds = Number(process.argv[2] || 3);
const out = process.argv[3] || path.join(process.cwd(), 'test-tone-16k.wav');
const RATE = 16000;           // SIS chinese_16k_* 要求 16k 采样率
const freq = 440;             // 440Hz 正弦
const samples = RATE * seconds;

// 振幅做淡入淡出，避免首尾爆音；整体音量压到 0.3 防止过载
const pcm = Buffer.alloc(samples * 2);
for (let i = 0; i < samples; i++) {
  const t = i / RATE;
  const env = Math.min(1, i / (RATE * 0.05), (samples - i) / (RATE * 0.05));
  const v = Math.sin(2 * Math.PI * freq * t) * 0.3 * env;
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);        // fmt chunk size
header.writeUInt16LE(1, 20);         // PCM
header.writeUInt16LE(1, 22);         // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);  // byte rate
header.writeUInt16LE(2, 32);         // block align
header.writeUInt16LE(16, 34);        // bits per sample
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

fs.writeFileSync(out, Buffer.concat([header, pcm]));
console.log('已生成: ' + out + '  ' + (fs.statSync(out).size / 1024).toFixed(0) + 'KB  ' + seconds + '秒  ' + RATE + 'Hz 单声道 16bit');
