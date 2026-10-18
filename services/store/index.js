/**
 * store/index.js — 存储驱动路由
 * ---------------------------------------------------------------
 * DB_DRIVER=sqlite（默认）| mysql
 *   sqlite：本地文件，零依赖，适合本地开发与 Render
 *   mysql ：华为云 RDS，适合比赛演示与多实例部署
 *
 * 两个驱动暴露同一组异步方法，上层（services/auth.js、routes/*）不关心实现。
 */
'use strict';
const logger = require('../logger');

const name = String(process.env.DB_DRIVER || 'sqlite').trim().toLowerCase();

let impl;
if (name === 'mysql') {
  impl = require('./mysql');
} else {
  if (name !== 'sqlite') {
    logger.warn(`[store] 未知的 DB_DRIVER=${name}，已回退到 sqlite`);
  }
  impl = require('./sqlite');
}

module.exports = impl;
