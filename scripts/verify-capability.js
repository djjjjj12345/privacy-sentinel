/**
 * 能力矩阵实证验证
 * ---------------------------------------------------------------
 * 目的不是再跑一遍单元测试（那 507 项测的是「代码写得对不对」），
 * 而是回答另一个问题：README 里宣称的每一项能力，拿真实场景的句子
 * 喂进去，到底能不能命中？会不会把不该报的报出来？
 *
 * 因此每条能力都配两个样例：
 *   正例 —— 真实场景下应当被拦下的写法；
 *   负例 —— 长得很像、但语义上不该报警的易混淆写法。
 * 判定不靠人工断言，全部取自引擎的真实返回值；失败就记失败。
 *
 * 用法：node scripts/verify-capability.js
 * 产物：docs/capability-matrix/report.json / report.md
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'services', 'localDetector'));
const G = require(path.join(ROOT, 'services', 'guardCore'));
const U = require(path.join(ROOT, 'services', 'urlGuard'));

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把命中项压缩成一句可读结论；刻意不显示 raw，与产品「不回显原文」的底线保持一致 */
function fmt(items) {
  if (!items || !items.length) return '未检出任何敏感项';
  return items
    .map((i) => `${i.type}（${i.masked}，L${i.level}，${i.verified ? '校验通过' : '校验未过·存疑'}）`)
    .join('；');
}

function push(row) {
  results.push(row);
  const mark = row.pass === true ? '✅' : row.pass === false ? '❌' : '⚠️';
  console.log(`${mark} [${row.group}] ${row.capability} · ${row.scenario}  →  ${row.actual}`);
}

/**
 * 引擎检测类用例
 * @param {'hit'|'miss'} want 期望命中还是期望不命中
 */
function detectCase(group, capability, scenario, input, type, want, opts) {
  opts = opts || {};
  let items;
  try {
    items = L.detect(input);
  } catch (e) {
    push({ group, capability, scenario, input, target: `${type} ${want === 'hit' ? '应检出' : '不应检出'}`, actual: '引擎抛错：' + e.message, pass: false, note: '运行时异常' });
    return;
  }
  const hits = items.filter((i) => i.type === type);
  let pass;
  let note = opts.note || '';

  if (want === 'hit') {
    pass = hits.length > 0;
    if (pass && opts.verified !== undefined) {
      pass = hits[0].verified === opts.verified;
      if (!pass) note = (note ? note + '；' : '') + `校验状态为 ${hits[0].verified ? '通过' : '未过'}，与预期不符`;
    }
    if (!pass && !note) note = '漏检：真实场景写法未被规则覆盖';
  } else {
    pass = hits.length === 0;
    if (!pass) note = (note ? note + '；' : '') + '误检：把非敏感内容判成了敏感项';
  }

  push({
    group,
    capability,
    scenario,
    input,
    target: `${type} ${want === 'hit' ? '应检出' : '不应检出'}`,
    actual: fmt(items),
    pass,
    note,
  });
}

