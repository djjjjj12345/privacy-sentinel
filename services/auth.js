/**
 * auth.js — 账号与会话
 * ---------------------------------------------------------------
 * - 密码：crypto.scryptSync（32 字节盐 + 32 字节哈希），不存明文
 * - 会话：随机 256bit token 存 sessions 表（SQLite 或 RDS MySQL），30 天有效期
 * - 缓存：配置了 REDIS_URL 时，会话在 DCS 里做一层缓存（DB 仍是权威数据源）
 * - Cookie：ps_session=...; HttpOnly; SameSite=Lax（HTTPS 下自动加 Secure）
 *
 * v3.3 起所有函数改为 async：为了同时支持同步的 SQLite 与异步的 MySQL。
 * 调用方（routes）必须 await。
 *
 * 对外导出：
 *   createUser / verifyLogin / createSession / destroySession
 *   getSessionUser / requireAuth / setSessionCookie / clearSessionCookie
 */
'use strict';
const crypto = require('crypto');
const logger = require('./logger');
const store = require('./store');
const redis = require('./redis');

const SESSION_COOKIE = 'ps_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const SESSION_CACHE_TTL_S = 24 * 60 * 60;        // Redis 缓存 1 天（DB 仍可校验）
const USERNAME_RE = /^[\w\u4e00-\u9fa5.-]{2,24}$/;
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

function isDuplicate(e) {
  return Boolean(e) && (
    e.code === 'ER_DUP_ENTRY' ||
    /UNIQUE constraint failed|Duplicate entry/i.test(String(e.message || ''))
  );
}

// ------------------------------------------------------------------
//  会话缓存（Redis 可选）
// ------------------------------------------------------------------
async function cacheSession(token, user) {
  const client = await redis.getReadyClient();
  if (!client) return;
  try {
    await client.set(
      `ps:sess:${token}`,
      JSON.stringify(user),
      'EX', SESSION_CACHE_TTL_S
    );
  } catch (e) { /* 缓存失败不影响登录 */ }
}

async function readCachedSession(token) {
  const client = await redis.getReadyClient();
  if (!client) return null;
  try {
    const raw = await client.get(`ps:sess:${token}`);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

async function dropCachedSession(token) {
  const client = await redis.getReadyClient();
  if (!client) return;
  try { await client.del(`ps:sess:${token}`); } catch (e) { /* 忽略 */ }
}

// ------------------------------------------------------------------
//  用户
// ------------------------------------------------------------------
async function createUser(username, password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = hashPassword(password, salt);
  try {
    const r = await store.createUser(String(username), hash, salt);
    return { id: r.id, username: String(username) };
  } catch (e) {
    if (isDuplicate(e)) return { error: '用户名已被注册' };
    logger.error('[auth] 注册失败:', e.message);
    return { error: '注册失败，请稍后重试' };
  }
}

async function verifyLogin(username, password) {
  const row = await store.findUserByUsername(String(username || ''));
  if (!row) return null;
  const hash = hashPassword(password, row.pass_salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(row.pass_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: Number(row.id), username: row.username };
}

// ------------------------------------------------------------------
//  会话
// ------------------------------------------------------------------
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await store.createSession(token, userId, Date.now() + SESSION_TTL_MS);
  await cacheSession(token, { id: Number(userId) });
  return token;
}

async function destroySession(token) {
  if (!token) return;
  await store.deleteSession(token);
  await dropCachedSession(token);
  // 顺手清掉全表过期会话（轻量 GC，无需定时器）
  try { await store.deleteExpiredSessions(Date.now()); } catch (e) { /* 忽略 */ }
}

/** 解析请求里的会话，返回 {id, username} 或 null */
async function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const cached = await readCachedSession(token);
  if (cached && cached.id) {
    // 缓存里可能只有 id，补一次用户名（命中率足够高，成本可接受）
    if (cached.username) return cached;
    const u = await store.findUserById(cached.id);
    if (u) {
      await cacheSession(token, { id: Number(u.id), username: u.username });
      return { id: Number(u.id), username: u.username };
    }
    await dropCachedSession(token);
    return null;
  }

  const row = await store.findUserBySession(token, Date.now());
  if (row) await cacheSession(token, { id: Number(row.id), username: row.username });
  return row ? { id: Number(row.id), username: row.username } : null;
}

async function requireAuth(req, res, next) {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      return res.status(401).json({ success: false, error: '请先登录' });
    }
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
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
