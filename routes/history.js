/**
 * /api/history — 预警历史云端同步（需登录）
 * ---------------------------------------------------------------
 *   GET    /api/history          -> {success, items:[...]}（最新 50 条）
 *   POST   /api/history          -> 追加 1 条（每人上限 200 条，超出自动裁剪）
 *   POST   /api/history/import   -> 批量导入备份（上限 200 条）
 *   DELETE /api/history          -> 清空当前用户历史
 *
 * 条目结构（与前端 localStorage 历史完全一致）：
 *   { level, action, content, detections:[{label, value}], time, date }
 */
'use strict';
const express = require('express');
const router = express.Router();

const auth = require('../services/auth');
const logger = require('../services/logger');
const db = require('../services/db');

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
    id: row.id,
    level: row.level,
    action: row.action,
    content: row.content,
    detections,
    time: row.time,
    date: row.date,
  };
}

function trimHistory(userId, max) {
  // 只保留最新 max 条
  db.prepare(`
    DELETE FROM history WHERE user_id = ? AND id NOT IN (
      SELECT id FROM history WHERE user_id = ? ORDER BY id DESC LIMIT ?
    )
  `).run(userId, userId, max);
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM history WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .all(req.user.id);
  return res.json({ success: true, items: rows.map(rowToItem) });
});

router.post('/', (req, res) => {
  const e = sanitizeEntry(req.body || {});
  const r = db.prepare(`
    INSERT INTO history (user_id, level, action, content, detections, time, date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, e.level, e.action, e.content, e.detections, e.time, e.date);
  trimHistory(req.user.id, auth.MAX_HISTORY_PER_USER);
  return res.status(201).json({ success: true, id: Number(r.lastInsertRowid) });
});

router.post('/import', (req, res) => {
  const entries = Array.isArray(req.body && req.body.entries) ? req.body.entries : [];
  if (!entries.length) return res.status(400).json({ success: false, error: '没有可导入的条目' });
  if (entries.length > 500) return res.status(400).json({ success: false, error: '单次导入上限 500 条' });

  const stmt = db.prepare(`
    INSERT INTO history (user_id, level, action, content, detections, time, date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  for (const raw of entries.slice(0, 500)) {
    const e = sanitizeEntry(raw);
    stmt.run(req.user.id, e.level, e.action, e.content, e.detections, e.time, e.date);
    count++;
  }
  trimHistory(req.user.id, auth.MAX_HISTORY_PER_USER);
  logger.info(`[history] 用户 ${req.user.username} 导入 ${count} 条备份`);
  return res.json({ success: true, imported: count });
});

router.delete('/', (req, res) => {
  db.prepare('DELETE FROM history WHERE user_id = ?').run(req.user.id);
  return res.json({ success: true });
});

module.exports = router;