// ================================================================
//  A 组 · 14 类字段识别（每类一正一负）
// ================================================================
function groupA() {
  const A = 'A 字段识别';

  // 身份证：11010519491231002X 是公开测试号，校验位 X 合法
  detectCase(A, '身份证号', '正例·入职登记填证件号', '你好，我是张三，身份证号 11010519491231002X，麻烦帮我办一下入职。', 'id', 'hit', { verified: true });
  detectCase(A, '身份证号', '负例·18 位订单流水号', '这笔订单的流水号是 123456789012345678，昨天已经发货了。', 'id', 'miss');
  detectCase(A, '身份证号', '边界·15 位老式身份证（无校验位）', '老人家持的是老身份证 110105491231002，系统里要手工核对。', 'id', 'hit', { verified: false, note: '1985 版老号本身没有校验位，规则最多只能给「存疑」，无法判定为真' });

  // 银行卡：4111111111111111 是 Visa 公开测试卡号，Luhn 通过
  detectCase(A, '银行卡号', '正例·给客服报卡号', '麻烦从这张卡扣款，卡号 4111111111111111，持卡人张三。', 'bankcard', 'hit', { verified: true });
  detectCase(A, '银行卡号', '负例·16 位快递运单号', '顺丰运单号 1234567890123456 帮我查一下到哪了。', 'bankcard', 'miss');
  detectCase(A, '银行卡号', '边界·格式像但 Luhn 校验不过', '我随手打了个卡号 6222021234567890123，麻烦核对下是不是记错了。', 'bankcard', 'hit', { verified: false, note: '校验位不合法时给「存疑」而非放过，属于刻意的保守策略' });

  detectCase(A, '手机号', '正例·群里留联系方式', '我是李雷，联系电话 13800138000，方便的话加个微信。', 'phone', 'hit');
  detectCase(A, '手机号', '负例·客服短号', '有问题请拨打客服热线 10086 咨询。', 'phone', 'miss');
  detectCase(A, '手机号', '边界·12 开头（非号段）', '内线电话 12800138000 转前台。', 'phone', 'miss');

  detectCase(A, '密码', '正例·明文写密码', '初始密码是 MyP@ssw0rd123，第一次登录请修改。', 'password', 'hit');
  detectCase(A, '密码', '负例·无关键词的裸串', 'MyP@ssw0rd123 这个字符串我放在便签里了。', 'password', 'miss', { note: '密码识别依赖「密码/口令/password」等前置关键词，脱离上下文的裸串无法识别，属于已知边界' });

  detectCase(A, '短信验证码', '正例·转述验证码', '验证码是 812345，五分钟内有效。', 'otp', 'hit');
  detectCase(A, '短信验证码', '负例·金额数字', '本次装修尾款 812345 元，已通过银行转账。', 'otp', 'miss');

  detectCase(A, '家庭住址', '正例·填写收货地址', '家庭住址：北京市朝阳区建国路88号，平时白天都在家。', 'address', 'hit');
  detectCase(A, '家庭住址', '负例·公司所在路段（无门牌）', '我们公司在北京市朝阳区建国路，地铁 1 号线直达。', 'address', 'miss');

  detectCase(A, '姓名', '正例·自我介绍', '我叫李明，来自山东，今年刚入职。', 'name', 'hit');
  detectCase(A, '姓名', '正例·冒号写法填收货人', '收货人：王芳，电话稍后发你。', 'name', 'hit');
  detectCase(A, '姓名', '负例·带职务的称呼', '这份材料请李老师过目，有问题随时找我。', 'name', 'miss');
  detectCase(A, '姓名', '负例·「我叫外卖」易误报', '我叫外卖，半小时能送到吧？', 'name', 'miss');
  detectCase(A, '姓名', '负例·「我叫了…」易误报', '我叫了两个菜，都很辣。', 'name', 'miss');
  detectCase(A, '姓名', '负例·「名字很好听」非人名', '这个名字很好听，是谁起的？', 'name', 'miss');

  detectCase(A, '电子邮箱', '正例·留邮箱', '简历发到 zhang.san@example.com 就行，我每天都看。', 'email', 'hit');
  detectCase(A, '电子邮箱', '负例·@ 提及', '这个需求 @张三 看一下，明天给结论。', 'email', 'miss');

  detectCase(A, '链接地址', '正例·带 token 的找回密码链接', '点这个重置：https://example.com/reset?token=abc123def456，半小时后失效。', 'url', 'hit');
  detectCase(A, '链接地址', '正例·OAuth 回调带 code', '回调地址填 https://example.com/oauth/callback?code=xyz789abc 就行。', 'url', 'hit');
  detectCase(A, '链接地址', '负例·普通官网链接（无敏感参数）', '公司介绍在 https://example.com/about，可以先了解一下。', 'url', 'miss');
  detectCase(A, '链接地址', '负例·普通文章链接（无敏感参数）', '这篇报道 https://news.example.com/2026/10/21/abc 写得很客观。', 'url', 'miss');

  detectCase(A, '护照号', '正例·登机信息', '我的护照号 E12345678，航班是下周一的。', 'passport', 'hit');
  detectCase(A, '护照号', '负例·产品序列号（形似）', '这台设备型号 E1234567A，保修到明年。', 'passport', 'miss');

  // 91310000MA1K35Q121：由 ISO 7064 MOD 31-3 现算校验位得到，合法
  detectCase(A, '统一社会信用代码', '正例·开票信息', '开票用统一社会信用代码 91310000MA1K35Q121，公司全称在下面。', 'uscc', 'hit', { verified: true });
  detectCase(A, '统一社会信用代码', '负例·随机 18 位编码（无上下文）', '仓库货架编码是 91310000MAIZZZZ999，盘点时用得到。', 'uscc', 'miss');

  detectCase(A, 'IP 地址', '正例·报修说内网地址', '打印机连不上了，地址配的是 192.168.1.100。', 'ip', 'hit');
  detectCase(A, 'IP 地址', '负例·软件版本号', '请升级到 v1.2.3.4 版本，修复了闪退问题。', 'ip', 'miss');

  detectCase(A, 'MAC 地址', '正例·报备设备 MAC', '这台机器的 MAC 是 00:1A:2B:3C:4D:5E，需要加白名单。', 'mac', 'hit');
  detectCase(A, 'MAC 地址', '负例·会议时间', '周会改到 12:30:45 开始，别迟到了。', 'mac', 'miss');

  detectCase(A, 'API 密钥', '正例·把密钥贴进工单', '调用失败，key 用的是 sk-proj-abcdefghijklmnopqrstuvwxyz1234567890。', 'apikey', 'hit');
  detectCase(A, 'API 密钥', '负例·短前缀（形似但太短）', '这个配置写的 sk-abc，是不是没填完整？', 'apikey', 'miss');
  detectCase(A, 'API 密钥', '边界·AWS AccessKey', 'AKIA' + 'IOSFODNN7EXAMPLE' + ' 这个 key 我先禁用掉。', 'apikey', 'hit');
  detectCase(A, 'API 密钥', '边界·JWT 三段式', 'Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'apikey', 'hit');
  detectCase(A, 'API 密钥', '边界·通用密钥声明（纯数字应排除）', '订单的 token 是 1234567890123456，注意别泄露。', 'apikey', 'miss', { note: '通用密钥兜底规则刻意排除纯数字，避免把订单号当密钥，代价是自研系统的纯数字密钥会漏' });
}

// ================================================================
//  B 组 · 校验位分级（三态：通过 / 存疑 / 不可能是）
// ================================================================
function groupB() {
  const B = 'B 校验分级';
  const assert = (capability, scenario, fn, expectVal, note) => {
    let got;
    try {
      got = fn();
    } catch (e) {
      got = '抛错：' + e.message;
    }
    const pass = got === expectVal;
    push({
      group: B,
      capability,
      scenario,
      input: scenario,
      target: `判定为 ${expectVal}`,
      actual: String(got),
      pass,
      note: pass ? (note || '') : (note ? note + '；' : '') + `实际为 ${got}`,
    });
  };

  assert('身份证 GB11643 校验位', '11010519491231002X（校验位正确）', () => L.checkIdCard('11010519491231002X'), 'valid');
  assert('身份证 GB11643 校验位', '110105194912310021（只改最后一位）', () => L.checkIdCard('110105194912310021'), 'weak');
  assert('身份证 GB11643 校验位', '123456789012345678（中间不是合法日期）', () => L.checkIdCard('123456789012345678'), null, 'null 表示「不可能是身份证」，与 weak（格式像但校验不过）区分开');
  assert('银行卡 Luhn 校验', '4111111111111111（Visa 测试卡）', () => L.checkBankCard('4111111111111111'), 'valid');
  assert('银行卡 Luhn 校验', '6222021234567890123（随手编的）', () => L.checkBankCard('6222021234567890123'), 'weak');
  assert('银行卡 Luhn 校验', '1234567890123456（首位非发卡组织号段）', () => L.checkBankCard('1234567890123456'), null, '真实卡号首位只能是 3/4/5/6，先按号段过滤能砍掉大量噪声');
  assert('统一信用代码 MOD 31-3', '91310000MA1K35Q121（校验位现算）', () => L.verifyUsccChecksum('91310000MA1K35Q121'), true);
  assert('统一信用代码 MOD 31-3', '91310000MA1K35Q122（末位改错）', () => L.verifyUsccChecksum('91310000MA1K35Q122'), false);

  // 校验未过时是否真的降级为 0.6 置信度
  const items = L.detect('卡号 6222021234567890123');
  const it = items.find((i) => i.type === 'bankcard');
  push({
    group: B,
    capability: '存疑项降级（置信度与文案）',
    scenario: 'Luhn 不过的卡号是否降级提示',
    input: '卡号 6222021234567890123',
    target: 'confidence=0.6 且 reason 提示人工确认',
    actual: it ? `confidence=${it.confidence}，reason=${it.reason}` : '未检出',
    pass: !!it && it.confidence === 0.6 && /人工确认/.test(it.reason || ''),
    note: '校验不过不放过也不误杀，降级为「存疑」',
  });
}

// ================================================================
//  C 组 · 抗变形归一化
// ================================================================
function groupC() {
  const C = 'C 抗变形';
  const cases = [
    ['零宽字符插入', '手机号 138\u200B00138000', 'phone'],
    ['全角数字', '手机号 １３８００１３８０００', 'phone'],
    ['数字间加空格', '手机号 138 0013 8000', 'phone'],
    ['数字间加连字符', '手机号 138-0013-8000', 'phone'],
    ['数字间加下划线', '手机号 138_0013_8000', 'phone'],
    ['身份证加空格分段', '身份证 110105 19491231 002X', 'id'],
    ['银行卡加连字符', '卡号 4111-1111-1111-1111', 'bankcard'],
  ];
  for (const [scenario, input, type] of cases) {
    detectCase(C, '抗变形归一化', scenario, input, type, 'hit');
  }

  // 关键边界：点号不能被折叠，否则 IP 会被识别成一串数字而漏检
  detectCase(C, '抗变形归一化', '边界·IP 点号不得被折叠', '服务器地址 192.168.1.100 需要重启。', 'ip', 'hit');
  const norm = L.normalizeForScan('192.168.1.100');
  push({
    group: C,
    capability: '抗变形归一化',
    scenario: '边界·归一化后点号是否保留',
    input: '192.168.1.100',
    target: 'normalized 仍为 192.168.1.100（点号不折叠）',
    actual: norm.text,
    pass: norm.text === '192.168.1.100',
    note: '点号若被折叠成 1921681100，IP 规则将全部失效',
  });

  // 抗变形后的脱敏区间必须映射回原文，不能串位
  const text = '手机号 138\u200B00138000 记一下';
  const items = L.detect(text);
  const masked = G.buildMaskedText(text, items, 'mask');
  push({
    group: C,
    capability: '抗变形归一化',
    scenario: '边界·变形文本的脱敏区间映射回原文',
    input: '手机号 138\\u200B00138000 记一下',
    target: '脱敏结果不含原始号码且不破坏前后文',
    actual: JSON.stringify(masked),
    pass: !/13800138000/.test(masked) && /138\*{4}8000/.test(masked) && /记一下/.test(masked),
    note: '归一化命中后需按 start/end 映射回原文再替换',
  });
}

// ================================================================
//  D 组 · 脱敏与导出（三种策略）
// ================================================================
function groupD() {
  const D = 'D 脱敏导出';
  const text = '我叫李明，手机 13800138000，邮箱 zhang.san@example.com，卡号 4111111111111111。';
  const items = L.detect(text);

  const strategies = [
    ['掩码（mask）', 'mask', (out) => /138\*{4}8000/.test(out) && !/13800138000/.test(out)],
    ['替换成类型标签（label）', 'label', (out) => /\[手机号\]/.test(out) && !/13800138000/.test(out)],
    ['删除（remove）', 'remove', (out) => !/13800138000/.test(out) && !/4111111111111111/.test(out)],
  ];
  for (const [name, s, ok] of strategies) {
    const out = G.buildMaskedText(text, items, s);
    push({
      group: D,
      capability: '脱敏导出三策略',
      scenario: name,
      input: text,
      target: '输出中不得残留任何原文敏感值',
      actual: JSON.stringify(out),
      pass: ok(out),
      note: '',
    });
  }

  // 多命中不串位：长文本里多处敏感项，逐段替换不能错位
  const long = '第一位同学手机 13800138000，第二位 13900139000，第三位 13700137000，请依次联系。';
  const many = L.detect(long);
  const out = G.buildMaskedText(long, many, 'mask');
  push({
    group: D,
    capability: '脱敏导出三策略',
    scenario: '边界·同一段文本多处命中不串位',
    input: long,
    target: `检出 ${3} 项且逐段替换后顺序不变`,
    actual: `检出 ${many.length} 项 → ` + JSON.stringify(out),
    pass: many.length === 3 && /138\*{4}8000/.test(out) && /139\*{4}9000/.test(out) && /137\*{4}7000/.test(out),
    note: '必须从后往前替换，否则前面的下标会被长度变化带偏',
  });

  // 回归：链接后面的中文正文不得被当成 URL 的一部分吞掉
  const linkText = '点这个重置：https://example.com/reset?token=abc123def456，半小时后失效。';
  const linkItems = L.detect(linkText);
  const linkOut = G.buildMaskedText(linkText, linkItems, 'remove');
  push({
    group: D,
    capability: '脱敏导出三策略',
    scenario: '回归·链接后的中文正文不得被吞',
    input: linkText,
    target: '删除策略只删链接，正文「半小时后失效」必须保留',
    actual: JSON.stringify(linkOut),
    pass: /半小时后失效/.test(linkOut) && !/example\.com/.test(linkOut),
    note: '归一化会把全角逗号转半角，URL 终止字符集若只写全角，正文会被连带删除',
  });

  // 区间越界安全：文本已被外部改写时不应抛错
  const broken = G.buildMaskedText('很短', [{ type: 'phone', start: 0, end: 99, masked: '138****8000' }], 'mask');
  push({
    group: D,
    capability: '脱敏导出三策略',
    scenario: '边界·区间越界（文本被外部改写）',
    input: '很短',
    target: '跳过越界区间而不是抛异常',
    actual: JSON.stringify(broken),
    pass: broken === '很短',
    note: '守卫场景下用户可能在提醒弹出后继续打字',
  });
}

// ================================================================
//  E 组 · 输入守卫（jsdom 真实 DOM）
// ================================================================
async function groupE() {
  const E = 'E 输入守卫';
  let JSDOM;
  try {
    JSDOM = require('jsdom').JSDOM;
  } catch (e) {
    push({ group: E, capability: '守卫 DOM 写入', scenario: 'jsdom 未安装', input: '-', target: '-', actual: '跳过：' + e.message, pass: null, note: '' });
    return;
  }

  const dom = new JSDOM(
    '<input id="a" type="text"><textarea id="b"></textarea><div id="c" contenteditable="true"></div><input id="d" type="password">',
    { runScripts: 'outside-only' }
  );
  const win = dom.window;
  // 顺序不能变：localDetector 依赖全局 PSSchema
  win.eval(fs.readFileSync(path.join(ROOT, 'services', 'schema.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(ROOT, 'services', 'guardCore.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(ROOT, 'services', 'localDetector.js'), 'utf8'));
  const GC = win.PSGuardCore;
  const LD = win.PSLocal;

  const TYPED = '帮我打这个电话 13800138000';

  const runOne = (id, label) => {
    const el = win.document.getElementById(id);
    el.value = TYPED;
    const items = LD.detect(GC.readValue(el));
    const picked = GC.pickItems(items, 1);
    GC.writeValue(el, GC.buildMaskedText(GC.readValue(el), picked, 'mask'));
    const finalVal = GC.readValue(el);
    push({
      group: E,
      capability: '守卫写入输入框',
      scenario: label,
      input: TYPED,
      target: '检出手机号并写回脱敏值，框内原文消失',
      actual: `检出 ${items.length} 项 → 框内变为 ${JSON.stringify(finalVal)}`,
      pass: items.some((i) => i.type === 'phone') && !/13800138000/.test(finalVal) && /138\*{4}8000/.test(finalVal),
      note: '',
    });
  };

  runOne('a', '原生 input');
  runOne('b', 'textarea');

  // contenteditable：需要浏览器真实的 isContentEditable 与 execCommand
  const ce = win.document.getElementById('c');
  ce.textContent = TYPED;
  if (!ce.isContentEditable) {
    push({
      group: E,
      capability: '守卫写入输入框',
      scenario: 'contenteditable 富文本框',
      input: TYPED,
      target: '检出并写回脱敏值',
      actual: `jsdom 未实现 isContentEditable（值=${ce.isContentEditable}），无法验证`,
      pass: null,
      note: '环境限制：jsdom 既不实现 isContentEditable 也不实现 execCommand。真实浏览器行为已由 npm run verify:real 的 24 项断言覆盖（含真实站点输入框）',
    });
  } else {
    const ceItems = LD.detect(ce.textContent);
    GC.writeValue(ce, GC.buildMaskedText(ce.textContent, GC.pickItems(ceItems, 1), 'mask'));
    push({
      group: E,
      capability: '守卫写入输入框',
      scenario: 'contenteditable 富文本框',
      input: TYPED,
      target: '检出并写回脱敏值',
      actual: JSON.stringify(ce.textContent),
      pass: !/13800138000/.test(ce.textContent) && /138\*{4}8000/.test(ce.textContent),
      note: '',
    });
  }

  // 密码框不得报警
  const pwd = win.document.getElementById('d');
  push({
    group: E,
    capability: '守卫跳过密码框',
    scenario: '负例·密码输入框内输入密码是正常行为',
    input: 'type=password 的输入框',
    target: 'isEditable 返回 false，不提示',
    actual: `isEditable=${GC.isEditable(pwd)}`,
    pass: GC.isEditable(pwd) === false,
    note: '',
  });

  // 提示只显示脱敏值
  const it = L.detect(TYPED).find((i) => i.type === 'phone');
  const shown = GC.maskOf(it, 'mask');
  push({
    group: E,
    capability: '提示不回显原文',
    scenario: '提醒条上显示的内容',
    input: TYPED,
    target: '只显示脱敏值，绝不出现原文',
    actual: shown,
    pass: !/13800138000/.test(shown),
    note: '提醒条本身不能再泄露第二次',
  });

  // 阈值过滤
  const all = L.detect('验证码是 812345，手机 13800138000');
  const l3 = GC.pickItems(all, 3);
  push({
    group: E,
    capability: '阈值过滤（L1~L4 可调）',
    scenario: '阈值设为 L3 时低危手机号是否还弹',
    input: '验证码是 812345，手机 13800138000',
    target: '只剩 L4 验证码，L1 手机号被过滤',
    actual: `L3 以上剩 ${l3.length} 项：` + fmt(l3),
    pass: l3.length === 1 && l3[0].type === 'otp',
    note: '',
  });

  dom.window.close();
}

// ================================================================
//  F 组 · SSRF 图片地址守卫
// ================================================================
function groupF() {
  const F = 'F SSRF 守卫';
  const cases = [
    ['正例·公网图片地址', 'https://i.imgur.com/abc123.png', true],
    ['正例·data URL（不经过网络）', 'data:image/png;base64,iVBORw0KGgo=', true],
    ['负例·云元数据 169.254.169.254', 'http://169.254.169.254/latest/meta-data/', false],
    ['负例·环回地址', 'http://127.0.0.1:8080/admin', false],
    ['负例·私网 10/8', 'http://10.0.0.5/internal', false],
    ['负例·私网 192.168/16', 'http://192.168.1.1/router', false],
    ['负例·localhost 域名', 'http://localhost/a.png', false],
    ['负例·file 协议', 'file:///etc/passwd', false],
    ['负例·带用户名密码', 'http://user:pass@example.com/a.png', false],
    ['负例·IPv6 环回', 'http://[::1]/a.png', false],
    ['负例·IPv4 映射的 IPv6', 'http://[::ffff:127.0.0.1]/a.png', false],
    ['边界·十进制整数写法绕过', 'http://2130706433/a.png', false],
    ['边界·八进制写法绕过', 'http://0177.0.0.1/a.png', false],
    ['边界·公网域名但实际解析到内网', 'http://internal.evil-example.com/a.png', true],
  ];

  for (const [scenario, url, ok] of cases) {
    let r;
    try {
      r = U.checkImageUrl(url);
    } catch (e) {
      r = { ok: false, reason: '抛错：' + e.message };
    }
    const noteMap = {
      'http://2130706433/a.png': '十进制整数写法等价于 127.0.0.1，按字面主机名判断会放过；当前未做 DNS/整型归一，属已知绕过',
      'http://0177.0.0.1/a.png': '八进制写法同理，属已知绕过',
      'http://internal.evil-example.com/a.png': 'DNS 重绑定：只做字面判断、不做解析，域名指向内网时无法拦截，源码注释已声明',
    };
    push({
      group: F,
      capability: '图片地址 SSRF 守卫',
      scenario,
      input: url,
      target: ok ? '放行' : '拒绝',
      actual: r.ok ? '放行' : `拒绝（${r.reason}）`,
      pass: r.ok === ok,
      note: r.ok === ok ? (noteMap[url] || '') : '判定与预期相反',
    });
  }
}

// ================================================================
//  G 组 · 服务端接口与安全头（真实起进程）
// ================================================================
function get(port, p, headers) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 15000, headers: headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: '' }); });
  });
}

