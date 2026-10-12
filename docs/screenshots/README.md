# 演示截图

启动本地服务后，运行：

```bash
node scripts/capture-screenshots.js
# 依赖：npm i -D puppeteer（首次会下载 ~150MB Chromium）
```

脚本会截取 5 个场景：

| 文件 | 场景 | 何时拍 |
|---|---|---|
| `01-home.png` | 主页初始状态 | 加载后立即 |
| `02-text-detect.png` | 文本检测 — 检出身份证 | 输入"我的身份证是 110105199003071239" |
| `03-image-mask.png` | 图片检测 — 人脸模糊 | 上传含人脸的图片 |
| `04-audio-transcript.png` | 音频识别 — 转写文本高亮 | 上传音频 |
| `05-l4-block.png` | L4 强制阻断弹窗 | 输入验证码 |

## 手工截图

如果不想装 Puppeteer，手工操作：

1. `npm start` 启动服务
2. 浏览器打开 http://localhost:8080
3. 依次触发上面 5 个场景，Win+Shift+S 截图
4. 存为 `01-home.png` ... `05-l4-block.png`
