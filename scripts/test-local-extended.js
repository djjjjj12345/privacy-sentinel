// 验证扩展后的本地正则引擎
const { detect, verifyUsccChecksum } = require('../services/localDetector');

let pass = 0, fail = 0;
const cases = [
  // 邮箱
  { text: '请发到 alice@example.com', expect: 'email', value: 'alice@example.com' },
  { text: '邮箱 user.name+tag@sub.example.co.uk 可以联系我', expect: 'email', value: 'user.name+tag@sub.example.co.uk' },
  // URL：含 token
  { text: '打开 https://example.com/login?token=abc123&page=1 完成验证', expect: 'url', value: 'https://example.com/login?token=abc123&page=1' },
  // 护照（中国 E/G/D 系列带前置关键词）
  { text: '我的护照 E12345678 即将过期', expect: 'passport', value: 'E12345678' },
  { text: '护照号: G98765432', expect: 'passport', value: 'G98765432' },
  // 统一社会信用代码
  { text: '统一社会信用代码 91110000600037341L', expect: 'uscc', value: '91110000600037341L' },
  // IPv4
  { text: '服务器 192.168.1.100 端口 22', expect: 'ip', value: '192.168.1.100' },
  { text: '公网 8.8.8.8', expect: 'ip', value: '8.8.8.8' },
  // IPv6
  { text: 'IPv6 地址 2001:0db8:85a3:0000:0000:8a2e:0370:7334 出口', expect: 'ip', value: '2001:0db8:85a3:0000:0000:8a2e:0370:7334' },
  // MAC
  { text: 'MAC 地址 AA-BB-CC-DD-EE-FF', expect: 'mac', value: 'AA-BB-CC-DD-EE-FF' },
  // 旧的应当仍然能识别（回归）
  {
    text: '我的身份证 110105199003071239 和 13800138000',
    expectBoth: ['id', 'phone'],
  },
  { text: '银行卡 6228480012345671', expect: 'bankcard' },
  // 不应误报
  { text: '今天 2024-10-08 天气晴', expectNot: '其他敏感字段' },
];

for (const c of cases) {
  const items = detect(c.text);
  if (c.expect) {
    const found = items.find((i) => i.type === c.expect && (!c.value || i.raw === c.value));
    if (found) {
      console.log(`✅ ${c.text.slice(0,30)}... -> ${c.expect}=${found.raw} (${found.verified?'verified':'weak'}, L${found.level})`);
      pass++;
    } else {
      console.log(`❌ ${c.text.slice(0,30)}... -> 未识别到 ${c.expect}`);
      console.log('   found:', items.map(i => `${i.type}:${i.raw}`).join(', ') || '(none)');
      fail++;
    }
  }
  if (c.expectBoth) {
    let allFound = true;
    for (const t of c.expectBoth) {
      if (!items.find((i) => i.type === t)) { allFound = false; break; }
    }
    if (allFound) {
      console.log(`✅ 同时识别 [${c.expectBoth.join(',')}] in "${c.text.slice(0,30)}..."`);
      pass++;
    } else {
      console.log(`❌ 未全部识别 [${c.expectBoth.join(',')}], found: ${items.map(i=>i.type).join(',')}`);
      fail++;
    }
  }
  if (c.expectNot) {
    const unwanted = items.filter((i) => i.type === c.expectNot);
    if (unwanted.length === 0) {
      console.log(`✅ 不应识别 [${c.expectNot}]: "${c.text.slice(0,30)}..."`);
      pass++;
    } else {
      console.log(`❌ 误报了 ${c.expectNot}: ${unwanted.map(i => i.raw).join(', ')}`);
      fail++;
    }
  }
}

// 独立校验 USCC 校验位
const usccGood = verifyUsccChecksum('91110000600037341L'); // 校验位算对后应为 L
const usccBad = verifyUsccChecksum('9111000060003734XX'); // XX 不在字符表
const usccI = verifyUsccChecksum('91110000600037341I'); // 含被跳过的 I
console.log(`\nUSCC 校验位算法自检:`);
console.log(`  合法 "91110000600037341L" 应通过: ${usccGood ? '✅' : '❌'}`);
console.log(`  非法 XX 应拒绝:                  ${!usccBad ? '✅' : '❌'}`);
console.log(`  含被跳过字符 I 应拒绝:           ${!usccI ? '✅' : '❌'}`);
usccGood ? pass++ : fail++;
!usccBad ? pass++ : fail++;
!usccI ? pass++ : fail++;

console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`);
if (fail > 0) process.exit(1);
