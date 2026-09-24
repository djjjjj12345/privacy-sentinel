require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const analyzeRoutes = require('./routes/analyze');
const detectRoutes = require('./routes/detect');

const app = express();

// Railway / 反向代理后面需要信任代理头，否则限流会把所有请求算成同一个 IP
app.set('trust proxy', 1);

app.use(cors());

// 图片以 base64 传输，需要放宽 body 上限（前端已做压缩，正常远低于此值）
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ------------------------------------------------------------------
//  接口路由
// ------------------------------------------------------------------
app.use('/api/analyze', analyzeRoutes);
app.use('/api', detectRoutes);

// 健康检查：便于确认部署版本与关键环境变量是否就绪
app.get('/api/health', (req, res) => {
  const hasKey = Boolean(process.env.ARK_API_KEY || process.env.VOLC_API_KEY);
  res.json({
    success: true,
    version: require('./package.json').version,
    uptime: Math.round(process.uptime()),
    model: process.env.ARK_VISION_MODEL || 'doubao-seed-2-0-mini-260428',
    arkKeyConfigured: hasKey,
  });
});

// ------------------------------------------------------------------
//  静态前端
// ------------------------------------------------------------------
app.use(express.static('前端'));

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
    return res.status(413).json({ success: false, error: '请求体过大，请压缩图片后重试' });
  }
  console.error('[server] 未处理异常:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: err.message || '服务器内部错误' });
});

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  const hasKey = Boolean(process.env.ARK_API_KEY || process.env.VOLC_API_KEY);
  console.log(`隐私哨兵服务已启动: http://0.0.0.0:${port}`);
  if (!hasKey) {
    console.warn('警告: 未检测到 ARK_API_KEY，AI 识别能力不可用（文本仍可用本地规则引擎）');
  }
});
