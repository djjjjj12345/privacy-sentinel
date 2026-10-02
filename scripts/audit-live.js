/**
 * 线上功能复查脚本（只读，不做任何修改）
 * 用法: node scripts/audit-live.js [base-url]
 */
const BASE = process.argv[2] || 'https://privacy-sentinel.onrender.com';

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((e) => ({ status: 0, error: e.message }));
  if (r.error) return { status: 0, error: r.error };
  try {
    return { status: r.status, j: await r.json() };
  } catch {
    return { status: r.status, bad: true };
  }
}

const cases = [
  ['1.普通文本', { kind: 'text', text: '今天天气不错' }],
  ['2.身份证(校验通过)', { kind: 'text', text: '我的身份证是110105199003071239' }],
  ['3.身份证(校验失败)', { kind: 'text', text: '我的身份证是110105199003071234' }],
  ['4.验证码', { kind: 'text', text: '验证码482913快发我' }],
  ['5.银行卡+手机', { kind: 'text', text: '卡号6228480012345671 电话13912345678' }],
  ['6.含URL文本', { kind: 'text', text: '看这个 http://example.com/a.jpg 顺便身份证110105199003071239' }],
  ['7.英文混合', { kind: 'text', text: 'my ID is 110105199003071239 and code is 482913' }],
  ['8.长文本', { kind: 'text', text: '测试。'.repeat(2000) + '身份证110105199003071239' }],
  ['9.画像-老人高敏感', { kind: 'text', text: '我的卡号是6228480012345671', profile: { age: 'elder', literacy: 'low', sensitivity: 'high' } }],
  ['10.纯空白', { kind: 'text', text: '    ' }],
  ['11.未知kind', { kind: 'foo' }],
  ['13.音频-假数据', { kind: 'audio', dataUrl: 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAA' }],
  ['14.视频-假数据', { kind: 'video', dataUrl: 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=' }],
  ['15.音频-不支持格式', { kind: 'audio', dataUrl: 'data:audio/webm;base64,AAAA' }],
  ['16.缺少内容', { kind: 'text' }],
];

(async () => {
  console.log('目标:', BASE, '\n');
  for (const c of cases) {
    const name = c[0];
    const body = c[1];
    const r = await post('/api/analyze', body);
    if (r.error) {
      console.log(name, '=> 网络错误:', r.error);
      continue;
    }
    if (r.bad) {
      console.log(name, '=> HTTP', r.status, '(非JSON响应!)');
      continue;
    }
    const j = r.j || {};
    const items = (j.items || []).map((i) => i.label + '[L' + i.level + ']').join(' ');
    console.log(
      name, '=> HTTP', r.status, '|',
      j.success ? 'OK' : 'ERR:' + String(j.error || '').slice(0, 60), '|',
      items || '无条目',
      j.source ? '| ' + j.source : '',
      j.transcript ? ' | 转写:' + j.transcript.slice(0, 30) : ''
    );
  }
})();
