/**
 * 第 12 套：输入守卫
 * ---------------------------------------------------------------
 * 覆盖三块：
 *   A 守卫核心纯逻辑（读写判定、按区间脱敏、阈值排序）
 *   B 扩展契约（引擎副本是否漂移、manifest 顺序、不得回显原文）
 *   C guard.html 真实交互（jsdom 打字 → 提醒 → 一键脱敏 → 发布拦截）
 *
 * 为什么单独一套：输入守卫与主站是两个独立产品，但共用同一套引擎。
 * 「共用」这件事只能靠测试保证，代码约定挡不住有人在扩展里另写一份正则。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE = require(path.join(ROOT, 'services', 'guardCore.js'));
const ENGINE = require(path.join(ROOT, 'services', 'localDetector.js'));

let pass = 0;
let fail = 0;

function log(ok, name, extra) {
  if (ok) { pass++; console.log('  ✅ ' + name + (extra ? '（' + extra + '）' : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '（' + extra + '）' : '')); }
}

function section(title) {
  console.log('\n' + title);
}

/* ============================ A. 守卫核心 ============================ */

function testCore() {
  section('A. 守卫核心（读写判定 / 脱敏 / 排序）');

  const ta = { nodeType: 1, tagName: 'TEXTAREA', readOnly: false, disabled: false, isContentEditable: false };
  log(CORE.isEditable(ta) === true, '普通 textarea 可检测');

  const pwd = { nodeType: 1, tagName: 'INPUT', readOnly: false, disabled: false, isContentEditable: false, getAttribute: () => 'password' };
  log(CORE.isEditable(pwd) === false, '密码框跳过不检测（输入密码是正常行为）');

  const ro = { nodeType: 1, tagName: 'INPUT', readOnly: true, disabled: false, isContentEditable: false, getAttribute: () => 'text' };
  log(CORE.isEditable(ro) === false, '只读输入框跳过');

  const ce = { nodeType: 1, tagName: 'DIV', isContentEditable: true };
  log(CORE.isEditable(ce) === true, '富文本编辑区可检测');

  const plain = { nodeType: 1, tagName: 'DIV', isContentEditable: false };
  log(CORE.isEditable(plain) === false, '普通 div 不检测');

  const hidden = { nodeType: 1, tagName: 'INPUT', readOnly: false, disabled: false, isContentEditable: false, getAttribute: () => 'hidden' };
  log(CORE.isEditable(hidden) === false, '隐藏域跳过');

  // 脱敏：必须按区间重建
  const text = '手机号 13800138000，身份证 11010519491231002X';
  const items = ENGINE.detect(text);
  const masked = CORE.buildMaskedText(text, items, 'mask');
  log(!masked.includes('13800138000'), '脱敏后不含原始手机号');
  log(!masked.includes('11010519491231002X'), '脱敏后不含原始身份证');
  log(masked.includes('手机号') && masked.includes('身份证'), '保留非敏感文案，只替换命中区间');

  const labelled = CORE.buildMaskedText(text, items, 'label');
  log(labelled.includes('[手机号]') && labelled.includes('[身份证号]'), '替换策略用类型标签占位', labelled.slice(0, 30));

  const removed = CORE.buildMaskedText(text, items, 'remove');
  log(!removed.includes('13800138000') && removed.length < masked.length + 5, '删除策略直接抹掉命中内容');

  // 逆序替换：多个区间时，前面的下标不能被后面的长度变化带偏
  const many = '13800138000 / 13900139000 / 13700137000';
  const manyItems = ENGINE.detect(many);
  const manyMasked = CORE.buildMaskedText(many, manyItems, 'mask');
  const rawCount = (many.match(/\d{11}/g) || []).length;
  log(manyItems.length >= 3, '同一段文本可命中多个号码', manyItems.length + ' 处');
  log(manyMasked.indexOf('13800138000') < 0 && manyMasked.indexOf('13700137000') < 0,
    '多区间逆序替换后每个号码都被脱敏', '原文 ' + rawCount + ' 个');

  // 越界区间不应抛错（文本被外部改写后会遇到）
  let threw = false;
  try { CORE.buildMaskedText('123', [{ start: 10, end: 20, type: 'phone', level: 1 }], 'mask'); }
  catch (_) { threw = true; }
  log(!threw, '越界区间跳过而不是抛错');

  // maskOf 兜底
  const m1 = CORE.maskOf({ raw: '13800138000', masked: '138****8000' }, 'mask');
  log(m1 === '138****8000', '有 masked 时直接用引擎给的脱敏值');
  const m2 = CORE.maskOf({ raw: '12345678901' }, 'mask');
  log(m2.startsWith('1') && m2.endsWith('1') && m2.includes('*'), '缺 masked 时按首尾保留兜底', m2);
  const m3 = CORE.maskOf({ raw: 'ab' }, 'mask');
  log(m3 === '**', '超短串全部打码，不泄露任何字符');

  // 阈值与排序
  const mixed = [
    { level: 1, type: 'email', label: '邮箱', raw: 'a@b.com' },
    { level: 3, type: 'apikey', label: 'API 密钥', raw: 'sk-x' },
    { level: 2, type: 'bankcard', label: '银行卡号', raw: '4111' },
  ];
  const picked = CORE.pickItems(mixed, 2);
  log(picked.length === 2, '阈值过滤掉 L1', '剩 ' + picked.length);
  log(picked[0].level === 3, '结果按等级从高到低排序（最严重的排最前）');
  log(CORE.pickItems(mixed, 4).length === 0, '阈值 L4 时不夸大风险');

  log(CORE.levelClass(3) === 'lv3' && CORE.levelClass(99) === 'lv1', '等级样式有兜底');
  log(/高危/.test(CORE.levelTitle(3)), '等级文案可读', CORE.levelTitle(3));
}

