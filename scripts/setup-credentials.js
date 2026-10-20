/**
 * setup-credentials.js — 把华为云凭证写进 .env（不让密钥出现在对话 / 终端历史里）
 * ---------------------------------------------------------------
 * 用法：
 *   node scripts/setup-credentials.js --csv "C:/Users/你/Downloads/credentials.csv"
 *   node scripts/setup-credentials.js --project-id 0f2c1a3b...   # 填项目 ID
 *   node scripts/setup-credentials.js --check                    # 只看填了没，不打印值
 *   node scripts/setup-credentials.js --csv xxx.csv --dry-run    # 预演，不落盘
 *
 * 为什么要有这个脚本：
 *   Secret Access Key 只在创建访问密钥时下载的那份 csv 里出现一次。
 *   手写进 .env 就要把密钥贴进聊天记录或命令行历史，都会留下痕迹。
 *   用脚本读 csv，SK 从头到尾不经过屏幕。
 *
 * 处理完请自行删除 credentials.csv。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const dryRun = args.includes('--dry-run');
const check = args.includes('--check');

/** 在常见的下载目录里找 credentials.csv */
function guessCsv() {
  const dirs = [
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), '下载'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'OneDrive', 'Downloads'),
    path.join(os.homedir(), 'OneDrive', 'Desktop'),
  ];
  const out = [];
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d)) {
        if (/^credentials.*\.csv$/i.test(f)) out.push(path.join(d, f));
      }
    } catch { /* 目录不存在，跳过 */ }
  }
  // 多个就取最新修改的那个
  out.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return out[0] || null;
}

/** 解析华为云的 credentials.csv，返回 { ak, sk } */
function parseCsv(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('csv 是空的');

  const cells = (line) => line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  let headerIdx = -1;
  let header = [];
  for (let i = 0; i < lines.length; i++) {
    const h = cells(lines[i]).map((c) => c.toLowerCase());
    if (h.some((c) => c.includes('access key id')) && h.some((c) => c.includes('secret access key'))) {
      headerIdx = i;
      header = h;
      break;
    }
  }
  if (headerIdx < 0) {
    throw new Error('没找到表头（应包含 "Access Key Id" 与 "Secret Access Key"），确认这是华为云下载的 credentials.csv');
  }

  const akIdx = header.findIndex((c) => c.includes('access key id'));
  const skIdx = header.findIndex((c) => c.includes('secret access key'));

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const row = cells(lines[i]);
    if (row[akIdx] && row[skIdx]) return { ak: row[akIdx], sk: row[skIdx] };
  }
  throw new Error('csv 里没有数据行');
}

/** 把键值对写进 .env：存在就替换，不存在就追加 */
function applyToEnv(pairs) {
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const lines = text.split(/\r?\n/);
  const seen = new Set();

  for (const [key, value] of Object.entries(pairs)) {
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
    seen.add(key);
  }

  const out = lines.join('\n').replace(/\n+$/, '') + '\n';
  if (!dryRun) fs.writeFileSync(ENV_PATH, out, 'utf8');
  return seen;
}

const mask = (v) => (!v ? '(空)' : `${v.slice(0, 4)}…${v.slice(-2)}（共 ${v.length} 位）`);

(async () => {
  if (check) {
    require('dotenv').config({ path: ENV_PATH });
    const rows = [
      ['HW_AK', process.env.HW_AK],
      ['HW_SK', process.env.HW_SK],
      ['HW_PROJECT_ID', process.env.HW_PROJECT_ID],
      ['HW_OBS_BUCKET', process.env.HW_OBS_BUCKET],
      ['HW_REGION', process.env.HW_REGION],
      ['HW_SIS_ENDPOINT', process.env.HW_SIS_ENDPOINT],
      ['HW_OBS_ENDPOINT', process.env.HW_OBS_ENDPOINT],
    ];
    console.log('当前 .env 状态（值已脱敏）：');
    for (const [k, v] of rows) console.log(`  ${v ? '✔' : '✘'} ${k} = ${v ? mask(v) : '(空)'}`);
    const missing = rows.filter(([, v]) => !v).map(([k]) => k);
    console.log(missing.length ? `\n还缺：${missing.join(', ')}` : '\n7 个变量齐全，可以跑 npm run verify:sis 了');
    process.exit(missing.length ? 1 : 0);
  }

  const pairs = {};

  const csvArg = getArg('--csv');
  const projectId = getArg('--project-id');

  if (csvArg || !projectId) {
    const csv = csvArg || guessCsv();
    if (!csv) {
      console.error('没找到 credentials.csv。请从「我的凭证 → 访问密钥」下载后，用 --csv 指定路径：');
      console.error('  node scripts/setup-credentials.js --csv "C:/Users/你/Downloads/credentials.csv"');
      process.exit(1);
    }
    if (!fs.existsSync(csv)) {
      console.error(`文件不存在：${csv}`);
      process.exit(1);
    }
    const { ak, sk } = parseCsv(csv);
    pairs.HW_AK = ak;
    pairs.HW_SK = sk;
    console.log(`读取 ${path.basename(csv)}：AK ${mask(ak)} / SK 已读取（不在屏幕上显示）`);
  }

  if (projectId) {
    const clean = projectId.trim();
    if (!/^[0-9a-f]{32}$/i.test(clean)) {
      console.warn(`⚠️  项目 ID 通常是 32 位十六进制，你给的是 ${clean.length} 位，确认没复制错（不要复制成项目编号或账号 ID）`);
    }
    pairs.HW_PROJECT_ID = clean;
    console.log(`项目 ID：${mask(clean)}`);
  }

  if (!Object.keys(pairs).length) {
    console.log('没有要写入的内容。可用参数：--csv <路径> / --project-id <ID> / --check / --dry-run');
    process.exit(0);
  }

  const written = applyToEnv(pairs);
  console.log(dryRun ? '\n[预演] 未写入。将要更新：' : '\n已写入 .env：');
  console.log(`  ${[...written].join(', ')}`);
  if (!dryRun) {
    console.log('\n下一步：');
    console.log('  1) node scripts/setup-credentials.js --check    # 确认 7 个都填了');
    console.log('  2) npm run verify:sis                          # 跑真实联调（不花钱）');
    console.log('  3) 删除下载目录里的 credentials.csv');
  }
})().catch((e) => {
  console.error('失败：', e && e.message ? e.message : e);
  process.exit(2);
});
