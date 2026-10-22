const puppeteer = require('puppeteer-core');
const fs = require('fs');
// 默认打本地起的验证实例；线上验收用 AUDIT_BASE=https://your-domain npm run audit:csp
const BASE = (process.env.AUDIT_BASE || 'http://127.0.0.1:8101').replace(/\/+$/, '');
const BROWSER_PATH = process.env.BROWSER_PATH
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, args: ['--no-sandbox', '--disable-gpu'],
  });
  for (const p of ['/', '/status.html', '/docs.html', '/guard.html', '/launch.html']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const msgs = [];
    page.on('console', (m) => {
      if (m.type() === 'error') {
        const loc = m.location() || {};
        msgs.push({ text: m.text().slice(0, 150), url: loc.url || '', line: loc.lineNumber, col: loc.columnNumber });
      }
    });
    await page.goto(BASE + p, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 800));
    console.log('\n===== ' + p + ' 共 ' + msgs.length + ' 条 =====');
    const byLine = {};
    msgs.forEach(m => {
      const k = 'line' + m.line + ':' + m.col;
      byLine[k] = byLine[k] || { n: 0, sample: m.text };
      byLine[k].n++;
    });
    Object.keys(byLine).slice(0, 12).forEach(k => {
      console.log('  ' + k + '  ×' + byLine[k].n + '  ' + byLine[k].sample.slice(0, 130));
    });
    await page.close();
  }
  await browser.close();
  process.exit(0);
})();
