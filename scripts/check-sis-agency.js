#!/usr/bin/env node
/**
 * 检查华为云 SIS 的「服务授权」委托是否就绪。
 *
 * 为什么要这个脚本：
 *   SIS 录音文件识别要读你的 OBS 私有桶，必须先在 SIS 控制台做「服务授权」，
 *   本质是在 IAM 里创建一个委托（默认名 sis_agency）。没做这一步时，SIS 读不到
 *   音频，却只会笼统报 `SIS.0535 wrong audio format`，极易被误判成音频格式问题。
 *   这个脚本直接查 IAM 的委托列表，让"授权做没做成"变成一条命令能验证的事。
 *
 * 用法：
 *   node scripts/check-sis-agency.js           # 只检查
 *   node scripts/check-sis-agency.js --verbose # 打印委托明细
 *
 * 退出码：0 = 委托存在；1 = 委托不存在或查询失败。
 */

const path = require('path');
const https = require('https');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const AK = process.env.HW_AK;
const SK = process.env.HW_SK;
const IAM_HOSTS = ['iam.cn-north-4.myhuaweicloud.com', 'iam.myhuaweicloud.com'];

if (!AK || !SK) {
  console.error('\n❌ .env 里缺少 HW_AK / HW_SK，先执行 npm run setup:credentials\n');
  process.exit(1);
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
function hmac(key, s) {
  return crypto.createHmac('sha256', key).update(s, 'utf8').digest('hex');
}

/** SDK-HMAC-SHA256 签名（华为云 SDK 标准鉴权） */
function signedRequest(method, host, uri, body, extraHeaders) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const payload = body === undefined || body === null ? '' : body;
  const baseHeaders = {
    'content-type': 'application/json',
    host,
    'x-sdk-date': now,
  };
  const headers = Object.assign({}, baseHeaders, extraHeaders || {});
  const headerNames = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const sh = headerNames.join(';');
  const canonicalHeaders = headerNames
    .map((k) => `${k}:${String(headers[k] ?? headers[k.toUpperCase()] ?? '').trim()}\n`)
    .join('');
  // 坑：华为云网关会把 path 规范化成「带尾斜杠」再算签名，canonical_request 里回显的就是它期望的形式。
  // 注意只对 path 补斜杠，query 保持原样，否则 /a/b?x=1 会被拼成 /a/b?x=1/ 而签名失败。
  const qPos = uri.indexOf('?');
  const p = qPos >= 0 ? uri.slice(0, qPos) : uri;
  const q = qPos >= 0 ? uri.slice(qPos + 1) : '';
  const canonicalUri = p.endsWith('/') ? p : `${p}/`;
  // canonical request 六行：METHOD / URI / QUERY / HEADERS / SIGNED_HEADERS / BODY_HASH
  const canonicalRequest = [method.toUpperCase(), canonicalUri, q, canonicalHeaders, sh, sha256hex(payload)].join('\n');
  const sts = `SDK-HMAC-SHA256\n${now}\n${sha256hex(canonicalRequest)}`;
  const sig = hmac(SK, sts);
  headers.Authorization = `SDK-HMAC-SHA256 Access=${AK}, SignedHeaders=${sh}, Signature=${sig}`;

  return new Promise((resolve) => {
    const req = https.request(
      { host, path: uri, method, headers, timeout: 15000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: String(e && e.message) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: 'timeout' });
    });
    if (method !== 'GET') req.write(payload);
    req.end();
  });
}

async function getFirstOk(uri) {
  let last = null;
  for (const host of IAM_HOSTS) {
    const r = await signedRequest('GET', host, uri, '');
    last = r;
    if (r.status === 200) return { host, r };
  }
  return { host: IAM_HOSTS[0], r: last };
}

function mask(s) {
  const t = String(s || '');
  return t.length <= 8 ? t : `${t.slice(0, 4)}…${t.slice(-4)}（${t.length} 位）`;
}

