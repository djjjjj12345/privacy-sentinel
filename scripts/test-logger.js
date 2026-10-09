// 验证 logger 的脱敏效果
const logger = require('../services/logger');
const m = (s) => logger.sanitizeForLog(s);
const obj = (o) => logger.sanitizeForLog(o);
const tests = [];

function expect(input, predicate, desc) {
  const out = JSON.stringify(input);
  const ok = predicate(out);
  tests.push({ desc, ok });
}

console.log('--- 字符串内联模式 ---');
console.log('身份证:', m('张三的身份证是 110105199003071239，请保密'));
console.log('手机  :', m('联系我 13912345678 即可'));
console.log('银行卡:', m('卡号 6228480012345671 余额 100 元'));
console.log('邮箱  :', m('邮箱 alice@example.com'));
console.log('IP    :', m('访问 192.168.1.1 后台'));
console.log('护照  :', m('护照号 E12345678'));
console.log('社信码:', m('统一社会信用代码 91110000600037341G'));
console.log('Bearer:', m('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payloadXYZ.sig'));
console.log('Key=  :', m('api_key=ark-f4b99485-2c9f-4cd4'));
console.log('CVV   :', m('cvv 123, 有效期 12/27'));

console.log('\n--- 对象嵌套 ---');
console.log(JSON.stringify(obj({
  text: '王五身份证 110105198001011234',
  dataUrl: 'data:text/plain;base64,' + 'A'.repeat(300),
  phone: '13800138000',
  email: 'me@x.com',
  headers: { authorization: 'Bearer xyz', cookie: 'session=abc' },
  arrays: [{ raw: '13700000001' }, '银行卡 6228480012345671'],
}), null, 2));

console.log('\n--- Error 对象 ---');
const e = new Error('用户上传的 13800138000 无法识别');
e.status = 500;
e.code = 'TEST';
console.log(JSON.stringify(obj(e), null, 2));

console.log('\n--- 脱敏断言 ---');
expect(m('13912345678'), (s) => !s.includes('13912345678'), '手机号完全消失');
expect(m('110105199003071239'), (s) => !s.includes('110105199003071239'), '身份证完全消失');
expect(m('6228480012345671'), (s) => !s.includes('6228480012345671'), '银行卡完全消失');
expect(m('alice@example.com'), (s) => !s.includes('alice@example.com'), '邮箱完全消失');
expect(m('Bearer eyJaaa'), (s) => !s.includes('eyJaaa'), 'Bearer token 完全消失');
expect(m('api_key=ark-f4b99485-2c9f-4cd4'), (s) => !s.includes('ark-f4b99485'), 'API Key 完全消失');
expect(m('E12345678'), (s) => !s.includes('E12345678'), '护照完全消失');
expect(obj({ phone: '13800138000' }), (s) => !s.includes('13800138000'), '字段名为 phone 时整字段替换');
expect(obj({ dataUrl: 'data:text/plain;base64,' + 'A'.repeat(300) }),
  (s) => !s.includes('A'.repeat(300)),
  'dataUrl 中的 base64 整块替换');
expect(obj({ headers: { authorization: 'Bearer xyz' } }),
  (s) => !s.includes('Bearer xyz'), 'authorization 字段整字段替换');

const pass = tests.filter((t) => t.ok).length;
const fail = tests.filter((t) => !t.ok);
console.log(`\n通过 ${pass}/${tests.length}`);
if (fail.length) {
  console.log('失败:', JSON.stringify(fail, null, 2));
  process.exit(1);
}
console.log('✅ 所有断言通过——日志不会再泄露用户原始隐私');
