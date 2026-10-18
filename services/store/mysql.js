/**
 * store/mysql.js — 华为云 RDS for MySQL 实现
 * ---------------------------------------------------------------
 * 与 sqlite.js 暴露完全相同的异步接口，上层零感知。
 * 连接信息全部来自环境变量（见 .env.example）：
 *   DB_DRIVER=mysql
 *   MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE
 *   MYSQL_SSL=true 时启用 TLS（华为云 RDS 可要求 SSL）
 *
 * 注意：username 列显式使用 utf8mb4_bin，保证与 SQLite 一样大小写敏感，
 * 避免「Alice 和 alice 被当成同一用户」这种迁移后的行为漂移。
 */
'use strict';
const logger = require('../logger');

let pool = null;
let initPromise = null;

function config() {
  const base = {
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL_SIZE || 10),
    queueLimit: 0,
    charset: 'utf8mb4',
    connectTimeout: Number(process.env.MYSQL_CONNECT_TIMEOUT_MS || 10000),
    supportBigNumbers: true,
  };
  if (process.env.MYSQL_URL) return { ...base, uri: process.env.MYSQL_URL };
  if (String(process.env.MYSQL_SSL || '').toLowerCase() === 'true') {
    base.ssl = { rejectUnauthorized: String(process.env.MYSQL_SSL_VERIFY || '').toLowerCase() === 'true' };
  }
  return {
    ...base,
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'privacy_sentinel',
  };
}

function ensurePool() {
  if (pool) return pool;
  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch (e) {
    throw new Error('缺少 mysql2 依赖：请在服务器上执行 npm ci（或 npm i mysql2）');
  }
  const { uri, ...opts } = config();
  pool = uri ? mysql.createPool(uri) : mysql.createPool(opts);
  return pool;
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
     id         BIGINT PRIMARY KEY AUTO_INCREMENT,
     username   VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL UNIQUE,
     pass_hash  VARCHAR(128) NOT NULL,
     pass_salt  VARCHAR(128) NOT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS sessions (
     token      VARCHAR(128) PRIMARY KEY,
     user_id    BIGINT NOT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     expires_at BIGINT NOT NULL,
     INDEX idx_sessions_user (user_id),
     CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS history (
     id         BIGINT PRIMARY KEY AUTO_INCREMENT,
     user_id    BIGINT NOT NULL,
     level      INT NOT NULL DEFAULT 0,
     action     VARCHAR(255) NOT NULL DEFAULT '',
     content    TEXT NOT NULL,
     detections MEDIUMTEXT NOT NULL,
     time       VARCHAR(32) NOT NULL DEFAULT '',
     date       VARCHAR(32) NOT NULL DEFAULT '',
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     INDEX idx_history_user (user_id, id),
     CONSTRAINT fk_history_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const p = ensurePool();
    for (const sql of DDL) {
      await p.query(sql);
    }
    logger.info('[store] RDS MySQL 表结构已就绪');
  })().catch((err) => {
    // 初始化失败要允许下次重试：数据库可能只是短暂不可用
    initPromise = null;
    throw err;
  });
  return initPromise;
}

async function q(sql, params = []) {
  await init();
  const [rows] = await pool.query(sql, params);
  return rows;
}

function num(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

module.exports = {
  driver: 'mysql',
  label: 'MySQL (华为云 RDS)',

  init,

  async ping() {
    await q('SELECT 1 AS ok');
    return true;
  },

  async createUser(username, passHash, passSalt) {
    const r = await q(
      'INSERT INTO users (username, pass_hash, pass_salt) VALUES (?, ?, ?)',
      [username, passHash, passSalt]
    );
    return { id: Number(r.insertId) };
  },

  async findUserByUsername(username) {
    const rows = await q(
      'SELECT id, username, pass_hash, pass_salt FROM users WHERE username = ? LIMIT 1',
      [username]
    );
    return rows[0] || null;
  },

  async findUserById(id) {
    const rows = await q('SELECT id, username FROM users WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  },

  async createSession(token, userId, expiresAt) {
    await q(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
      [token, userId, expiresAt]
    );
  },

  async deleteSession(token) {
    await q('DELETE FROM sessions WHERE token = ?', [token]);
  },

  async deleteExpiredSessions(now) {
    await q('DELETE FROM sessions WHERE expires_at < ?', [now]);
  },

  async findUserBySession(token, now) {
    const rows = await q(
      `SELECT u.id, u.username FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ? LIMIT 1`,
      [token, now]
    );
    return rows[0] || null;
  },

  async listHistory(userId, limit = 50) {
    return q(
      'SELECT * FROM history WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      [userId, num(limit) || 50]
    );
  },

  async addHistory(userId, e) {
    const r = await q(
      `INSERT INTO history (user_id, level, action, content, detections, \`time\`, \`date\`)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, e.level, e.action, e.content, e.detections, e.time, e.date]
    );
    return { id: Number(r.insertId) };
  },

  async addHistoryBatch(userId, entries) {
    await init();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const e of entries) {
        await conn.query(
          `INSERT INTO history (user_id, level, action, content, detections, \`time\`, \`date\`)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [userId, e.level, e.action, e.content, e.detections, e.time, e.date]
        );
      }
      await conn.commit();
      return entries.length;
    } catch (err) {
      try { await conn.rollback(); } catch (e2) { /* 忽略 */ }
      throw err;
    } finally {
      conn.release();
    }
  },

  async clearHistory(userId) {
    await q('DELETE FROM history WHERE user_id = ?', [userId]);
  },

  async trimHistory(userId, max) {
    // MySQL 不允许在 DELETE 的子查询里直接引用同表，这里用派生表绕过 1093
    await q(
      `DELETE FROM history WHERE user_id = ? AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM history WHERE user_id = ? ORDER BY id DESC LIMIT ?
         ) AS keep_rows
       )`,
      [userId, userId, num(max) || 200]
    );
  },

  async close() {
    if (pool) {
      const p = pool;
      pool = null;
      initPromise = null;
      await p.end();
    }
  },
};
