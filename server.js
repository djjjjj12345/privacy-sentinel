require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const analyzeRoutes = require('./routes/analyze');
const detectRoutes = require('./routes/detect');
const authRoutes = require('./routes/auth');
const historyRoutes = require('./routes/history');
const logger = require('./services/logger');
const store = require('./services/store');
const providers = require('./services/providers');
const redis = require('./services/redis');
const { securityHeaders, htmlNonce } = require('./services/securityHeaders');
const errors = require('./services/errors');

const app = express();

// Railway / 反向代理后面需要信任代理头，否则限流会把所有请求算成同一个 IP
app.set('trust proxy', 1);

// 安全响应头挂载在最前面，保证 404 / 500 / 静态资源等所有响应都带上
app.use(securityHeaders);

app.use(cors());

// 图片 base64 上限 14MB、音视频 base64 上限 30MB（见 services/visionAnalyzer.js）。
// body 上限必须 ≥ 通道上限 + JSON 包装开销，否则大视频会被 Express 以 413 拒掉
// （且返回 HTML 错误页，前端只能看到"服务返回异常"）。
app.use(express.json({ limit: '45mb' }));
app.use(express.urlencoded({ extended: true, limit: '45mb' }));

// ------------------------------------------------------------------
//  接口路由
// ------------------------------------------------------------------
app.use('/api/analyze', analyzeRoutes);
app.use('/api', detectRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/history', historyRoutes);

/**
 * 健康检查：便于确认部署版本、模型供应商、存储与缓存是否就绪。
 * 额外带上 capabilities 与 privacy，让「服务状态页」不必硬编码这些信息。
 */
app.get('/api/health', async (req, res) => {
  const hasKey = Boolean(process.env.ARK_API_KEY || process.env.VOLC_API_KEY);
  let dbStatus = 'ok';
  try {
    // 轻量探活：SQLite 查一条，MySQL 走 SELECT 1
    await store.ping();
  } catch (e) {
    dbStatus = 'error: ' + e.message;
  }
  const ai = providers.info();
  res.json({
    success: true,
    version: require('./package.json').version,
    uptime: Math.round(process.uptime()),
    // 冷启动判断依据：刚启动不久的实例，前端可据此提示「正在唤醒」
    booting: process.uptime() < 20,
    model: process.env.ARK_VISION_MODEL || 'doubao-seed-2-0-mini-260428',
    arkKeyConfigured: hasKey,
    aiProvider: ai.provider,
    aiProviderLabel: ai.label,
    aiProviderConfigured: ai.configured,
    aiFallback: ai.fallback,
    db: dbStatus,
    dbDriver: store.driver,
    redis: redis.status(),
    rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE || 30),
    capabilities: ai.capabilities || {},
  });
});

// 隐私承诺：前端弹窗与状态页共用同一份文案，避免两处说法不一致
app.get('/api/privacy', (req, res) => {
  res.json({
    success: true,
    version: require('./package.json').version,
    points: [
      '纯文本检测默认在浏览器本地完成（本地模式），原文不上传服务器，也不经过任何第三方。',
      '你提交的文本、图片、音频、视频仅用于当次检测，检测完成后不在服务端保留原始内容。',
      '除完成本次检测所必需的识别服务外，不向任何第三方转发、出售或用于模型训练。',
      '检测结果中的敏感字段默认以脱敏形式展示（如 110105********1234），完整原文不回传页面。',
      '音频检测中转所需的临时对象，在转写完成后立即从对象存储删除。',
      '登录仅用于同步你自己的预警历史，密码以 scrypt 哈希存储，不保存明文。',
      '全站启用 HTTPS 与安全响应头（CSP / HSTS / X-Content-Type-Options），不投放第三方追踪脚本。',
    ],
    note: '本工具为本地可部署的开源项目，自建实例时以上承诺由你的部署配置决定。',
  });
});

// ------------------------------------------------------------------
//  静态前端
// ------------------------------------------------------------------
// 用绝对路径，避免部署环境工作目录不同导致静态资源 404
const FRONTEND_DIR = path.join(__dirname, '前端');

// HTML 请求先经 nonce 注入（CSP 生效的前提），其余静态资源直接交给 static
app.use(htmlNonce(FRONTEND_DIR));

// 本地离线检测模式要把引擎下发到浏览器。只白名单这两个文件，
// 不做目录级静态挂载——services/ 里还有密钥、数据库等绝不能外泄的模块。
const ENGINE_FILES = {
  'schema.js': path.join(__dirname, 'services', 'schema.js'),
  'localDetector.js': path.join(__dirname, 'services', 'localDetector.js'),
};
app.get('/engine/:file', (req, res, next) => {
  const target = ENGINE_FILES[req.params.file];
  if (!target) return next();
  res.type('application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.sendFile(target);
});

app.use(express.static(FRONTEND_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// 未命中的 API 路由返回 JSON，避免前端拿到一坨 HTML 导致解析报错
app.use('/api', (req, res) => {
  const p = errors.payload('not_found', `接口不存在：${req.method} ${req.originalUrl}`);
  res.status(404).json(p);
});

// ------------------------------------------------------------------
//  兜底错误处理
// ------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json(errors.payload('payload_too_large'));
  }
  logger.error('[server] 未处理异常:', err);
  if (res.headersSent) return next(err);
  // 统一错误目录：内部异常也只暴露分类文案，原始堆栈留在日志里
  const p = errors.payload(err);
  res.status(500).json(p);
});

const port = process.env.PORT || 8080;

async function start() {
  try {
    await store.init();
  } catch (e) {
    // 存储起不来时必须显式报错：静默降级会让「历史丢失」变成玄学问题
    logger.error('[server] 存储初始化失败:', e.message);
  }

  app.listen(port, '0.0.0.0', () => {
    const hasKey = Boolean(process.env.ARK_API_KEY || process.env.VOLC_API_KEY);
    const ai = providers.info();
    logger.info(`隐私哨兵服务已启动: http://0.0.0.0:${port}`);
    logger.info(`模型通道: ${ai.label} (${ai.provider}) · 存储: ${store.label} · Redis: ${redis.status()}`);
    if (!ai.configured) {
      logger.warn(`警告: ${ai.provider} 通道未配置 Key，AI 识别能力不可用（文本仍可用本地规则引擎）`);
    }
    if (ai.provider === 'ark' && !hasKey) {
      logger.warn('警告: 未检测到 ARK_API_KEY，AI 识别能力不可用（文本仍可用本地规则引擎）');
    }
  });
}

start();