async function groupG() {
  const Gp = 'G 服务端';
  const PORT = 8123;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: 'ignore',
    windowsHide: true,
  });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const r = await get(PORT, '/api/health');
    if (r.status === 200) { up = true; break; }
  }
  if (!up) {
    push({ group: Gp, capability: '服务启动', scenario: '启动 server.js', input: '-', target: '健康检查 200', actual: '服务未能在 20 秒内启动', pass: false, note: '' });
    child.kill();
    return;
  }

  const health = await get(PORT, '/api/health');
  push({
    group: Gp, capability: '健康检查接口', scenario: 'GET /api/health', input: '/api/health',
    target: '200 且返回版本', actual: `${health.status} ${health.body.slice(0, 120)}`,
    pass: health.status === 200 && /version/i.test(health.body), note: '',
  });

  const priv = await get(PORT, '/api/privacy');
  let n = 0;
  try { n = (JSON.parse(priv.body).points || []).length; } catch (e) { /* ignore */ }
  push({
    group: Gp, capability: '隐私承诺接口', scenario: 'GET /api/privacy', input: '/api/privacy',
    target: '200 且承诺条目 > 0', actual: `${priv.status}，承诺 ${n} 条`, pass: priv.status === 200 && n > 0, note: '',
  });

  for (const [file, want] of [['schema.js', 200], ['localDetector.js', 200], ['guardCore.js', 200], ['secret.js', 404], ['../server.js', 404]]) {
    const r = await get(PORT, '/engine/' + file);
    push({
      group: Gp, capability: '引擎文件白名单', scenario: `/engine/${file}`, input: file,
      target: `期望 ${want}`, actual: String(r.status), pass: r.status === want,
      note: want === 404 ? '白名单外的文件不得下发，否则等于把服务端源码公开' : '',
    });
  }

  const idx = await get(PORT, '/');
  const h = idx.headers;
  // HSTS 只在 HTTPS 下发送（否则本地 http 调试会被浏览器强制跳转），
  // 因此这里带上 x-forwarded-proto 模拟部署在反向代理后的真实情况。
  const hstsRes = await get(PORT, '/', { 'x-forwarded-proto': 'https' });
  const csp = h['content-security-policy'] || '';
  const checks = [
    ['CSP 含 nonce（无 unsafe-inline）', /'nonce-/.test(csp) && !/unsafe-inline/.test(csp), csp.slice(0, 90)],
    ['X-Content-Type-Options: nosniff', (h['x-content-type-options'] || '') === 'nosniff', h['x-content-type-options'] || '(缺失)'],
    ['HSTS 头（HTTPS 下才应出现）', /max-age=/.test(hstsRes.headers['strict-transport-security'] || ''), (hstsRes.headers['strict-transport-security'] || '(缺失)') + ' · http 下为 ' + (h['strict-transport-security'] || '不发送（符合设计）')],
    ['X-Frame-Options / CSP frame-ancestors', !!(h['x-frame-options'] || /frame-ancestors/.test(csp)), h['x-frame-options'] || '(见 CSP)'],
    ['Referrer-Policy', !!h['referrer-policy'], h['referrer-policy'] || '(缺失)'],
  ];
  for (const [name, ok, actual] of checks) {
    push({ group: Gp, capability: '安全响应头', scenario: name, input: 'GET /', target: '存在且配置正确', actual: String(actual), pass: !!ok, note: '' });
  }

  const r404 = await get(PORT, '/api/analyze');
  push({
    group: Gp, capability: '文本检测接口', scenario: 'POST 缺失时的响应（错误分类）', input: 'GET /api/analyze',
    target: '返回结构化错误而非崩溃', actual: `${r404.status} ${r404.body.slice(0, 100)}`,
    pass: r404.status >= 400 && r404.status < 500, note: '云端模式需要模型凭证，本机无凭证，云端链路未实测',
  });

  child.kill();
}

