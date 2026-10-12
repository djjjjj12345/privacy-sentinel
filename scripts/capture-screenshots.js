/**
 * 演示截图脚本 — 用 Puppeteer 打开本地服务，截 5 个场景。
 *
 * 依赖：npm i -D puppeteer  （体积约 150MB，CI 里跑即可，本地可选）
 *
 * 用法：
 *   1. 终端一：npm start
 *   2. 终端二：node scripts/capture-screenshots.js
 *   3. 截图自动存到 docs/screenshots/
 */
'use strict';
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const BASE = process.env.BASE_URL || 'http://localhost:8080';

const scenes = [
  { name: '01-home', desc: '主页初始状态' },
  { name: '02-text-detect', desc: '文本检测 — 检出身份证', input: '我的身份证是 110105199003071239' },
  { name: '03-image-mask', desc: '图片检测 — 人脸模糊（占位）' },
  { name: '04-audio-transcript', desc: '音频识别（占位）' },
  { name: '05-l4-block', desc: 'L4 强制阻断弹窗', input: '验证码 387294' },
];

(async () => {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    console.error('未安装 puppeteer。请先运行：npm i -D puppeteer');
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });

  for (const s of scenes) {
    console.log('→', s.name, s.desc);
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));

    if (s.input) {
      await page.type('input[type=text], textarea, #msgInput', s.input, { delay: 20 });
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 2500));
    }
    await page.screenshot({ path: path.join(OUT, s.name + '.png'), fullPage: false });
    console.log('   存到', path.join(OUT, s.name + '.png'));
  }

  await browser.close();
  console.log('\n✅ 全部截图已生成：docs/screenshots/');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
