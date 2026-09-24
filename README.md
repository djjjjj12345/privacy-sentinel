# 隐私哨兵 · Privacy Sentinel

面向即时通讯场景的**敏感信息检测与预警**工具。在消息发出去之前判断其中是否包含身份证号、银行卡号、手机号、密码、验证码、住址、姓名等敏感信息，并按风险等级给出拦截、脱敏与建议。

## 现在的检测能力

| 输入通道 | 引擎 | 状态 |
|---|---|---|
| 文本消息 | 本地正则 + 大模型语义复检 | ✅ 可用 |
| 图片（上传 / 链接） | 多模态大模型识别，支持在图上框出敏感区域 | ✅ 可用 |
| 音频（mp3 / wav / aac / m4a，≤25MB） | 多模态大模型：先转写再识别 | ✅ 可用 |
| 视频（mp4，≤25MB） | 多模态大模型：先转写再识别 | ✅ 可用 |

### 双引擎设计

单靠正则只能抓固定格式，单靠模型会有幻觉且 raw 值可能抄错。两者互补：

- **本地正则引擎**（`services/localDetector.js`）：确定性兜底。身份证走 GB11643 校验位、银行卡走 Luhn 校验，只在中间 8 位是真实日期时才认作身份证，能把订单号、时间戳、流水号这类噪声挡掉。命中结果保证逐字符与原文一致。
- **多模态模型**（`services/visionAnalyzer.js`）：负责语义层，例如真实姓名、"把验证码发我"这类没有固定格式的诈骗话术、以及图片里的文字。
- **融合层**（`services/analyzer.js`）：按内容去重、取风险等级较高者、补回模型漏检、保留模型独有发现。

### 校验位分级

真实身份证和银行卡必然通过校验位，通不过的几乎都是随机长数字。但为了不误伤测试数据与录入错误，本项目的策略是**分级**而非直接丢弃：

- `verified: true` —— 校验通过，可信度 1.0
- `verified: false` —— 格式符合但校验位不符，仍上报，可信度 0.6，界面上标「存疑」

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
#    编辑 .env，至少填入 ARK_API_KEY