// ================================================================
//  H 组 · 已知边界（这些不是想藏，而是必须摆在台面上）
// ================================================================
function groupH() {
  const H = 'H 已知边界';

  // 批量：引擎层验证一次 50 行
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`第${i + 1}位客户手机 13800138${String(i).padStart(3, '0')}`);
  const hitLines = lines.filter((l) => L.detect(l).some((x) => x.type === 'phone')).length;
  push({
    group: H,
    capability: '批量检测（50 行）',
    scenario: '50 行客户名单逐行检测',
    input: '50 行文本，每行含一个手机号',
    target: '50 行全部命中手机号',
    actual: `${hitLines}/50 行命中`,
    pass: hitLines === 50,
    note: '',
  });

  // 语义层：中文数字写法，本地正则无解
  detectCase(
    H,
    '语义层理解（需云端模型）',
    '口语化中文数字手机号',
    '我叫李明，电话是一三八零零一三八零零零，微信同号。',
    'phone',
    'hit',
    { note: '本地正则无法覆盖中文数字写法，这是「正则 vs 语义」的固有边界，不是配置问题；云端模式需模型凭证，本机未实测' }
  );

  detectCase(
    H,
    '语义层理解（需云端模型）',
    '拆分式表述（先说号码再说是什么）',
    '我刚换号了，13800138000，你存一下。',
    'phone',
    'hit',
    { note: '裸号码无上下文，规则仍可按号段命中；但「这是啥号」的判断需要语义' }
  );
}

