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

const app = express();

// Railway / 反向代理后面需要信任代理头，否则限流会把所有请求算成同一个 IP
app.set('trust proxy', 1);

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

// 健康检查：便于确认部署版本、模型供应商与存储驱动是否就绪
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
    model: process.env.ARK_VISION_MODEL || 'doubao-seed-2-0-mini-260428',
    arkKeyConfigured: hasKey,
    aiProvider: ai.provider,
    aiProviderLabel: ai.label,
    aiProviderConfigured: ai.configured,
    aiFallback: ai.fallback,
    db: dbStatus,
    dbDriver: store.driver,
    redis: redis.status(),
  });
});

// ------------------------------------------------------------------
//  静态前端
// ------------------------------------------------------------------
// 用绝对路径，避免部署环境工作目录不同导致静态资源 404
app.use(express.static(path.join(__dirname, '前端')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '前端', 'index.html'));
});

// 未命中的 API 路由返回 JSON，避免前端拿到一坨 HTML 导致解析报错
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `接口不存在：${req.method} ${req.originalUrl}` });
});

// ------------------------------------------------------------------
//  兜底错误处理
// ------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: '请求体过大：请压缩图片，或剪短音视频（建议 1 分钟以内）后重试' });
  }
  logger.error('[server] 未处理异常:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: err.message || '服务器内部错误' });
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
