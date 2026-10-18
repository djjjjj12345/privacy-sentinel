/**
 * redis.js — 华为云 DCS（Redis）连接管理
 * ---------------------------------------------------------------
 * 设计原则：Redis 是「加速层」，不是「必需层」。
 *   - 未配置 REDIS_URL：直接返回 null，全部走内存/数据库
 *   - 配置了但连不上：记录一次告警后降级，不阻塞任何请求
 *   - 重试 3 次仍失败就停止重连，避免刷屏和拖慢启动
 *
 * 懒加载 ioredis：没装依赖、没配 Redis 的部署（如 Render）完全不受影响。
 */
'use strict';
const logger = require('./logger');

let client = null;
let connectPromise = null;
let errorLogged = false;
let disabled = false;

function isEnabled() {
  return Boolean(process.env.REDIS_URL) && !disabled;
}

function getClient() {
  if (!isEnabled()) return null;
  if (client) return client;

  let Redis;
  try {
    Redis = require('ioredis');
  } catch (e) {
    disabled = true;
    logger.warn('[redis] 未安装 ioredis，已降级为内存模式（npm i ioredis 可启用）');
    return null;
  }

  client = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 3000),
    // 首次失败后最多重试 3 次，之后放弃（避免无限重连刷日志）
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 300, 1200)),
  });

  client.on('ready', () => logger.info('[redis] DCS 连接就绪'));
  client.on('error', (err) => {
    if (!errorLogged) {
      errorLogged = true;
      logger.warn('[redis] 连接异常，已降级：' + (err && err.message));
    }
  });

  return client;
}

/** 返回状态为 ready 的客户端；连不上则返回 null（调用方自行降级） */
async function getReadyClient() {
  const c = getClient();
  if (!c) return null;
  if (c.status === 'ready') return c;

  if (!connectPromise) {
    connectPromise = c.connect().catch(() => null).finally(() => { connectPromise = null; });
  }
  try {
    await connectPromise;
  } catch (e) {
    return null;
  }
  return c.status === 'ready' ? c : null;
}

function status() {
  if (!process.env.REDIS_URL) return 'disabled';
  if (disabled) return 'unavailable';
  return client ? client.status : 'idle';
}

async function close() {
  if (client) {
    const c = client;
    client = null;
    connectPromise = null;
    try { await c.quit(); } catch (e) { try { c.disconnect(); } catch (e2) { /* 忽略 */ } }
  }
}

module.exports = { isEnabled, getClient, getReadyClient, status, close };
