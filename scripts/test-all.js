/**
 * 一键运行所有测试套件：
 *   ① scripts/check.js              — 离线自检（mock 方舟服务，65+ 项）
 *   ② scripts/test-logger.js        — 日志脱敏（10+ 项）
 *   ③ scripts/test-local-extended.js — 本地正则引擎扩展（16+ 项）
 *   ④ scripts/test-server.js        — HTTP 层（12 项）
 *   ⑤ scripts/test-end-to-end.js    — 端到端 AI 流程（11 项）
 *   ⑥ scripts/test-auth-history.js  — 账号认证 + 云端历史（22 项）
 *   ⑦ scripts/test-huawei-cloud.js  — 华为云 Provider / RDS / Redis 适配（32 项）
 *   ⑧ scripts/test-huawei-sis.js    — SIS 音频转写流水线（52 项）
 *   ⑨ scripts/test-ux-hardening.js  — 体验加固：错误分类 / 安全头 / 批量 / 密钥（81 项）
 *   ⑩ scripts/test-frontend-dom.js  — 前端交互（jsdom 真实点击）：主题 / 隐私弹窗 / 批量 / 报告 / 本地模式 / 脱敏导出（107 项）
 *   ⑪ scripts/test-v36-hardening.js — 隐私优先加固：抗变形 / 双端同源 / 位置映射 / SSRF 守卫（26 项）
 *
 * 用法：node scripts/test-all.js
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  { name: '离线自检',     file: 'check.js',                weight: '核心 65+ 项' },
  { name: '日志脱敏',     file: 'test-logger.js',          weight: '10+ 项' },
  { name: '本地正则扩展',  file: 'test-local-extended.js',  weight: '16+ 项' },
  { name: 'HTTP 层',      file: 'test-server.js',          weight: '12 项' },
  { name: '端到端 AI',    file: 'test-end-to-end.js',      weight: '11 项' },
  { name: '账号与历史',   file: 'test-auth-history.js',    weight: '22 项' },
  { name: '华为云适配',   file: 'test-huawei-cloud.js',    weight: '32 项' },
  { name: 'SIS 音频转写', file: 'test-huawei-sis.js',      weight: '52 项' },
  { name: '体验加固',     file: 'test-ux-hardening.js',    weight: '81 项' },
  { name: '前端交互',     file: 'test-frontend-dom.js',    weight: '107 项' },
  { name: '隐私优先加固', file: 'test-v36-hardening.js',   weight: '26 项' },
];

let totalPass = 0, totalFail = 0, suiteResults = [];

console.log('========================================');
console.log('  隐私哨兵 · 全套测试');
console.log('========================================\n');

for (const s of suites) {
  const file = path.join(__dirname, s.file);
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (r.stdout || '') + (r.stderr || '');
  // 兼容多种输出格式：
  //   "通过 69 项，失败 0 项" | "通过 10/10" | "通过 16 / 失败 0" | "X 通过 / Y 失败 / 共 Z"
  let pass = 0, fail = 0;
  const m1 = out.match(/通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项/);
  const m4 = out.match(/通过\s*(\d+)\s*\/\s*失败\s*(\d+)/);
  const m3 = out.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败\s*\/\s*共\s*(\d+)/);
  const m2 = out.match(/通过\s*(\d+)\s*\/\s*(\d+)/);  // "10/10" 全过；"通过 10/10" 也命中
  if (m1) { pass = +m1[1]; fail = +m1[2]; }
  else if (m3) { pass = +m3[1]; fail = +m3[2]; }
  else if (m4) { pass = +m4[1]; fail = +m4[2]; }
  else if (m2) { pass = +m2[1]; fail = +m2[2] - pass; }
  if (r.status !== 0 && fail === 0) fail = 1;
  totalPass += pass;
  totalFail += fail;
  const status = fail === 0 ? '✅' : '❌';
  console.log(`${status}  ${s.name.padEnd(10, ' ')}  ${s.weight.padEnd(12, ' ')}  ${pass} 通过 / ${fail} 失败${fail > 0 ? '\n' + out.split('\n').filter(l => l.includes('❌')).map(l => '     ' + l.trim()).join('\n') : ''}`);
  suiteResults.push({ name: s.name, pass, fail });
}

console.log(`\n========================================`);
console.log(`  总计：${totalPass} 通过 / ${totalFail} 失败 / ${totalPass + totalFail} 项`);
console.log(`========================================`);
process.exit(totalFail === 0 ? 0 : 1);
