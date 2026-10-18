/**
 * /api/auth — 注册 / 登录 / 登出 / 当前用户
 * ---------------------------------------------------------------
 *   POST /api/auth/register {username, password}  -> 201 {success, user}
 *   POST /api/auth/login    {username, password}  -> 200 {success, user}（Set-Cookie）
 *   POST /api/auth/logout                        -> 200 {success}（清 Cookie）
 *   GET  /api/auth/me                            -> 200 {success, user|null}
 *
 * v3.3：底层可能是 MySQL（异步），所有 handler 统一用 wrap 捕获 Promise 异常。
 */
'use strict';
const express = require('express');
const router = express.Router();

const auth = require('../services/auth');
const logger = require('../services/logger');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post('/register', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const invalid = auth.validateCredentials(username, password);
  if (invalid) return res.status(400).json({ success: false, error: invalid });

  const user = await auth.createUser(username, password);
  if (user.error) return res.status(409).json({ success: false, error: user.error });

  const token = await auth.createSession(user.id);
  auth.setSessionCookie(res, req, token);
  logger.info(`[auth] 新用户注册: ${user.username}`);
  return res.status(201).json({ success: true, user: { username: user.username } });
}));

router.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const user = await auth.verifyLogin(username, password);
  if (!user) return res.status(401).json({ success: false, error: '用户名或密码错误' });

  const token = await auth.createSession(user.id);
  auth.setSessionCookie(res, req, token);
  return res.json({ success: true, user: { username: user.username } });
}));

router.post('/logout', wrap(async (req, res) => {
  const cookies = req.headers.cookie || '';
  const m = /(?:^|;\s*)ps_session=([^;]+)/.exec(cookies);
  if (m) await auth.destroySession(m[1]);
  auth.clearSessionCookie(res, req);
  return res.json({ success: true });
}));

router.get('/me', wrap(async (req, res) => {
  // 未登录也返回 200 + user:null，方便前端开机静默探测
  const user = await auth.getSessionUser(req);
  return res.json({ success: true, user: user ? { username: user.username } : null });
}));

module.exports = router;
