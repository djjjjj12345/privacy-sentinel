/**
 * 前端审查：多分辨率适配 / 控制台错误 / 可访问性 / 交互一致性
 * 只做测量与记录，不修改任何业务代码。产物 docs/audit/
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8101';
const OUT = path.join(__dirname, '..', 'docs', 'audit');
const PAGES = [
  { path: '/', name: 'index' },
  { path: '/launch.html', name: 'launch' },
  { path: '/guard.html', name: 'guard' },
  { path: '/docs.html', name: 'docs' },
  { path: '/status.html', name: 'status' },
];
const VIEWPORTS = [
  { w: 360, h: 640, label: '360x640-小屏手机' },
  { w: 414, h: 896, label: '414x896-大屏手机' },
  { w: 768, h: 1024, label: '768x1024-平板竖屏' },
  { w: 1024, h: 768, label: '1024x768-小笔电' },
  { w: 1440, h: 900, label: '1440x900-桌面' },
];

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function pickBrowser() {
  for (const p of BROWSER_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

const findings = [];
function add(level, area, page, desc, evidence) {
  findings.push({ level, area, page, desc, evidence: evidence || '' });
}

// 相对亮度，用于粗略对比度判断
function lum(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browserPath = pickBrowser();
  if (!browserPath) { console.error('未找到浏览器'); process.exit(1); }

  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  for (const vp of VIEWPORTS) {
    for (const pg of PAGES) {
      const page = await browser.newPage();
      await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
      const errors = [];
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text().slice(0, 200));
      });
      page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 200)));

      try {
        await page.goto(BASE + pg.path, { waitUntil: 'networkidle2', timeout: 30000 });
      } catch (e) {
        errors.push('goto: ' + e.message.slice(0, 120));
      }
      await new Promise((r) => setTimeout(r, 600));

      let m;
      try {
        m = await page.evaluate(() => {
        // 浏览器侧需要自己的一份亮度计算
        function lum(rgb) {
          const [r, g, b] = rgb.map((v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
        const doc = document.documentElement;
        const out = {
          scrollW: doc.scrollWidth,
          clientW: doc.clientWidth,
          overflowElems: [],
          tinyTargets: [],
          noAltImgs: [],
          unlabeledInputs: [],
          namelessButtons: [],
          headings: [],
          lowContrast: [],
          dupIds: [],
          // role="main" 与 <main> 等价，都是有效的地标；只查标签会漏判成「没有地标」
          hasMain: !!document.querySelector('main, [role="main"]'),
          hasH1: document.querySelectorAll('h1').length,
          lang: doc.lang,
          metaViewport: !!document.querySelector('meta[name="viewport"]'),
        };

        // 横向溢出元素
        const vw = doc.clientWidth;
        document.querySelectorAll('*').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          if (r.right > vw + 2 || r.left < -2) {
            const cs = getComputedStyle(el);
            if (cs.position === 'fixed') return;
            out.overflowElems.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.className || '').toString().slice(0, 40),
              id: el.id || '',
              left: Math.round(r.left),
              right: Math.round(r.right),
              w: Math.round(r.width),
            });
          }
        });

        // 隐藏元素不该参与可访问性与触控评估：
        // 视觉隐藏的 file input（由可见按钮代理触发）、处于未激活视图里的按钮、
        // 被裁剪到视口外的元素，都会被量出 4x17 这类尺寸，从而被误报成「触控目标过小」。
        function visible(el) {
          if (typeof el.checkVisibility === 'function') {
            try {
              if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
            } catch (e) { /* 老浏览器忽略 */ }
          }
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return false;
          // 滑出式面板（transform: translateX(100%)）里的按钮仍在渲染树中，
          // checkVisibility 认它是可见的，但它其实在视口外，量出来是 4x17 这种尺寸
          // 只排水平移出的（滑出面板都是 translateX）；垂直方向排在首屏外的元素
          // 是真实可滚动到的内容，不能因为「现在没滚到」就跳过
          if (r.right < 0 || r.left > (window.innerWidth || 1e9)) return false;
          let p = el;
          while (p && p.nodeType === 1) {
            const cs = getComputedStyle(p);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
            p = p.parentElement;
          }
          return true;
        }

        // 触控目标 < 44px（只看可交互元素）
        document.querySelectorAll('button, a, input[type=checkbox], input[type=radio], select, [role=button]').forEach((el) => {
          if (!visible(el)) return;
          // WCAG 2.5.8 目标尺寸（最小值）有明确的「行内豁免」：
          // 嵌在句子里的链接受行高约束，不能为了凑尺寸去撑破段落排版
          const cs0 = getComputedStyle(el);
          if (el.tagName === 'A' && cs0.display === 'inline'
              && el.parentElement && /^(P|LI|TD|SPAN|DIV|H1|H2|H3|H4|SUMMARY)$/.test(el.parentElement.tagName)) {
            const ptxt = (el.parentElement.textContent || '').trim();
            if (ptxt.length > (el.textContent || '').trim().length + 4) return;
          }
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          if (r.height < 32 || r.width < 32) {
            out.tinyTargets.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.className || '').toString().slice(0, 30),
              text: (el.textContent || '').trim().slice(0, 20),
              w: Math.round(r.width), h: Math.round(r.height),
            });
          }
        });

        // 图片缺 alt
        document.querySelectorAll('img').forEach((el) => {
          if (!el.hasAttribute('alt')) out.noAltImgs.push((el.getAttribute('src') || '').slice(0, 60));
        });

        // 表单控件缺可访问名
        document.querySelectorAll('input, select, textarea').forEach((el) => {
          const t = el.type;
          if (t === 'hidden' || t === 'submit' || t === 'button') return;
          // 视觉隐藏的 file input 由可见按钮代理触发，本身不暴露给辅助技术，不算缺陷
          if (!visible(el)) return;
          const id = el.id;
          const hasLabel = (id && document.querySelector('label[for="' + CSS.escape(id) + '"]'))
            || el.closest('label')
            || el.getAttribute('aria-label')
            || el.getAttribute('aria-labelledby')
            || el.getAttribute('placeholder')
            || el.getAttribute('title');
          if (!hasLabel) {
            out.unlabeledInputs.push({ tag: el.tagName.toLowerCase(), type: t, id: id || '', cls: (el.className || '').toString().slice(0, 30) });
          }
        });

        // 无文本按钮
        document.querySelectorAll('button, [role=button]').forEach((el) => {
          const txt = (el.textContent || '').trim();
          const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
          if (!txt && !aria) {
            out.namelessButtons.push({ id: el.id || '', cls: (el.className || '').toString().slice(0, 30) });
          }
        });

        // 标题层级
        document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((el) => {
          out.headings.push(Number(el.tagName.slice(1)));
        });

        // 重复 id
        const seen = {};
        document.querySelectorAll('[id]').forEach((el) => {
          seen[el.id] = (seen[el.id] || 0) + 1;
        });
        Object.keys(seen).forEach((k) => { if (seen[k] > 1) out.dupIds.push(k); });

        // 粗略对比度：正文文本元素
        function parseRgb(s) {
          const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
          if (!m) return null;
          return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
        }
        function bgOf(el) {
          let e = el;
          while (e && e !== document.documentElement) {
            const c = parseRgb(getComputedStyle(e).backgroundColor);
            if (c && c[3] > 0.5) return c;
            e = e.parentElement;
          }
          return [255, 255, 255, 1];
        }
        document.querySelectorAll('p, span, div, li, td, label, a, h1, h2, h3, h4').forEach((el) => {
          const txt = (el.textContent || '').trim();
          if (!txt) return;
          if (!visible(el)) return;
          // 只取直接文本节点
          const direct = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join('');
          if (direct.length < 2) return;
          const cs = getComputedStyle(el);
          const fg = parseRgb(cs.color);
          if (!fg || fg[3] < 0.5) return;
          const bg = bgOf(el);
          const L1 = lum(fg.slice(0, 3));
          const L2 = lum(bg.slice(0, 3));
          const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
          const size = parseFloat(cs.fontSize);
          const bold = Number(cs.fontWeight) >= 700;
          const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
          if (ratio < need) {
            out.lowContrast.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.className || '').toString().slice(0, 30),
              text: direct.slice(0, 30),
              ratio: Number(ratio.toFixed(2)),
              need,
              size: Math.round(size),
            });
          }
        });

        return out;
      });
      } catch (e) {
        add('严重', '脚本', pg.name, '页面测量失败：' + e.message.slice(0, 120));
        await page.close();
        continue;
      }

      const shot = path.join(OUT, pg.name + '-' + vp.w + '.png');
      await page.screenshot({ path: shot, fullPage: false });

      // 记录
      if (m.scrollW > m.clientW + 2) {
        add(vp.w <= 414 ? '严重' : '中等', '多分辨率', pg.name + '@' + vp.label,
          '页面横向溢出 ' + (m.scrollW - m.clientW) + 'px，出现水平滚动条',
          JSON.stringify(m.overflowElems.slice(0, 4)));
      }
      if (m.tinyTargets.length && vp.w <= 414) {
        add('中等', '移动端触控', pg.name + '@' + vp.w,
          '存在 ' + m.tinyTargets.length + ' 个小于 32px 的可点击目标',
          JSON.stringify(m.tinyTargets.slice(0, 5)));
      }
      if (m.noAltImgs.length) {
        add('轻微', '可访问性', pg.name, m.noAltImgs.length + ' 张图片缺少 alt 属性', JSON.stringify(m.noAltImgs.slice(0, 3)));
      }
      if (m.unlabeledInputs.length) {
        add('中等', '可访问性', pg.name, m.unlabeledInputs.length + ' 个表单控件缺少可访问名称',
          JSON.stringify(m.unlabeledInputs.slice(0, 4)));
      }
      if (m.namelessButtons.length) {
        add('中等', '可访问性', pg.name, m.namelessButtons.length + ' 个按钮没有可读名称', JSON.stringify(m.namelessButtons.slice(0, 4)));
      }
      if (m.dupIds.length) {
        add('轻微', '代码结构', pg.name, '存在重复 id：' + m.dupIds.slice(0, 5).join(', '));
      }
      if (m.lowContrast.length) {
        add('中等', '可访问性', pg.name, m.lowContrast.length + ' 处文本对比度低于 WCAG AA',
          JSON.stringify(m.lowContrast.slice(0, 5)));
      }
      if (!m.lang) add('轻微', '可访问性', pg.name, 'html 缺少 lang 属性');
      if (!m.metaViewport) add('严重', '移动端', pg.name, '缺少 viewport meta');
      if (m.hasH1 === 0) add('轻微', 'SEO', pg.name, '页面没有 h1');
      if (m.hasH1 > 1) add('轻微', 'SEO', pg.name, '页面有 ' + m.hasH1 + ' 个 h1');
      if (!m.hasMain) add('轻微', '可访问性', pg.name, '没有 main 地标元素，屏幕阅读器无法跳转主内容');

      // 标题层级跳跃
      let prev = 0, jump = null;
      for (const h of m.headings) {
        if (prev && h > prev + 1) { jump = prev + ' -> ' + h; break; }
        prev = h;
      }
      if (jump) add('轻微', '可访问性', pg.name, '标题层级跳跃：h' + jump);

      const realErrors = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
      if (realErrors.length) {
        add('中等', '控制台', pg.name + '@' + vp.w, realErrors.length + ' 条控制台错误/警告', JSON.stringify(realErrors.slice(0, 4)));
      }

      await page.close();
    }
  }

  await browser.close();

  const grouped = {};
  for (const f of findings) {
    const k = f.level + ' | ' + f.area;
    grouped[k] = grouped[k] || [];
    grouped[k].push(f);
  }
  console.log('===== 前端审查结果（视口 ' + VIEWPORTS.length + ' × 页面 ' + PAGES.length + '）=====');
  console.log('问题总数：' + findings.length);
  const order = ['严重', '中等', '轻微'];
  for (const lv of order) {
    const list = findings.filter((f) => f.level === lv);
    console.log('\n--- ' + lv + '（' + list.length + '）---');
    for (const f of list) {
      console.log('[' + f.area + '] ' + f.page + ' :: ' + f.desc);
      if (f.evidence) console.log('    证据: ' + f.evidence.slice(0, 260));
    }
  }
  fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify(findings, null, 2), 'utf8');
  console.log('\n产物：docs/audit/findings.json + 各视口截图');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
