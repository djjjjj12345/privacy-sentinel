/**
 * store/sqlite.js — 本地 SQLite 实现（默认驱动，零依赖）
 * ---------------------------------------------------------------
 * 直接把原来的同步 SQL 封装成 Promise 接口，让上层（auth/routes）
 * 不必关心底层是 SQLite 还是 MySQL。
 */
'use strict';
const db = require('../db');

function num(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

module.exports = {
  driver: 'sqlite',
  label: 'SQLite (本地文件)',

  async init() {
    // db.js 在 require 时已建表，这里只需探活
    db.prepare('SELECT 1 AS ok').get();
  },

  async ping() {
    db.prepare('SELECT 1 AS ok').get();
    return true;
  },

  async createUser(username, passHash, passSalt) {
    const r = db.prepare('INSERT INTO users (username, pass_hash, pass_salt) VALUES (?, ?, ?)')
      .run(username, passHash, passSalt);
    return { id: Number(r.lastInsertRowid) };
  },

  async findUserByUsername(username) {
    return db.prepare('SELECT id, username, pass_hash, pass_salt FROM users WHERE username = ?')
      .get(username) || null;
  },

  async findUserById(id) {
    return db.prepare('SELECT id, username FROM users WHERE id = ?').get(id) || null;
  },

  async createSession(token, userId, expiresAt) {
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
      .run(token, userId, expiresAt);
  },

  async deleteSession(token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  },

  async deleteExpiredSessions(now) {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  },

  async findUserBySession(token, now) {
    return db.prepare(`
      SELECT u.id, u.username FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?
    `).get(token, now) || null;
  },

  async listHistory(userId, limit = 50) {
    return db.prepare('SELECT * FROM history WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, num(limit) || 50);
  },

  async addHistory(userId, e) {
    const r = db.prepare(`
      INSERT INTO history (user_id, level, action, content, detections, time, date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, e.level, e.action, e.content, e.detections, e.time, e.date);
    return { id: Number(r.lastInsertRowid) };
  },

  async addHistoryBatch(userId, entries) {
    const stmt = db.prepare(`
      INSERT INTO history (user_id, level, action, content, detections, time, date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let count = 0;
    for (const e of entries) {
      stmt.run(userId, e.level, e.action, e.content, e.detections, e.time, e.date);
      count++;
    }
    return count;
  },

  async clearHistory(userId) {
    db.prepare('DELETE FROM history WHERE user_id = ?').run(userId);
  },

  async trimHistory(userId, max) {
    db.prepare(`
      DELETE FROM history WHERE user_id = ? AND id NOT IN (
        SELECT id FROM history WHERE user_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(userId, userId, num(max) || 200);
  },

  async close() {
    // 由进程退出统一回收，不主动 close，避免测试里重复 require 出错
  },
};