// ================================================================
//  报告输出
// ================================================================
/**
 * 首轮跑出来的真实失败项。修复后它们在上表里已转为通过，
 * 但原始输出必须留档——只展示修复后的漂亮结果等于粉饰。
 */
const FIXES_MD = `
## 首轮验证暴露的缺陷（修复前实测输出留档）

首轮 92 条用例中有 7 条未通过，其中 5 条是产品真实缺陷，2 条是脚本自身写错。
下表逐条列出**修复前**引擎的真实返回值，修复后已全部转为通过（见上表）。

| # | 缺陷 | 修复前实测 | 性质 | 处理 |
|---|---|---|---|---|
| 1 | URL 终止字符集只列了全角标点 | 输入「点这个重置：https://example.com/reset?token=abc123def456，半小时后失效。」，检出项为 \`https://example.com/reset?token=abc123def456,半小时后失效\`（整句中文被吃进 URL）；「删除」策略导出结果为 \`点这个重置：。\`——**用户正文被删掉** | 破坏性缺陷：导出会丢失正文 | 已修：终止字符集补全角标点 |
| 2 | 姓名在前端可勾选，但引擎里没有对应规则 | 输入「我叫李明，来自山东，今年刚入职。」→ 未检出任何敏感项 | 能力缺失：宣称 14 类，实际 13 类 | 已修：新增强自述语境姓名规则 |
| 3 | 家庭住址把「道路名无门牌」也判为住址 | 输入「我们公司在北京市朝阳区建国路，地铁 1 号线直达。」→ 检出 address | 过度检出（噪音） | 已修：道路通名必须跟门牌数字 |
| 4 | 软件版本号被判为 IP | 输入「请升级到 v1.2.3.4 版本」→ 检出 ip（1.2.*.*） | 误检 | 已修：前后不得为字母或点 |
| 5 | 任何链接都判为敏感 | 输入「公司介绍在 https://example.com/about」→ 检出 url | 过度检出，与 README「带 token 的链接」表述不一致 | 已修：仅敏感查询参数才报警 |
| 6 | 脚本 bug：「/api/privacy」字段名写成 promises | 实际字段是 \`points\`，导致断言恒为 0 条 | 测试脚本错误，非产品缺陷 | 已修正脚本 |
| 7 | 脚本 bug：HSTS 在本地 http 下断言 | 设计上 HSTS 只在 HTTPS 发送（见 securityHeaders.js 注释） | 测试脚本错误，非产品缺陷 | 改为带 x-forwarded-proto 验证 |

### 仍然存在的边界（未修，如实列出）

- **contenteditable 富文本框**：jsdom 既不实现 \`isContentEditable\` 也不实现 \`execCommand\`，
  本套件无法验证，标记为跳过。真实浏览器行为由 \`npm run verify:real\`
  的 24 项断言覆盖（在百度 / 掘金 / 哔哩哔哩 / 豆瓣的真实输入框里打字验证）。
- **SSRF 十进制 / 八进制写法**：\`http://2130706433/\` 与 \`http://0177.0.0.1/\` 实测均为**拒绝**——
  不是规则写得好，而是 WHATWG URL 解析器会先把这类主机名规范化成 \`127.0.0.1\`，
  再被私网判定拦下。这类绕过能被覆盖属于「站在标准库的肩膀上」，不是本项目的功劳。
- **SSRF DNS 重绑定**：源码注释已声明只做字面判断、不做 DNS 解析，
  因此「公网域名实际解析到内网」**无法拦截**（上表最后一条实测为「放行」，属已知边界）。
- **语义层**：本地只有正则。「我叫李明，电话是一三八零零一三八零零零」
  这类口语化、中文数字写法**检不出**，需依赖云端语义模型，本机无凭证未实测。
- **多模态（图片 / 音频 / 视频）**：需要云端模型凭证，本机未配置，本轮**未实测**。
`;

