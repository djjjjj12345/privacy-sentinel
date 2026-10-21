/**
 * rateLimiter.js — 限流器（Redis 优先，内存兜底）
 * ---------------------------------------------------------------
 * 为什么需要 Redis 版：单机内存计数在多实例部署下会各算各的，
 * 等于把 30 次/分钟放大成 30×N。赛题要求「关联 RDS、Redis」，
 * 这就是 Redis 最自然的落点——共享计数。
 *
 * 降级策略：Redis 不可用时自动退回进程内 Map，行为与旧版一致，
 * 限流器自身异常也绝不阻断业务请求（宁可少限流，不可误杀）。
 */
'use strict';
const { getReadyClient } = require('./redis');

function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip || 'unknown';
}

function createRateLimiter({ limit, windowMs = 60 * 1000, prefix = 'ps:rl' }) {
  const hits = new Map();

  const cleaner = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of hits) {
      if (now > record.resetAt) hits.delete(key);
    }
  }, windowMs);
  if (cleaner.unref) cleaner.unref();

  return async function rateLimit(req, res, next) {
    if (!limit || limit <= 0) return next();

    const key = clientKey(req);
    const now = Date.now();
    let count = 0;
    let resetAt = now + windowMs;

    try {
      const redis = await getReadyClient();
      if (redis) {
        const rk = `${prefix}:${key}`;
        count = await redis.incr(rk);
        if (count === 1) await redis.pexpire(rk, windowMs);
        let ttl = await redis.pttl(rk);
        if (ttl < 0) {
          await redis.pexpire(rk, windowMs);
          ttl = windowMs;
        }
        resetAt = now + ttl;
      }
    } catch (e) {
      count = 0; // 交给内存兜底
    }

    if (!count) {
      const record = hits.get(key) || { count: 0, resetAt: now + windowMs };
      if (now > record.resetAt) {
        record.count = 0;
        record.resetAt = now + windowMs;
      }
      record.count += 1;
      hits.set(key, record);
      count = record.count;
      resetAt = record.resetAt;
    }

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - count)));
    res.setHeader('X-RateLimit-Reset', String(Math.max(0, Math.ceil((resetAt - now) / 1000))));

    if (count > limit) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      // 复用统一错误目录，保证前端文案与后端一致
      const errors = require('./errors');
      const p = errors.payload('rate_limited');
      return res.status(429).json(Object.assign({}, p, { retryAfter }));
    }
    next();
  };
}

module.exports = { createRateLimiter, clientKey };
