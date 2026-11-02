/**
 * 示例 2：Node（ESM）
 * 运行：node sdk/examples/node-esm.mjs
 * 前提：先跑 node scripts/build-sdk.js 生成 dist/privacy-sentinel.esm.mjs
 */
import PrivacySentinel, { detect, mask, analyzeAndMask } from '../dist/privacy-sentinel.esm.mjs';

const text = '联系人：李四 13900139000，卡号 6222021234567890123';

console.log('version:', PrivacySentinel.version);
console.log('detect :', detect(text).map((i) => `${i.label}=${i.masked}`).join(' / '));
console.log('mask   :', mask(text));
console.log('summary:', analyzeAndMask(text).summary);
console.log('ESM 具名导入与默认导入可用 ✅');
