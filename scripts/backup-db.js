#!/usr/bin/env node
/**
 * backup-db.js — SQLite 在线备份（零依赖，用 node:sqlite 的 VACUUM INTO）
 * ---------------------------------------------------------------
 * 为什么不用 cp：数据库可能正在写入，直接复制文件会拿到「半截」的库
 * （WAL/journal 未合并），恢复时表现为表损坏或数据倒退。
 * VACUUM INTO 由 SQLite 自己在读事务里生成一致性快照，服务无需停机。
 *
 * 用法：
 *   node scripts/backup-db.js              # 备份到 <DATA_DIR>/backups/
 *   BACKUP_DIR=/mnt/backup node scripts/backup-db.js
 *   KEEP=30 node scripts/backup-db.js      # 保留最近 30 份（默认 14）
 *
 * 退出码：0 成功 / 1 失败 / 2 当前不是 sqlite 驱动（MySQL 请用 mysqldump）
 */
'use strict';

const fs = require('fs');
const path = require('path');

// dotenv 是生产依赖，存在则加载，保证与 server.js 读取同一份配置
try { require('dotenv').config(); } catch (_) { /* 允许在没装依赖的机器上跑 */ }

const DRIVER = (process.env.DB_DRIVER || 'sqlite').toLowerCase();

if (DRIVER !== 'sqlite') {
  console.error(`[backup] 当前 DB_DRIVER=${DRIVER}，本脚本只支持 sqlite。`);
  console.error('[backup] MySQL 请用：mysqldump -h <host> -u <user> -p --single-transaction <db> > backup.sql');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'privacy-sentinel.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const KEEP = Math.max(1, Number(process.env.KEEP || 14));

if (!fs.existsSync(DB_PATH)) {
  console.error(`[backup] 数据库文件不存在：${DB_PATH}`);
  console.error('[backup] 若服务从未启动过，这是正常的——启动一次后会自动建库。');
  process.exit(1);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });

const ts = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace('T', '-')
  .slice(0, 15); // 20261022-094500
const target = path.join(BACKUP_DIR, `privacy-sentinel-${ts}.db`);

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('[backup] 当前 Node 不支持 node:sqlite，需要 Node >= 22.13');
  process.exit(1);
}

try {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  // 路径里的单引号需要转义，否则 SQL 语法错误
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  db.close();

  const size = fs.statSync(target).size;
  console.log(`[backup] 已生成快照：${target}（${(size / 1024).toFixed(1)} KB）`);

  // 清理旧备份：按文件名倒序保留最近 KEEP 份
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^privacy-sentinel-\d{8}-\d{6}\.db$/.test(f))
    .sort()
    .reverse();
  files.slice(KEEP).forEach((f) => {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`[backup] 清理旧备份：${f}`);
  });
  console.log(`[backup] 当前保留 ${Math.min(files.length, KEEP)} 份，上限 ${KEEP}`);
} catch (e) {
  console.error('[backup] 备份失败：', e.message);
  process.exit(1);
}
