/**
 * 构建 privacy-sentinel SDK
 * ---------------------------------------------------------------
 * 做三件事：
 *   1. 把 services/ 里的引擎同步到 sdk/src/engine/（规则只有一份，副本带来源哈希）
 *   2. 拼出浏览器可直接 <script> 引入的单文件 UMD：sdk/dist/privacy-sentinel.js
 *   3. 拼出 ESM 版本：sdk/dist/privacy-sentinel.esm.mjs
 *
 * 为什么不用打包器：引擎本身零依赖、且已经是 IIFE 双端写法，
 * 引入 webpack/rollup 只会给一个「零依赖 SDK」平白加上几百个间接依赖。
 * 代价是 dist 不支持在 Node 里 require —— Node 用户走 sdk/src/index.js（package.json 的 main）。
 *
 * 运行：node scripts/build-sdk.js [--check]
 *   --check 只校验引擎副本是否过期，不写文件（测试 / CI 用）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'services');
const SDK_DIR = path.join(ROOT, 'sdk');
const ENGINE_OUT = path.join(SDK_DIR, 'src', 'engine');
const DIST_DIR = path.join(SDK_DIR, 'dist');

// 顺序即依赖顺序：schema → localDetector → guardCore → SDK 封装
const FILES = ['schema.js', 'localDetector.js', 'guardCore.js'];
const ENTRY = path.join(SDK_DIR, 'src', 'index.js');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

function header(name, hash) {
  return [
    '/**',
    ' * ⚠️ 本文件由 scripts/build-sdk.js 自动生成，请勿直接修改。',
    ' * 来源：services/' + name + '（哈希 ' + hash + '）',
    ' * 改规则请改 services/ 下的源文件，然后重新运行：node scripts/build-sdk.js',
    ' */',
    '',
  ].join('\n');
}

function read(p) {
  if (!fs.existsSync(p)) {
    console.error('文件缺失：' + path.relative(ROOT, p));
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf8');
}

function syncEngine(checkOnly) {
  let stale = 0;
  const bodies = {};
  for (const name of FILES) {
    const body = read(path.join(SRC_DIR, name));
    bodies[name] = body;
    const next = header(name, sha256(body)) + body;
    const out = path.join(ENGINE_OUT, name);
    if (fs.existsSync(out) && fs.readFileSync(out, 'utf8') === next) continue;
    stale++;
    if (checkOnly) {
      console.error('  ✗ src/engine/' + name + ' 已过期');
      continue;
    }
    fs.writeFileSync(out, next);
    console.log('  ↻ src/engine/' + name + ' 已同步');
  }
  return { stale, bodies };
}

function buildDist(bodies, checkOnly) {
  const entry = read(ENTRY);
  const version = JSON.parse(read(path.join(SDK_DIR, 'package.json'))).version;

  // UMD：引擎 → 封装层。浏览器里每个 IIFE 会挂到 globalThis，index.js 再从 globalThis 取。
  const umd = [
    '/*!',
    ' * privacy-sentinel v' + version + ' · 浏览器单文件版（UMD）',
    ' * 用法：<script src="privacy-sentinel.js"></script> → window.PrivacySentinel.detect(text)',
    ' * 由 scripts/build-sdk.js 生成，请勿手改；规则源文件在 services/。',
    ' * 零依赖、纯本地检测，不联网、不上传原文。',
    ' */',
    '',
    ...FILES.map((n) => bodies[n]),
    entry,
    '',
  ].join('\n');

  // ESM：同上，末尾补具名导出（Node/浏览器 import 用）
  const esm = [
    '/*!',
    ' * privacy-sentinel v' + version + ' · ESM 版',
    ' * 用法：import PrivacySentinel, { detect, mask } from "./privacy-sentinel.esm.mjs"',
    ' * 由 scripts/build-sdk.js 生成，请勿手改。',
    ' */',
    '',
    ...FILES.map((n) => bodies[n]),
    entry,
    '',
    'const __ps = globalThis.PrivacySentinel;',
    'export default __ps;',
    'export const detect = __ps.detect;',
    'export const analyze = __ps.analyze;',
    'export const mask = __ps.mask;',
    'export const analyzeAndMask = __ps.analyzeAndMask;',
    'export const detectBatch = __ps.detectBatch;',
    'export const types = __ps.types;',
    'export const levels = __ps.levels;',
    'export const desensitize = __ps.desensitize;',
    'export const version = __ps.version;',
    '',
  ].join('\n');

  const targets = [
    { file: 'privacy-sentinel.js', content: umd },
    { file: 'privacy-sentinel.esm.mjs', content: esm },
  ];

  let stale = 0;
  for (const t of targets) {
    const out = path.join(DIST_DIR, t.file);
    const same = fs.existsSync(out) && fs.readFileSync(out, 'utf8') === t.content;
    if (same) continue;
    stale++;
    if (!checkOnly) fs.writeFileSync(out, t.content);
  }
  return stale;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  if (!fs.existsSync(ENGINE_OUT)) fs.mkdirSync(ENGINE_OUT, { recursive: true });
  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

  const { stale: s1, bodies } = syncEngine(checkOnly);
  const s2 = buildDist(bodies, checkOnly);
  const stale = s1 + s2;

  if (checkOnly) {
    if (stale) {
      console.error('SDK 产物已过期，请运行 node scripts/build-sdk.js');
      process.exit(1);
    }
    console.log('SDK 引擎副本与 dist 均为最新');
    return;
  }

  console.log('SDK 构建完成：');
  console.log('  src/index.js              Node 入口（main）');
  console.log('  src/engine/*.js           引擎副本（来自 services/）');
  console.log('  dist/privacy-sentinel.js  浏览器 UMD 单文件');
  console.log('  dist/privacy-sentinel.esm.mjs  ESM 单文件');
}

main();