function esc(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function writeReport() {
  const outDir = path.join(ROOT, 'docs', 'capability-matrix');
  fs.mkdirSync(outDir, { recursive: true });

  const total = results.length;
  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false).length;
  const skipped = results.filter((r) => r.pass === null).length;

  fs.writeFileSync(
    path.join(outDir, 'report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), total, passed, failed, skipped, results }, null, 2),
    'utf8'
  );

  const groups = [];
  for (const r of results) if (!groups.includes(r.group)) groups.push(r.group);

  let md = '# 隐私哨兵 · 能力矩阵实证验证报告\n\n';
  md += `生成时间：${new Date().toLocaleString('zh-CN')}\n\n`;
  md += `共 ${total} 条用例：**通过 ${passed}**，**失败 ${failed}**，跳过 ${skipped}。\n\n`;
  md += '> 所有结果均由 `node scripts/verify-capability.js` 实际运行引擎取得，未作人工修饰。\n';
  md += '> 「实际运行结果」列刻意只显示脱敏值，与产品「不回显原文」的底线保持一致。\n\n';

  for (const g of groups) {
    const rows = results.filter((r) => r.group === g);
    const p = rows.filter((r) => r.pass === true).length;
    md += `## ${g}（${p}/${rows.length} 通过）\n\n`;
    md += '| 能力项 | 测试样例 | 预期检出目标 | 实际运行结果 | 是否通过 | 失败原因与边界说明 |\n';
    md += '|---|---|---|---|---|---|\n';
    for (const r of rows) {
      md += `| ${esc(r.capability)} | ${esc(r.scenario)}<br><code>${esc(r.input).slice(0, 120)}</code> | ${esc(r.target)} | ${esc(r.actual).slice(0, 160)} | ${r.pass === true ? '✅ 通过' : r.pass === false ? '❌ 未通过' : '⚠️ 跳过'} | ${esc(r.note)} |\n`;
    }
    md += '\n';
  }

  const bad = results.filter((r) => r.pass === false);
  if (bad.length) {
    md += '## 未通过项汇总\n\n';
    for (const r of bad) md += `- **${r.capability}｜${r.scenario}**：${r.note || '判定与预期不符'}（实际：${r.actual}）\n`;
    md += '\n';
  }

  md += FIXES_MD;

  md += `## 未在本套件中实测的能力（如实说明）

| 能力 | 未实测原因 |
|---|---|
| 图片 / 音频 / 视频检测 | 需要云端模型与对象存储凭证，本机未配置；\`npm test\` 中「华为云适配 32 项」「SIS 音频转写 52 项」是接口级桩验证，非真实联调 |
| 云端语义检测 | 同上，需要模型 API Key |
| 账号注册登录与历史持久化 | 由「账号与历史 22 项」套件覆盖（真实 SQLite），本轮不重复 |
| 批量 UI / 规则开关 / 分层报告 / 导出按钮 | 由「前端交互 107 项」套件以 jsdom 真实点击覆盖，本轮只补了引擎层批量能力 |
| 浏览器扩展安装链路 | 无头模式加载不了扩展，\`npm run verify:real\` 退化为注入等价脚本；安装需人工验证一次 |
`;

  fs.writeFileSync(path.join(outDir, 'report.md'), md, 'utf8');

  console.log('\n' + '='.repeat(60));
  console.log(`用例 ${total} 条：通过 ${passed}，失败 ${failed}，跳过 ${skipped}`);
  if (bad.length) {
    console.log('\n未通过项：');
    bad.forEach((r) => console.log(`  ❌ ${r.capability}｜${r.scenario} → ${r.note || r.actual}`));
  }
  console.log(`\n报告：docs/capability-matrix/report.md · report.json`);
}

(async () => {
  groupA();
  groupB();
  groupC();
  groupD();
  await groupE();
  groupF();
  await groupG();
  groupH();
  writeReport();
  process.exit(0);
})();
