'use strict';
// 验证暗色主题下改动过的颜色仍可读（--gray / sample-chip / tagline-types / badge）
const puppeteer = require('puppeteer-core');
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => require('fs').existsSync(p));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:8099/', { waitUntil: 'networkidle2' });

  // 切到暗色主题（点页面上的主题按钮，走真实交互）
  await page.evaluate(() => {
    const b = document.getElementById('btnTheme');
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  console.log('当前主题:', theme);

  const out = await page.evaluate(() => {
    function lum(rgb) {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    function parse(s) {
      const m = String(s).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map((x) => parseFloat(x));
      return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]];
    }
    function bgOf(el) {
      let e = el;
      while (e && e !== document.documentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c[3] > 0.5) return c;
        e = e.parentElement;
      }
      const c = parse(getComputedStyle(document.body).backgroundColor);
      return c && c[3] > 0.5 ? c : [255, 255, 255, 1];
    }
    const targets = [
      ['sample-chip', document.querySelector('.sample-chip')],
      ['chip-on', document.querySelector('.sample-chip.chip-on')],
      ['tagline', document.querySelector('.tagline')],
      ['tagline-types span', document.querySelector('.tagline-types span')],
      ['badge', document.querySelector('.chat-header .title .badge')],
    ];
    return targets.filter(([, el]) => el).map(([name, el]) => {
      const cs = getComputedStyle(el);
      const fg = parse(cs.color), bg = bgOf(el);
      const L1 = lum(fg.slice(0, 3)), L2 = lum(bg.slice(0, 3));
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const need = size >= 24 ? 3 : 4.5;
      return { name, fg: cs.color, bg: `rgb(${bg.slice(0, 3).join(',')})`, ratio: +ratio.toFixed(2), need, size };
    });
  });
  for (const o of out) {
    console.log(`${o.ratio >= o.need ? '✅' : '❌'} ${o.name.padEnd(20)} ${String(o.ratio).padStart(6)}:1 / 需 ${o.need}  ${o.size}px  fg=${o.fg} bg=${o.bg}`);
  }
  await browser.close().catch(() => {});
  process.exit(0);
})();
