#!/usr/bin/env node
/**
 * resolve-project-id.js — 用 AK/SK 直接查出当前账号在各区域的项目 ID
 * ---------------------------------------------------------------
 * 为什么需要：华为云的「账号 ID（domain_id）」和「项目 ID」都是 32 位十六进制，
 * 在控制台里极易复制错。填成账号 ID 时，SIS 会返回 APIG.0602 / "Bad request"，
 * 完全看不出原因（本项目实际踩过）。
 *
 * 用法：
 *   node scripts/resolve-project-id.js            # 列出全部区域
 *   node scripts/resolve-project-id.js cn-north-4 # 只看某个区域
 *   node scripts/resolve-project-id.js --write    # 把 HW_REGION 对应的项目 ID 写进 .env
 */
'use strict';
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') });

const AK = process.env.HW_AK;
const SK = process.env.HW_SK;
const REGION = process.env.HW_REGION || 'cn-north-4';

if (!AK || !SK) {
  console.error('缺少 HW_AK / HW_SK，先运行 npm run setup:credentials');
  process.exit(1);
}

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s, 'utf8').digest('hex');

/**
 * 签名后的 GET。注意 canonical URI 要补尾斜杠——APIG 计算时就是这么规范化的，
 * 少一个 / 就会一直报 "verify ak sk signature failed"。
 */
function signedGet(host, uri) {
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const signedHeaders = 'host;x-sdk-date';
  const canonicalHeaders = `host:${host}\nx-sdk-date:${now}\n`;
  const signUri = uri.endsWith('/') ? uri : uri + '/';
  const canonicalRequest = ['GET', signUri, '', canonicalHeaders, signedHeaders, sha256hex('')].join('\n');
  const stringToSign = ['SDK-HMAC-SHA256', now, sha256hex(canonicalRequest)].join('\n');
  const headers = {
    host,
    'x-sdk-date': now,
    Authorization: `SDK-HMAC-SHA256 Access=${AK}, SignedHeaders=${signedHeaders}, Signature=${hmac(SK, stringToSign)}`,
  };
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path: uri, method: 'GET', headers, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('返回不是 JSON：' + data.slice(0, 200)));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const args = process.argv.slice(2);
  const wantRegion = args.find((a) => !a.startsWith('--'));
  const write = args.includes('--write');

  let body;
  try {
    body = await signedGet('iam.cn-north-4.myhuaweicloud.com', '/v3/auth/projects');
  } catch (e) {
    console.error('查询项目列表失败：', e.message);
    console.error('常见原因：AK/SK 不对、账号欠费或被冻结。');
    process.exit(1);
  }

  const projects = (body.projects || []).filter((p) => p.enabled !== false);
  if (!projects.length) {
    console.error('这个账号下没有查到项目。');
    process.exit(1);
  }

  const domainId = projects[0].domain_id;
  const rows = projects
    .map((p) => ({ region: p.name, id: p.id }))
    .filter((p) => !wantRegion || p.region === wantRegion)
    .sort((a, b) => a.region.localeCompare(b.region));

  console.log(`账号 ID（domain_id）：${domainId}   ← 别把这个当项目 ID`);
  console.log('');
  console.log('区域'.padEnd(18) + '项目 ID');
  console.log('-'.repeat(52));
  for (const r of rows) console.log(r.region.padEnd(18) + r.id);

  const hit = rows.find((r) => r.region === REGION);
  if (!hit) {
    console.log(`\n没有找到区域 ${REGION} 的项目，检查 HW_REGION 是否写错。`);
    process.exit(1);
  }

  const current = process.env.HW_PROJECT_ID || '';
  console.log('');
  if (current === domainId) {
    console.log(`⚠️ .env 里的 HW_PROJECT_ID 是账号 ID，不是项目 ID —— 难怪 SIS 报 APIG.0602。`);
  } else if (current && current !== hit.id) {
    console.log(`⚠️ .env 里的 HW_PROJECT_ID (${current}) 与 ${REGION} 的项目 ID 不一致。`);
  } else if (current === hit.id) {
    console.log(`✅ .env 里的 HW_PROJECT_ID 与 ${REGION} 的项目 ID 一致。`);
  }

  if (write) {
    const envPath = path.join(ROOT, '.env');
    let text = fs.readFileSync(envPath, 'utf8');
    if (/^HW_PROJECT_ID=.*$/m.test(text)) {
      text = text.replace(/^HW_PROJECT_ID=.*$/m, `HW_PROJECT_ID=${hit.id}`);
    } else {
      text += `\nHW_PROJECT_ID=${hit.id}\n`;
    }
    fs.writeFileSync(envPath, text);
    console.log(`\n已写入 .env：HW_PROJECT_ID=${hit.id.slice(0, 4)}…${hit.id.slice(-2)}（${REGION}）`);
  } else {
    console.log(`\n要写入 .env，执行：npm run resolve:project -- --write`);
  }
})();