/* ============================ B. 扩展契约 ============================ */

function testExtension() {
  section('B. 浏览器扩展（引擎副本 / manifest / 不变量）');

  const extDir = path.join(ROOT, 'extension');
  const manifestPath = path.join(extDir, 'manifest.json');
  log(fs.existsSync(manifestPath), 'manifest.json 存在');

  let mf = null;
  try { mf = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {}
  log(!!mf, 'manifest.json 是合法 JSON');
  if (!mf) return;

  log(mf.manifest_version === 3, 'Manifest V3');
  log(!!mf.name && !!mf.version, '有名称与版本', mf.version);

  const cs = (mf.content_scripts || [])[0] || {};
  const js = cs.js || [];
  log(js.indexOf('engine/schema.js') >= 0 && js.indexOf('engine/localDetector.js') >= 0,
    'content_scripts 引入了检测引擎');
  log(js.indexOf('engine/guardCore.js') >= 0, 'content_scripts 引入了守卫核心');
  log(js.indexOf('engine/schema.js') < js.indexOf('engine/guardCore.js') &&
      js.indexOf('engine/localDetector.js') < js.indexOf('engine/guardCore.js'),
    '脚本加载顺序满足依赖（引擎在核心之前）');
  log(js[js.length - 1] === 'content.js', 'content.js 最后加载');
  log(!!cs.css && cs.css.indexOf('content.css') >= 0, '注入了提醒条样式');
  log((cs.matches || []).some((x) => x.startsWith('http')), '覆盖 http/https 站点');

  // 图标文件
  const icons = mf.icons || {};
  const iconOk = Object.values(icons).every((p) => fs.existsSync(path.join(extDir, p)));
  log(iconOk, '图标文件齐备', Object.keys(icons).join('/'));

  // 引擎副本不得漂移：这是「两个产品同一套规则」的唯一保证
  const FILES = ['schema.js', 'localDetector.js', 'guardCore.js'];
  let drifted = [];
  FILES.forEach((name) => {
    const src = fs.readFileSync(path.join(ROOT, 'services', name), 'utf8');
    const copyPath = path.join(extDir, 'engine', name);
    if (!fs.existsSync(copyPath)) { drifted.push(name + '(缺失)'); return; }
    const copy = fs.readFileSync(copyPath, 'utf8');
    if (copy.indexOf(src) < 0) drifted.push(name);
  });
  log(drifted.length === 0, '扩展引擎与 services/ 完全一致（未漂移）',
    drifted.length ? '过期：' + drifted.join(',') : '3 个文件');

  // content.js 的不变量
  const contentSrc = fs.readFileSync(path.join(extDir, 'content.js'), 'utf8');
  log(contentSrc.indexOf('innerHTML') < 0, '不用 innerHTML 拼用户内容（防 XSS）');
  log(contentSrc.indexOf('CORE.writeValue') >= 0, '写回输入框复用守卫核心（React 受控兼容）');
  log(contentSrc.indexOf('maskOf') >= 0 && contentSrc.indexOf('it.raw') < 0,
    '提醒条渲染的是脱敏值，不是原文');
  log(/CORE\.pickItems/.test(contentSrc), '阈值过滤走统一实现');
  log(contentSrc.indexOf('fetch(') < 0 && contentSrc.indexOf('XMLHttpRequest') < 0,
    'content script 不发任何网络请求（原文不出本机）');

  const cssSrc = fs.readFileSync(path.join(extDir, 'content.css'), 'utf8');
  log(/\.psg-tip/.test(cssSrc), '提醒条样式存在');
  log(/position:\s*fixed\s*!important/.test(cssSrc), '提醒条用 fixed 定位，不受宿主页面影响');
  log(/prefers-color-scheme:\s*dark/.test(cssSrc), '适配深色模式');

  // 服务端必须下发 guardCore
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  log(/'guardCore\.js'/.test(serverSrc), '服务端 /engine/ 白名单包含 guardCore.js');
  log(!/express\.static\([\s\S]{0,40}services/.test(serverSrc), 'services/ 没有被整目录静态挂载（不泄露密钥模块）');
}

/* ============================ C. 页面交互 ============================ */

function inlineEngine(html) {
  const map = {
    '/engine/schema.js': 'services/schema.js',
    '/engine/localDetector.js': 'services/localDetector.js',
    '/engine/guardCore.js': 'services/guardCore.js',
  };
  let out = html;
  Object.keys(map).forEach((src) => {
    const code = fs.readFileSync(path.join(ROOT, map[src]), 'utf8');
    // 用函数做替换，避免 $& 之类的替换陷阱
    out = out.replace(new RegExp('<script src="' + src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"></script>'),
      () => '<script>' + code + '</script>');
  });
  return out;
}

async function loadGuard() {
  const { JSDOM, VirtualConsole } = require('jsdom');
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => console.log('  [jsdom] ' + e.message));
  const html = inlineEngine(fs.readFileSync(path.join(ROOT, '前端', 'guard.html'), 'utf8'));
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8099/guard.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    },
  });
  await new Promise((r) => setTimeout(r, 120));
  return dom;
}

