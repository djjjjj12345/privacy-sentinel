/**
 * /api/history — 预警历史云端同步（需登录）
 * ---------------------------------------------------------------
 *   GET    /api/history          -> {success, items:[...]}（最新 50 条）
 *   POST   /api/history          -> 追加 1 条（每人上限 200 条，超出自动裁剪）
 *   POST   /api/history/import   -> 批量导入备份（上限 500 条）
 *   DELETE /api/history          -> 清空当前用户历史
 *
 * 条目结构（与前端 localStorage 历史完全一致）：
 *   { level, action, content, detections:[{label, value}], time, date }
 *
 * v3.3：存储层改为异步仓储（SQLite / 华为云 RDS MySQL 可切换）。
 */
'use strict';
const express = require('express');
const router = express.Router();

const auth = require('../services/auth');
const logger = require('../services/logger');
const store = require('../services/store');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(auth.requireAuth);

// 入库前统一清洗：防止超长内容/异常结构把库撑爆
function sanitizeEntry(e) {
  const arr = Array.isArray(e && e.detections) ? e.detections : [];
  return {
    level: Math.max(0, Math.min(4, parseInt(e && e.level, 10) || 0)),
    action: String((e && e.action) || '').slice(0, 100),
    content: String((e && e.content) || '').slice(0, 300),
    detections: JSON.stringify(arr.slice(0, 20).map((d) => ({
      label: String((d && d.label) || '').slice(0, 50),
      value: String((d && d.value) || '').slice(0, 100),
    }))),
    time: String((e && e.time) || '').slice(0, 20),
    date: String((e && e.date) || '').slice(0, 20),
  };
}

function rowToItem(row) {
  let detections = [];
  try { detections = JSON.parse(row.detections); } catch (e) { /* 兼容脏数据 */ }
  return {
    id: Number(row.id),
    level: row.level,
    action: row.action,
    content: row.content,
    detections,
    time: row.time,
    date: row.date,
  };
}

router.get('/', wrap(async (req, res) => {
  const rows = await store.listHistory(req.user.id, 50);
  return res.json({ success: true, items: rows.map(rowToItem) });
}));

router.post('/', wrap(async (req, res) => {
  const e = sanitizeEntry(req.body || {});
  const r = await store.addHistory(req.user.id, e);
  await store.trimHistory(req.user.id, auth.MAX_HISTORY_PER_USER);
  return res.status(201).json({ success: true, id: Number(r.id) });
}));

router.post('/import', wrap(async (req, res) => {
  const entries = Array.isArray(req.body && req.body.entries) ? req.body.entries : [];
  if (!entries.length) return res.status(400).json({ success: false, error: '没有可导入的条目' });
  if (entries.length > 500) return res.status(400).json({ success: false, error: '单次导入上限 500 条' });

  const prepared = entries.slice(0, 500).map(sanitizeEntry);
  const count = await store.addHistoryBatch(req.user.id, prepared);
  await store.trimHistory(req.user.id, auth.MAX_HISTORY_PER_USER);
  logger.info(`[history] 用户 ${req.user.username} 导入 ${count} 条备份`);
  return res.json({ success: true, imported: count });
}));

router.delete('/', wrap(async (req, res) => {
  await store.clearHistory(req.user.id);
  return res.json({ success: true });
}));

module.exports = router;
