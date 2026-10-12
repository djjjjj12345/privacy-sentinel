/**
 * auth.js — 零依赖账号体系
 * ---------------------------------------------------------------
 * - 密码：crypto.scryptSync（32 字盐 + 32 字哈希），不存明文
 * - 会话：随机 256bit token 存 sessions 表，30 天有效期
 * - Cookie：ps_session=...; HttpOnly; SameSite=Lax（HTTPS 下自动加 Secure）
 *
 * 对外导出：
 *   createUser / verifyLogin / createSession / destroySession
 *   getSessionUser(req) / requireAuth(中间件) / setSessionCookie / clearSessionCookie
 */
'use strict';
const crypto = require('crypto');
const logger = require('./logger');

const db = require('./db');
const SESSION_COOKIE = 'ps_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const USERNAME_RE = /^[\w\u4e00-\u9fa5.-]{2,24}$/; // 字母数字下划线/中文/点/横线，2-24 字符
const MAX_HISTORY_PER_USER = 200;

// ------------------------------------------------------------------
//  密码
// ------------------------------------------------------------------
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 32).toString('hex');
}

function validateCredentials(username, password) {
  if (!username || !USERNAME_RE.test(String(username))) {
    return '用户名需为 2-24 位字母、数字、中文或“.-_”组合';
  }
  if (!password || String(password).length < 6 || String(password).length > 72) {
    return '密码长度需在 6-72 位之间';
  }
  return null;
}

// ------------------------------------------------------------------
//  用户
// ------------------------------------------------------------------
function createUser(username, password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = hashPassword(password, salt);
  try {
    const r = db.prepare('INSERT INTO users (username, pass_hash, pass_salt) VALUES (?, ?, ?)')
      .run(String(username), hash, salt);
    return { id: Number(r.lastInsertRowid), username: String(username) };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return { error: '用户名已被注册' };
    logger.error('[auth] 注册失败:', e.message);
    return { error: '注册失败，请稍后重试' };
  }
}

function verifyLogin(username, password) {
  const row = db.prepare('SELECT id, username, pass_hash, pass_salt FROM users WHERE username = ?')
    .get(String(username || ''));
  if (!row) return null;
  const hash = hashPassword(password, row.pass_salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(row.pass_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: row.id, username: row.username };
}

// ------------------------------------------------------------------
//  会话
// ------------------------------------------------------------------
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_TTL_MS);
  return token;
}

function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  // 顺手清掉全表过期会话（轻量 GC，无需定时器）
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

/** 解析请求里的会话，返回 {id, username} 或 null */
function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, Date.now());
  return row || null;
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ success: false, error: '请先登录' });
  }
  req.user = user;
  next();
}

// ------------------------------------------------------------------
//  Cookie 工具
// ------------------------------------------------------------------
function parseCookies(header) {
  const out = {};
  for (const pair of String(header).split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isSecure(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(res, req, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, parts.join('; ')) : parts.join('; '));
}

function clearSessionCookie(res, req) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

module.exports = {
  SESSION_COOKIE,
  MAX_HISTORY_PER_USER,
  validateCredentials,
  createUser,
  verifyLogin,
  createSession,
  destroySession,
  getSessionUser,
  requireAuth,
  setSessionCookie,
  clearSessionCookie,
};
