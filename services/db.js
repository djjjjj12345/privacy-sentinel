/**
 * db.js — SQLite 持久化层（零依赖，Node 22.13+ 内置 node:sqlite）
 * ---------------------------------------------------------------
 * 三张表：
 *   users    — 账号（scrypt 哈希存储，绝不存明文密码）
 *   sessions — 登录会话（随机 token + 30 天有效期）
 *   history  — 每用户的预警历史（云端同步，最多 200 条/人）
 *
 * 注意：Render 免费档磁盘是临时的，重新部署会重置数据。
 * 因此前端提供了 JSON 导出/导入备份（历史面板 ⬇️/⬆️ 按钮）。
 * 如需永久持久化，可为 Render 挂载磁盘或将 SQLITE_PATH 指向外部卷。
 *
 * 环境变量：
 *   SQLITE_PATH — 自定义数据库文件路径（测试时指向临时目录）
 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'privacy-sentinel.db');

// :memory: 之外的路径需要先确保目录存在
if (DB_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT UNIQUE NOT NULL,
  pass_hash  TEXT NOT NULL,
  pass_salt  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level      INTEGER NOT NULL DEFAULT 0,
  action     TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  detections TEXT NOT NULL DEFAULT '[]',
  time       TEXT NOT NULL DEFAULT '',
  date       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

module.exports = db;
