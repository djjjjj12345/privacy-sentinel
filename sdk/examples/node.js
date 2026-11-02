/**
 * 示例 1：Node（CommonJS）
 * 运行：node sdk/examples/node.js
 */
'use strict';
const PS = require('../src/index.js');

const text = '你好我叫张三，手机号 13800138000，身份证 11010519491231002X，邮箱 zhangsan@example.com';

console.log('SDK 版本：', PS.version);

// 1. 只检测
const items = PS.detect(text);
console.log('\n[detect] 命中 ' + items.length + ' 项：');
items.forEach((i) => console.log(`  L${i.level} ${i.label}  ${i.masked}  [${i.start},${i.end})`));
console.log('  默认不含原文：', items.every((i) => i.raw === undefined));

// 2. 检测 + 脱敏（最常用）
const res = PS.analyzeAndMask(text);
console.log('\n[analyzeAndMask]');
console.log('  摘要：', res.summary);
console.log('  最高等级：L' + res.level + ' ' + res.levelName);
console.log('  脱敏文本：', res.masked);

// 3. 只保留高危 + 替换成标签
console.log('\n[策略：label，只留 L2+]');
console.log('  ', PS.mask(text, { strategy: 'label', minLevel: 2 }));

// 4. 只查手机号
console.log('\n[只查手机号]');
console.log('  ', JSON.stringify(PS.detect(text, { types: ['phone'] })));

// 5. 批量
const batch = PS.detectBatch([text, '没什么敏感内容', 123]);
console.log('\n[detectBatch]');
batch.forEach((r, i) => console.log(`  #${i} ${r.ok ? r.result.summary : '错误：' + r.error}`));

// 6. 单个值脱敏
console.log('\n[desensitize]', PS.desensitize('13800138000', 'phone'));

// 7. 需要原文时显式开启
const withRaw = PS.detect(text, { includeRaw: true });
console.log('\n[includeRaw]', withRaw.map((i) => i.raw).join(', '));
