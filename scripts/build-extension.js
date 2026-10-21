/**
 * 把检测引擎同步到浏览器扩展目录
 * ---------------------------------------------------------------
 * 扩展不允许 require，只能把引擎文件原样带在包里。
 * 但规则绝不能维护两份 —— 否则网页版和扩展的检测结果迟早对不上，
 * 而这种不一致用户根本无法察觉（只会觉得「这个工具时灵时不灵」）。
 *
 * 所以：services/ 是唯一真源，本脚本负责复制，并在文件头写明来源与哈希。
 * 运行：node scripts/build-extension.js [--check]
 *   --check 只校验是否过期，不同步（用于 CI / 测试）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'services');
const OUT_DIR = path.join(ROOT, 'extension', 'engine');

// 顺序即依赖顺序：schema → localDetector → guardCore
const FILES = ['schema.js', 'localDetector.js', 'guardCore.js'];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

function header(name, hash) {
  return [
    '/**',
    ' * ⚠️ 本文件由 scripts/build-extension.js 自动生成，请勿直接修改。',
    ' * 来源：services/' + name + '（哈希 ' + hash + '）',
    ' * 改规则请改 services/ 下的源文件，然后重新运行：node scripts/build-extension.js',
    ' */',
    '',
  ].join('\n');
}

function main() {
  const checkOnly = process.argv.includes('--check');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  let stale = 0;
  for (const name of FILES) {
    const src = path.join(SRC_DIR, name);
    if (!fs.existsSync(src)) {
      console.error('源文件缺失：services/' + name);
      process.exit(1);
    }
    const body = fs.readFileSync(src, 'utf8');
    const hash = sha256(body);
    const out = path.join(OUT_DIR, name);
    const next = header(name, hash) + body;

    if (fs.existsSync(out) && fs.readFileSync(out, 'utf8') === next) {
      console.log('  ✓ ' + name + ' 已是最新');
      continue;
    }
    stale++;
    if (checkOnly) {
      console.error('  ✗ ' + name + ' 已过期，请运行 node scripts/build-extension.js');
      continue;
    }
    fs.writeFileSync(out, next);
    console.log('  ↻ ' + name + ' 已同步（' + hash + '）');
  }

  // 扩展包里不需要的说明文件
  if (!checkOnly) {
    fs.writeFileSync(path.join(OUT_DIR, 'README.md'), [
      '# 引擎副本（自动生成）',
      '',
      '本目录由 `node scripts/build-extension.js` 从 `services/` 复制而来，不要手改。',
      '',
      '- `schema.js` — 类型枚举、等级、脱敏规则',
      '- `localDetector.js` — 本地正则引擎（抗变形、校验位）',
      '- `guardCore.js` — 输入守卫的纯逻辑（读写输入框、按区间脱敏）',
      '',
      '浏览器扩展不能 `require`，所以只能把文件带在包里；但规则必须只有一份，',
      '因此由脚本同步，测试会校验两边是否一致（`scripts/test-guard.js`）。',
      '',
    ].join('\n'));
  }

  if (checkOnly) {
    if (stale) { console.error('扩展引擎已过期'); process.exit(1); }
    console.log('扩展引擎与 services/ 一致');
  }
}

main();
