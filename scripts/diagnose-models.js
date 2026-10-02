/**
 * 诊断脚本（本地运行，真实调用方舟，消耗极少量额度）
 * 1. 测 mini 模型是否接受 input_audio / input_video（区分 404 模型不存在 vs 400 内容问题）
 * 2. 复现长文本降级为 local-only 的原因（看 warnings）
 */
require('dotenv').config();
const vision = require('../services/visionAnalyzer');

(async () => {
  // --- 测试 1：mini 模型 + input_audio ---
  try {
    const r = await vision.analyzeAudio(
      'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAA'
    );
    console.log('[audio@mini] 成功:', JSON.stringify(r).slice(0, 150));
  } catch (e) {
    console.log('[audio@mini] 失败 status=' + e.status + ':', String(e.message).slice(0, 200));
  }

  // --- 测试 2：mini 模型 + input_video ---
  try {
    const r = await vision.analyzeVideo(
      'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE='
    );
    console.log('[video@mini] 成功:', JSON.stringify(r).slice(0, 150));
  } catch (e) {
    console.log('[video@mini] 失败 status=' + e.status + ':', String(e.message).slice(0, 200));
  }

  // --- 测试 3：长文本降级原因 ---
  const longText = '测试。'.repeat(2000) + '身份证110105199003071239';
  try {
    const r = await vision.analyzeText(longText);
    console.log('[longtext] ok=' + r.ok + ' reason=' + (r.reason || '-') + ' items=' + r.items.length);
    if (r.rawText) console.log('[longtext] rawText 前150字:', r.rawText.slice(0, 150));
  } catch (e) {
    console.log('[longtext] 异常:', e.status, String(e.message).slice(0, 200));
  }
})();
