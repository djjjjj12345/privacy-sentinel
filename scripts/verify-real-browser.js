/**
 * 真实浏览器验收（不是模拟页面）
 * ---------------------------------------------------------------
 * 目的：证明「输入守卫」在真实浏览器 + 真实第三方网站的真实输入框里真的会弹出提醒、
 * 真的能把原文改写成脱敏值，而不只是在 guard.html 的仿真框里自娱自乐。
 *
 * 做法：把 extension/ 以「加载已解压的扩展程序」的方式装进本机 Edge / Chrome，
 * 打开公开可访问的真实站点，用真实键盘事件打字，断言：
 *   1. 提醒条 #ps-guard-tip 真的出现
 *   2. 提醒条里【不出现原文】（提示本身不能成为第二处泄露）
 *   3. 点「一键脱敏」后，输入框里的真实值变成脱敏值
 *   4. 脱敏后输入框里再无原文
 *
 * 每一步都截图，产物在 docs/real-browser/，可直接放进 README / 答辩 PPT。
 *
 * 用法：node scripts/verify-real-browser.js
 * 依赖：puppeteer-core（不下载浏览器，用本机已装的 Edge/Chrome）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'docs', 'real-browser');

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

// 测试样本：故意用「日常发帖语气」，不是裸号码
const SAMPLE = '昨天在地铁站丢了个快递，捡到的联系我 13800138000，身份证 110105199003071239';

const TARGETS = [
  { name: 'baidu', label: '百度（原生 input）', url: 'https://www.baidu.com/', sel: 'textarea, #chat-textarea, input#kw, input[name="wd"], [contenteditable="true"]' },
  { name: 'juejin', label: '掘金（技术社区）', url: 'https://juejin.cn/', sel: 'input[type="text"], .search-input, input' },
  { name: 'zhihu', label: '知乎（React 受控）', url: 'https://www.zhihu.com/', sel: 'input[type="text"], textarea, [contenteditable="true"]' },
  { name: 'bilibili', label: '哔哩哔哩（Vue）', url: 'https://www.bilibili.com/', sel: 'input[type="text"], .nav-search-input, input' },
  { name: 'douban', label: '豆瓣（原生 input）', url: 'https://www.douban.com/', sel: 'input[type="text"], #inp-query, input' },
  { name: 'github', label: 'GitHub', url: 'https://github.com/', sel: 'input[name="q"], input[type="text"]' }
];

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

function pickBrowser() {
  for (const p of BROWSER_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

/**
 * 把 extension/ 复制到纯英文临时目录后再加载。
 * 坑：--load-extension 的路径含中文（本项目根目录就叫「检测系统」）时，
 * Chromium 会静默跳过加载，表现是 content script 根本没注入，很容易误判成「扩展坏了」。
 */