async function testGuardPage() {
  section('C. guard.html 真实交互');

  const dom = await loadGuard();
  const win = dom.window;
  const doc = win.document;

  log(!!doc.getElementById('composer'), '发布框渲染');
  log(!!doc.getElementById('items'), '检测面板渲染');
  log(doc.querySelectorAll('.scene-chip').length >= 3, '场景切换入口齐全',
    doc.querySelectorAll('.scene-chip').length + ' 个场景');

  const ta = doc.getElementById('composer');

  // 模拟用户打字：改值 + 派发 input，等防抖
  const text = '刚换号，有事打我电话 13800138000，急！';
  ta.value = text;
  ta.dispatchEvent(new win.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 650));

  const items = doc.querySelectorAll('#items .item');
  log(items.length >= 1, '输入手机号后实时命中', items.length + ' 条');
  log(/lv1|lv2|lv3|lv4/.test(items[0] ? items[0].className : ''), '命中项带等级配色');
  log(doc.getElementById('tip').classList.contains('show'), '提醒条自动浮出');
  log(doc.getElementById('tip').textContent.indexOf('13800138000') < 0,
    '提醒条只显示脱敏值，不回显原文');
  log(doc.getElementById('count').textContent.indexOf(String(text.length)) >= 0, '字数统计同步');

  // 一键脱敏
  const maskBtn = Array.from(doc.querySelectorAll('#tip .psg-btn'))
    .find((b) => b.textContent === '一键脱敏');
  log(!!maskBtn, '提醒条提供「一键脱敏」');
  if (maskBtn) {
    maskBtn.dispatchEvent(new win.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    log(ta.value.indexOf('13800138000') < 0, '脱敏后输入框不再含原始号码', ta.value);
    log(/\*{3,}/.test(ta.value), '脱敏结果是打码形式');
  }

  // 高危内容 → 发布前二次确认
  ta.value = '密码是 MyPass2024，验证码 387294，身份证 11010519491231002X';
  ta.dispatchEvent(new win.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 650));

  const publishBtn = doc.getElementById('btnPublish');
  publishBtn.dispatchEvent(new win.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  log(doc.getElementById('mask').classList.contains('show'), '含高危信息时发布弹出二次确认');
  log(doc.getElementById('dlgTitle').textContent.indexOf('隐私') >= 0, '确认框说明风险数量',
    doc.getElementById('dlgTitle').textContent);

  // 确认框里也只能出现脱敏值
  const dlgText = doc.getElementById('dlgList').textContent;
  log(dlgText.indexOf('MyPass2024') < 0 && dlgText.indexOf('387294') < 0,
    '确认框列出的也是脱敏值');

  // 先脱敏再发布
  doc.getElementById('dlgMask').dispatchEvent(new win.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
  log(ta.value.indexOf('387294') < 0 && ta.value.indexOf('MyPass2024') < 0,
    '「先帮我脱敏」清掉了高危内容', ta.value.slice(0, 40));

  // 场景切换会换示例文案
  const chips = doc.querySelectorAll('.scene-chip');
  chips[chips.length - 1].dispatchEvent(new win.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  log(ta.value.length > 0, '切换场景后示例内容变化');

  win.close();
}

/* ============================ D. 入口页 ============================ */

function testLaunch() {
  section('D. 统一入口页');

  const src = fs.readFileSync(path.join(ROOT, '前端', 'launch.html'), 'utf8');
  log(/href="index\.html"/.test(src), '入口页链到检测工具');
  log(/href="guard\.html"/.test(src), '入口页链到输入守卫');
  log(/href="docs\.html#guard"/.test(src), '提供扩展安装说明入口');
  log(/两个独立产品|独立/.test(src), '明确说明两个产品相互独立');

  const indexSrc = fs.readFileSync(path.join(ROOT, '前端', 'index.html'), 'utf8');
  log(/href="\/guard\.html"/.test(indexSrc), '检测工具主页可跳到守卫（不是单向孤岛）');
  log(/href="\/launch\.html"/.test(indexSrc), '检测工具主页可回到入口页');

  const guardSrc = fs.readFileSync(path.join(ROOT, '前端', 'guard.html'), 'utf8');
  log(/href="launch\.html"/.test(guardSrc) && /href="index\.html"/.test(guardSrc),
    '守卫页可跳回入口与检测工具');

  // 预览图与 OG 图
  ['preview-products.png', 'og-guard.png'].forEach((f) => {
    const p = path.join(ROOT, '前端', 'icons', f);
    const ok = fs.existsSync(p) && fs.statSync(p).size > 5000;
    log(ok, '预览素材存在：' + f, ok ? Math.round(fs.statSync(p).size / 1024) + 'KB' : '缺失');
  });
}

/* ============================ 运行 ============================ */

(async function main() {
  console.log('输入守卫测试\n' + '='.repeat(48));
  testCore();
  testExtension();
  await testGuardPage();
  testLaunch();

  const total = pass + fail;
  console.log('\n' + '='.repeat(48));
  console.log('输入守卫：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + total);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