(async () => {
  console.log('\n=== SIS 服务授权（IAM 委托）检查 ===\n');

  // 1) 先拿到账号 ID（domain_id）——委托挂在 domain 下
  const { host, r } = await getFirstOk('/v3/auth/projects');
  if (r.status !== 200) {
    console.error(`❌ 查不到账号信息（HTTP ${r.status}）`);
    console.error(`   ${r.body.slice(0, 300)}`);
    console.error('\n   多半是 AK/SK 不对，或账号未实名。执行 npm run setup:credentials -- --check 核对。\n');
    process.exit(1);
  }

  let domainId = '';
  let regionProjectId = '';
  try {
    const j = JSON.parse(r.body);
    const projects = (j && j.projects) || [];
    // 返回结构：projects[].id = 项目 ID，projects[].domain_id = 账号 ID（domain_id）
    domainId = (projects[0] && projects[0].domain_id) || '';
    const region = process.env.HW_REGION || 'cn-north-4';
    const hit = projects.find((p) => p.name === region);
    regionProjectId = (hit && hit.id) || '';
  } catch (_) {
    /* 解析失败时留空，后面直接查默认列表 */
  }

  console.log(`IAM 端点     ${host}`);
  console.log(`账号 ID      ${mask(domainId)}   ← domain_id，不是项目 ID，别填进 HW_PROJECT_ID`);

  const cur = process.env.HW_PROJECT_ID || '';
  if (regionProjectId) {
    const ok = cur && cur.toLowerCase() === regionProjectId.toLowerCase();
    console.log(
      `${ok ? '✔' : '✘'} ${process.env.HW_REGION || 'cn-north-4'} 的项目 ID 期望为 ${regionProjectId}，`
        + `当前 .env = ${cur || '(空)'}`
    );
    if (!ok) console.log('   修正：npm run resolve:project -- --write');
  }
  console.log('');

  // 2) 列委托
  const uri = domainId ? `/v3.0/OS-AGENCY/agencies?domain_id=${domainId}` : '/v3.0/OS-AGENCY/agencies';
  const r2 = await signedRequest('GET', host, uri, '');
  if (r2.status !== 200) {
    console.error(`❌ 无法查询委托列表（HTTP ${r2.status}）`);
    console.error(`   ${r2.body.slice(0, 300)}`);
    console.error('\n   如果提示权限不足：只有主账号或有 Security Administrator 权限的账号能查询/创建委托。');
    console.error('   你现在用的是主账号 AK，理论上可以；若报 403，多半是账号未完成实名认证。\n');
    process.exit(1);
  }

  let agencies = [];
  try {
    agencies = JSON.parse(r2.body).agencies || [];
  } catch (_) {
    agencies = [];
  }

  console.log(`账号下共有 ${agencies.length} 个委托：`);
  if (!agencies.length) {
    console.log('  （空）\n');
  } else {
    for (const a of agencies) {
      console.log(`  - ${a.name}  [${a.agency_id ? mask(a.agency_id) : 'id?'}]  委托方=${a.trust_domain_name || '-'}`);
    }
    console.log('');
  }

  const sis = agencies.filter((a) => /sis/i.test(String(a.name)) || /sis/i.test(String(a.trust_domain_name || '')));
  if (sis.length) {
    console.log('✅ SIS 委托已存在：');
    for (const a of sis) {
      console.log(`   ${a.name}  委托方=${a.trust_domain_name || '-'}  时长=${a.duration || '-'}`);
      if (process.argv.includes('--verbose')) {
        console.log(`   ${JSON.stringify(a)}`);
      }
    }
    console.log('\n   下一步：npm run verify:sis -- --audio 录音.m4a\n');
    process.exit(0);
  }

  console.log('❌ 未找到 SIS 委托（期望看到名为 sis_agency 的委托）。');
  console.log('\n   去做这一步：');
  console.log('   1. 打开 https://console.huaweicloud.com/sis/?region=cn-north-4');
  console.log('   2. 左侧菜单「服务授权」（或总览页顶部步骤条第 4 步）');
  console.log('   3. 点「对象存储服务授权」→ 按引导创建委托（委托名默认 sis_agency）');
  console.log('   4. 回到这里重跑本脚本，看到 ✅ 再跑 npm run verify:sis\n');
  process.exit(1);
})();