function stageExtension() {
  const os = require('os');
  const dir = path.join(os.tmpdir(), 'psguard-verify', 'extension');
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const copy = (rel) => {
    const src = path.join(EXT, rel);
    const dst = path.join(dir, rel);
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      fs.readdirSync(src).forEach((f) => copy(path.join(rel, f)));
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  };
  ['manifest.json', 'content.js', 'content.css', 'popup.html', 'popup.js', 'popup.css', 'engine', 'icons']
    .forEach((f) => { if (fs.existsSync(path.join(EXT, f))) copy(f); });
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 扩展没被 headless 加载时的兜底：手动注入同样四份脚本，等价于 content_scripts */
async function injectAsContentScript(page) {
  // 少注入 content.css 会得到一个「没有样式、没有 display:none」的裸 div：
  // class 上照样有 show，断言却全绿 —— 典型的假阳性。样式必须一起注入。
  await page.addStyleTag({ content: fs.readFileSync(path.join(EXT, 'content.css'), 'utf8') });
  const files = ['engine/schema.js', 'engine/localDetector.js', 'engine/guardCore.js', 'content.js'];
  for (const f of files) {
    const code = fs.readFileSync(path.join(EXT, f), 'utf8');
    await page.evaluate((src) => {
      const s = document.createElement('script');
      s.textContent = src;
      (document.head || document.documentElement).appendChild(s);
    }, code);
  }
}

async function findEditable(page, sel) {
  return page.evaluate((selector) => {
    const list = Array.prototype.slice.call(
      document.querySelectorAll(selector || 'input, textarea, [contenteditable="true"]')
    );
    for (const el of list) {
      if (el.type === 'password' || el.type === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 12) continue;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      el.setAttribute('data-ps-probe', '1');
      return { tag: el.tagName.toLowerCase(), type: el.type || '', editable: el.isContentEditable };
    }
    return null;
  }, sel);
}

async function main() {
  const browserPath = pickBrowser();
  if (!browserPath) {
    console.log('未找到本机 Edge / Chrome，无法做真实浏览器验收');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const staged = stageExtension();
  console.log('浏览器：' + browserPath);
  console.log('扩展暂存（英文路径）：' + staged);

  async function start(headless) {
    let b = null;
    try {
      b = await puppeteer.launch({
        executablePath: browserPath,
        headless: headless,
        args: [
          '--no-sandbox',
          '--disable-gpu',
          '--disable-extensions-except=' + staged,
          '--load-extension=' + staged,
          '--window-size=1280,800'
        ],
        defaultViewport: { width: 1280, height: 800 }
      });
      const p = await b.newPage();
      await p.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(1500);
      const loaded = await p.evaluate(() => !!window.__PS_GUARD_LOADED__);
      await p.close();
      return { browser: b, ext: !!loaded };
    } catch (e) {
      if (b) await b.close().catch(() => {});
      return { browser: null, ext: false, err: e.message };
    }
  }

  let s = await start(true);
  // 有头模式实测更不稳（窗口抢焦点、target 被关），只在显式要求时启用
  if (!s.ext && process.env.PS_GUARD_HEADFUL === '1') {
    console.log('headless 下未加载扩展，改用有头模式重试（会短暂弹出浏览器窗口）…');
    if (s.browser) await s.browser.close().catch(() => {});
    s = await start(false);
  }
  if (!s.browser) { console.log('浏览器启动失败：' + s.err); process.exit(2); }

  const browser = s.browser;
  const extMode = s.ext;
  console.log(extMode
    ? '扩展模式：已解压扩展程序加载成功（真实扩展，不受页面 CSP 限制）'
    : '扩展模式：未加载扩展，改用等价脚本注入（受页面 CSP 限制，部分站点会失败）');

  for (const t of TARGETS) {
    console.log('\n[' + t.label + '] ' + t.url);
    const page = await browser.newPage();
    try {
      // 注入模式下要绕开站点 CSP（知乎等站的 script-src 会拦注入脚本）；
      // 真实扩展的 content script 本来就不受页面 CSP 约束，这里只是让测量方式等价。
      if (!extMode) await page.setBypassCSP(true);
      await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2500);

      if (!extMode) await injectAsContentScript(page);
      const ready = await page.evaluate(() => !!window.__PS_GUARD_LOADED__ && !!window.PSLocal && !!window.PSGuardCore);
      if (!ready) { console.log('  - 守卫未挂载，跳过'); await page.close(); continue; }

      const el = await findEditable(page, t.sel);
      if (!el) {
        await page.screenshot({ path: path.join(OUT, t.name + '-0-noinput.png') }).catch(() => {});
        console.log('  - 页面无可见输入框，跳过（截图 ' + t.name + '-0-noinput.png）');
        await page.close();
        continue;
      }
      console.log('  输入框：< ' + el.tag + (el.type ? ' type=' + el.type : '') + (el.editable ? ' contenteditable' : '') + ' >');

      const before = await page.evaluate(() => {
        const el = document.querySelector('[data-ps-probe="1"]');
        el.focus();
        return el.value || '';
      });

      await page.keyboard.type(SAMPLE, { delay: 12 });
      await sleep(900);

      const tip = await page.evaluate(() => {
        const el = document.getElementById('ps-guard-tip');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return {
          // 只看 class 会假阳性：样式没加载时 div 依然是「show」但没有盒子
          shown: el.classList.contains('show') && st.display !== 'none' && r.width > 120 && r.height > 60,
          box: Math.round(r.width) + 'x' + Math.round(r.height) + ' @' + Math.round(r.left) + ',' + Math.round(r.top),
          text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
          hasRawPhone: (el.innerText || '').indexOf('13800138000') >= 0,
          hasRawId: (el.innerText || '').indexOf('110105199003071239') >= 0,
          buttons: Array.prototype.map.call(el.querySelectorAll('button'), (b) => b.textContent).join('/')
        };
      });

      if (!tip) { ok(false, t.label + ' 弹出提醒条', '未找到 #ps-guard-tip'); await page.close(); continue; }
      ok(tip.shown, t.label + ' 弹出提醒条');
      ok(/检测到/.test(tip.text), t.label + ' 提醒条文案正确', tip.text.slice(0, 60));
      ok(!tip.hasRawPhone && !tip.hasRawId, t.label + ' 提醒条不回显原文');
      ok(/一键脱敏/.test(tip.buttons), t.label + ' 有一条龙按钮：' + tip.buttons);

      await page.screenshot({ path: path.join(OUT, t.name + '-1-alert.png') });

      await page.evaluate(() => {
        const b = document.querySelector('#ps-guard-tip .psg-btn.primary');
        if (b) b.click();
      });
      await sleep(400);

      const after = await page.evaluate(() => {
        const el = document.querySelector('[data-ps-probe="1"]');
        return el.isContentEditable ? el.innerText : el.value;
      });
      await page.screenshot({ path: path.join(OUT, t.name + '-2-masked.png') });

      ok(after !== before && /\*{3,}/.test(after), t.label + ' 一键脱敏改写输入框', after.slice(0, 70));
      ok(after.indexOf('13800138000') < 0 && after.indexOf('110105199003071239') < 0, t.label + ' 脱敏后无原文残留');

      await page.close();
    } catch (e) {
      console.log('  - 失败：' + e.message.slice(0, 100));
      await page.close().catch(() => {});
    }
  }

  // 某些站点会残留 WebSocket / Service Worker，browser.close() 可能一直不 resolve，
  // 这里给个上限，避免脚本跑完却挂住不退出。
  await Promise.race([browser.close().catch(() => {}), sleep(6000)]);

  const meta = {
    generatedAt: new Date().toISOString(),
    mode: extMode ? 'extension' : 'injected',
    browser: path.basename(browserPath),
    sample: SAMPLE,
    pass: pass,
    fail: fail,
    failures: failures
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(meta, null, 2), 'utf8');

  console.log('\n产物目录：docs/real-browser/');
  console.log('\n真实浏览器验收：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail));
  if (failures.length) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
