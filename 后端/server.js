require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const detectRoutes = require('./routes/detect');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 静态文件托管（前端）
app.use(express.static('前端'));

// API 路由
app.use('/api/detect', detectRoutes);

// 根路径返回前端页面
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '前端', 'index.html'));
});

// 端口
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`后端服务运行在 http://localhost:${PORT}`);
});