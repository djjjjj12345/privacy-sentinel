/**
 * 第 13 套：SDK
 * ---------------------------------------------------------------
 * 覆盖四块：
 *   A 产物一致性（引擎副本没漂移、dist 与 src 同源、--check 可用）
 *   B Node CJS API（detect / analyze / mask / analyzeAndMask / batch / 异常输入）
 *   C 浏览器 UMD（jsdom 里 <script> 引入后 window.PrivacySentinel 可用）
 *   D ESM 具名导出 + 类型声明 + 隐私不变量
 *
 * 为什么单独一套：SDK 会把引擎交给第三方调用，
 * 「默认不回显原文」「零依赖不联网」这两条一旦破了，使用者根本发现不了。
 * 所以这里既测行为，也测源码里不许出现网络/存储 API。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SDK = path.join(ROOT, 'sdk');
const PS = require(path.join(SDK, 'src', 'index.js'));

let pass = 0;
let fail = 0;

function log(ok, name, extra) {
  if (ok) { pass++; console.log('  ✅ ' + name + (extra ? '（' + extra + '）' : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '（' + extra + '）' : '')); }
}

function section(title) {
  console.log('\n' + title);
}

/* ============================ A. 产物一致性 ============================ */

function testArtifacts() {
  section('A. 产物一致性（规则单源 / dist 已生成）');

  const files = ['schema.js', 'localDetector.js', 'guardCore.js'];
  files.forEach((name) => {
    const src = fs.readFileSync(path.join(ROOT, 'services', name), 'utf8');
    const copyPath = path.join(SDK, 'src', 'engine', name);
    if (!fs.existsSync(copyPath)) { log(false, '引擎副本存在：' + name); return; }
    const copy = fs.readFileSync(copyPath, 'utf8');
    // 副本 = 头部注释 + 源文件原文
    const idx = copy.indexOf('*/');
    const body = idx >= 0 ? copy.slice(idx + 2).replace(/^\r?\n/, '') : copy;
    log(body === src, '引擎副本与 services/ 一致：' + name);
  });

  const distUmd = path.join(SDK, 'dist', 'privacy-sentinel.js');
  const distEsm = path.join(SDK, 'dist', 'privacy-sentinel.esm.mjs');
  log(fs.existsSync(distUmd), 'UMD 单文件已生成', fs.existsSync(distUmd) ? Math.round(fs.statSync(distUmd).size / 1024) + 'KB' : '缺失');
  log(fs.existsSync(distEsm), 'ESM 单文件已生成');
  log(fs.existsSync(path.join(SDK, 'types', 'index.d.ts')), '类型声明存在');

  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-sdk.js'), '--check'], { encoding: 'utf8' });
  log(r.status === 0, 'build-sdk --check 通过（没有过期产物）', (r.stderr || '').trim().slice(0, 80));
}

/* ============================ B. Node API ============================ */

function testNodeApi() {
  section('B. Node CJS API');

  const text = '大家好，我是ABC，手机 13800138000，身份证 11010519491231002X，邮箱 me@example.com';

  log(PS.version === '1.0.0', 'version 可读', PS.version);

  const items = PS.detect(text);
  log(Array.isArray(items) && items.length >= 3, 'detect 命中多条', items.length + ' 条');
  log(items.every((i) => i.raw === undefined), '默认不返回原文（安全默认）');
  log(items.every((i) => typeof i.masked === 'string' && i.masked.length > 0), '每条都有脱敏值');
  log(items.every((i) => i.start >= 0 && i.end > i.start), '每条都有可用的区间');
  log(items.every((i) => typeof i.label === 'string' && i.label.length > 0), '每条都有中文类型名');

  const phoneOnly = PS.detect(text, { types: ['phone'] });
  log(phoneOnly.length === 1 && phoneOnly[0].type === 'phone', 'types 白名单生效', phoneOnly.length + ' 条');

  log(PS.detect(text, { minLevel: 99 }).length === 0, 'minLevel 阈值生效');
  log(PS.detect('今天天气不错').length === 0, '无敏感信息时返回空数组');
  log(PS.detect('').length === 0, '空字符串安全返回');

  let threw = '';
  try { PS.detect(123); } catch (e) { threw = e.name; }
  log(threw === 'TypeError', '非字符串输入抛 TypeError', threw);

  const masked = PS.mask(text);
  log(masked.indexOf('13800138000') < 0 && masked.indexOf('11010519491231002X') < 0, 'mask 清掉了号码');
  log(masked.indexOf('大家好，我是ABC') >= 0, 'mask 保留非敏感文案');
  log(PS.mask(text, { strategy: 'label' }).indexOf('[手机号]') >= 0, 'label 策略替换成标签');
  const removed = PS.mask(text, { strategy: 'remove' });
  log(removed.indexOf('13800138000') < 0 && removed.length < masked.length, 'remove 策略直接删掉');

  const twice = 'A:13800138000 B:13800138000';
  const twiceMasked = PS.mask(twice);
  log((twiceMasked.match(/\*{3,}/g) || []).length === 2, '同一号码出现两次都被替换（按区间重建）');
  log(PS.mask('没有敏感信息') === '没有敏感信息', '无命中时原样返回');

  const res = PS.analyze(text);
  log(typeof res.summary === 'string' && res.summary.indexOf('检测到') === 0, 'analyze 给出摘要', res.summary);
  log(res.count === items.length && res.items.length === items.length, 'analyze.count 与命中数一致');
  log(typeof res.elapsedMs === 'number' && res.elapsedMs >= 0, 'analyze 返回耗时');

  const combo = PS.analyzeAndMask(text);
  log(combo.masked === PS.mask(text), 'analyzeAndMask 的脱敏文本与 mask 一致');
  log(combo.items.length === res.items.length, 'analyzeAndMask 结果与 analyze 一致');

  const batch = PS.detectBatch([text, '干净的一句话', null]);
  log(batch.length === 3, 'detectBatch 等长返回');
  log(batch[0].ok && batch[0].result.masked, 'batch 第 1 条成功并带脱敏文本');
  log(batch[1].ok && batch[1].result.count === 0, 'batch 第 2 条无命中');
  log(batch[2].ok === false && /字符串/.test(batch[2].error), 'batch 单条出错不中断整批', batch[2].error);

  log(PS.desensitize('13800138000', 'phone') === '138****8000', 'desensitize 单值脱敏');
  log(PS.desensitize('13800138000', 'phone', 'label') === '[手机号]', 'desensitize 支持标签策略');
  log(PS.desensitize('13800138000', 'phone', 'remove') === '', 'desensitize 支持删除策略');

  const types = PS.types();
  const levels = PS.levels();
  log(typeof types.phone === 'string' && types.phone.length > 0, 'types() 返回类型枚举', types.phone);
  log(Object.keys(levels).length >= 3, 'levels() 返回等级枚举', Object.keys(levels).length + ' 级');
  log(PS.strategies.join(',') === 'mask,label,remove', 'strategies 常量正确');

  // 抗变形：全角数字 / 零宽字符 都不能绕过去
  log(PS.detect('手机 １３８００１３８０００').length >= 1, '全角数字仍能命中');
  log(PS.detect('手机 13\u200B800138000').length >= 1, '零宽字符仍能命中');

  // includeRaw 必须显式开启
  const withRaw = PS.detect(text, { includeRaw: true });
  log(withRaw.some((i) => i.raw === '13800138000'), 'includeRaw 显式开启后才带原文');
}