# 3. 启动
npm start
#    浏览器打开 http://localhost:8080
```

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ARK_API_KEY` | 是 | 火山方舟 API Key，[控制台获取](https://console.volcengine.com/ark) |
| `ARK_VISION_MODEL` | 否 | 视觉理解模型 ID，默认 `doubao-seed-2-0-mini-260428` |
| `ARK_TEXT_MODEL` | 否 | 文本模型 ID，留空则复用视觉模型 |
| `ARK_BASE_URL` | 否 | 默认 `https://ark.cn-beijing.volces.com/api/v3` |
| `PORT` | 否 | 默认 `8080`，Railway 会自动注入 |
| `RATE_LIMIT_PER_MINUTE` | 否 | 每 IP 每分钟请求上限，默认 `30`，填 `0` 关闭 |

> 旧变量名 `VOLC_API_KEY` 仍然兼容。

### 自检

```bash
npm run check
```

不需要真实 API Key，也不消耗额度：脚本会起一个假的模型服务，验证接口契约、双引擎融合、校验位分级、中文类型别名映射、bbox 归一化、等级下限、上游异常降级、参数校验、音视频通道、旧接口兼容共 60 项断言。

## 检测素材的格式建议

| 通道 | 浏览器拿到的 mime | 后端是否支持 |
|---|---|---|
| image | `image/jpeg`、`image/png`、`image/webp`、`image/gif` | ✅ |
| audio | `audio/mpeg`/`mp3`、`audio/wav`、`audio/aac`、`audio/mp4`(m4a)、`audio/x-m4a` | ✅ |
| audio | `audio/webm`（Chrome 录屏默认）、`audio/ogg` | ❌ 直接拒（提示转码） |
| video | `video/mp4` | ✅ |
| video | `video/webm`（Chrome 录屏默认）、`video/quicktime` | ❌ 直接拒（提示用「格式工厂」/FFmpeg 转码） |

> 上传文件大小上限 25MB（火山方舟对音频/视频原文的限制）。

## 使用步骤（演示流程）

1. 启动后打开 `http://localhost:8080`
2. 输入框里直接打字测文本：`我的身份证是110105199003071239`，会触发 L2 弹窗
3. 点 📎 → 图片 → 选一张含证件号/卡号的图，会自动调用多模态模型、缩略图上画红框
4. 点 📎 → 音频 → 选一段 `.mp3 / .wav / .m4a`，模型会先转写再识别敏感条目，转写文本会显示在结果卡
5. 点 📎 → 视频 → 选一段 `.mp4`，同上
6. 任何时候点设置 ⚙️ 调灵敏度与等级下限，会立即影响后续识别

## 接口

### `POST /api/analyze`

统一分析入口。前端不需要关心背后调用了几个引擎。

请求：

```json
{
  "kind": "image",
  "dataUrl": "data:image/jpeg;base64,...",
  "fileName": "idcard.jpg",
  "profile": { "age": "30-45", "literacy": "mid", "sensitivity": "mid" }
}
```

`kind` 取值：`image` / `text` / `audio` / `video`。
文本用 `text` 字段替代 `dataUrl`；传 `"mode": "local"` 可只跑本地正则、零延迟、不调模型。

响应：

```json
{
  "success": true,
  "kind": "image",
  "source": "hybrid",
  "engine": { "local": 2, "ai": 3 },
  "hasSensitive": true,
  "maxLevel": 4,
  "levelName": "L4 · 极高风险",
  "summary": "检测到身份证号 1 处、短信验证码 1 处",
  "items": [
    {
      "type": "id",
      "label": "身份证号",
      "raw": "110105199003071239",
      "masked": "110105********1239",
      "level": 4,
      "confidence": 1,
      "verified": true,
      "reason": "对方索要身份证号，且同时索要验证码",
      "bbox": [0.1, 0.2, 0.3, 0.08],
      "engine": "local"
    }
  ],
  "advice": "建议先电话核实对方身份，验证码绝不能发送。",
  "warnings": [],
  "meta": { "model": "doubao-seed-2-0-mini-260428", "elapsedMs": 1832 }
}
```

字段说明：

- `source` —— `local` 纯本地 / `ai` 纯模型 / `hybrid` 两者融合
- `verified` —— `true` 校验位通过 / `false` 校验位不符 / `null` 无校验依据
- `bbox` —— 归一化坐标 `[x, y, width, height]`，取值 0~1，仅图片且模型能定位时给出，否则 `null`

### 其余接口

- `GET /api/analyze/schema` —— 返回类型枚举、等级下限与各通道状态，前端可动态同步契约
- `GET /api/health` —— 健康检查，含版本与 Key 配置状态
- `POST /api/detect` —— 第一版老接口，保留兼容，内部复用同一引擎

## 风险等级

| 等级 | 含义 | 处置 |
|---|---|---|
| L1 | 低 | 提示并自动脱敏后放行 |
| L2 | 中 | 弹窗确认，可选择取消或脱敏发送 |
| L3 | 高 | 弹窗 + 8 秒倒计时，倒计时结束才能继续发送 |
| L4 | 极高 | 强制阻断，不提供继续发送入口 |

各类型的等级下限定义在 `services/schema.js` 的 `TYPE_FLOOR`，模型可结合上下文上调（例如对方明显在实施诈骗时加一级），但不会低于下限。

## 目录结构

```
├── server.js                  Express 入口：静态托管 + 路由挂载
├── routes/
│   ├── analyze.js             统一分析接口 /api/analyze（含限流）
│   └── detect.js              旧接口 /api/detect（兼容）
├── services/
│   ├── schema.js              数据契约：类型、等级、脱敏、融合、提示词
│   ├── localDetector.js       本地正则引擎（含校验位验证）
│   ├── visionAnalyzer.js     模型调用 + 三层 JSON 解析防守
│   └── analyzer.js            编排：双引擎融合 + 降级策略
├── scripts/check.js           离线自检（45 项断言）
└── 前端/index.html            单文件前端（聊天式界面）
```

## 已知问题

- **`后端/` 目录是早期副本**，含重复的 `index.html` 与 `services/`（tesseract.js、@google-cloud/speech、fluent-ffmpeg），这些依赖从未被任何路由引用，属于死代码。且其方案本身不可用：Google Speech 需要 GCP 服务账号凭证且只接受 LINEAR16/16kHz 裸 WAV，`videoAnalyzer.js` 写死 `/tmp/`。建议整体移除。
- 浏览器自带的录像通常输出 `video/webm`，而豆包只支持 `video/mp4`，请先用「格式工厂」或 FFmpeg 转码。

## 安全提醒

- API Key 只放在 `.env` 或部署平台的环境变量里，`.gitignore` 已排除 `.env`。
- 早期版本的 `.env.example` 曾经包含真实 Key 并推送到了公开仓库，请在控制台吊销后重新签发。
- 前端上传的图片会压缩到最长边 1600px 后以 base64 提交给模型服务。如果对隐私有更高要求，建议在界面上明确告知用户数据去向。