/* ============================ C. 浏览器 UMD ============================ */

async function testUmd() {
  section('C. 浏览器 UMD（jsdom）');

  const { JSDOM } = require('jsdom');
  const code = fs.readFileSync(path.join(SDK, 'dist', 'privacy-sentinel.js'), 'utf8');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.com/',
    runScripts: 'dangerously',
  });
  const win = dom.window;
  win.eval(code);

  const PSB = win.PrivacySentinel;
  log(!!PSB && typeof PSB.detect === 'function', 'UMD 挂到 window.PrivacySentinel');
  log(!!PSB && PSB.version === '1.0.0', '浏览器端 version 正确');

  const text = '电话 13900139000，卡号 6222021234567890123';
  const items = PSB.detect(text);
  log(items.length >= 2, '浏览器端 detect 命中', items.map((i) => i.label).join('/'));
  log(items.every((i) => i.raw === undefined), '浏览器端同样默认不带原文');
  log(PSB.mask(text).indexOf('13900139000') < 0, '浏览器端 mask 生效');
  log(PSB.mask(text, { strategy: 'label' }).indexOf('[手机号]') >= 0, '浏览器端支持策略参数');

  win.close();
}

/* ============================ D. ESM / 类型 / 隐私 ============================ */

async function testEsmAndTypes() {
  section('D. ESM 导出 / 类型声明 / 隐私不变量');

  const mod = await import('file://' + path.join(SDK, 'dist', 'privacy-sentinel.esm.mjs').replace(/\\/g, '/'));
  log(typeof mod.default === 'object' && mod.default.version === '1.0.0', 'ESM 默认导出可用');
  log(typeof mod.detect === 'function' && typeof mod.mask === 'function', 'ESM 具名导出可用');
  log(mod.detect('手机 13700137000').length === 1, 'ESM 端 detect 正常');

  const dts = fs.readFileSync(path.join(SDK, 'types', 'index.d.ts'), 'utf8');
  ['interface SensitiveItem', 'interface AnalyzeResult', 'interface DetectOptions',
    'export function detect', 'export function mask', 'export function analyzeAndMask',
    'includeRaw', 'export default'].forEach((key) => {
    log(dts.indexOf(key) >= 0, '类型声明包含：' + key);
  });

  const srcFiles = ['src/index.js', 'dist/privacy-sentinel.js'];
  const banned = ['fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'require(\'fs\')', 'require("fs")'];
  srcFiles.forEach((rel) => {
    const code = fs.readFileSync(path.join(SDK, rel), 'utf8');
    // 注释里可能出现这些词，先去掉注释再扫
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hit = banned.filter((b) => stripped.indexOf(b) >= 0);
    log(hit.length === 0, rel + ' 不含网络/存储调用', hit.join(','));
  });

  const pkg = JSON.parse(fs.readFileSync(path.join(SDK, 'package.json'), 'utf8'));
  log(pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0, 'SDK 零运行时依赖');
  log(pkg.main === 'src/index.js' && !!pkg.types, 'main / types 指向正确');
  log(!!pkg.exports && !!pkg.exports['.'].browser, 'exports 提供 browser 入口');
}

/* ============================ 运行 ============================ */

(async function main() {
  console.log('SDK 测试\n' + '='.repeat(48));
  testArtifacts();
  testNodeApi();
  await testUmd();
  await testEsmAndTypes();

  const total = pass + fail;
  console.log('\n' + '='.repeat(48));
  console.log('SDK：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + total);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
