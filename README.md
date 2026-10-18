# 隐私哨兵 · Privacy Sentinel

> 面向即时通讯场景的**敏感信息检测与预警**工具。在消息发出去之前判断其中是否包含敏感信息，并按风险等级给出拦截、脱敏与建议。

**线上 Demo**：[https://privacy-sentinel.onrender.com](https://privacy-sentinel.onrender.com) · 当前版本 **v3.3.0**

![status](https://img.shields.io/badge/version-3.3.0-blue) ![tests](https://img.shields.io/badge/tests-172%2F172-success) ![license](https://img.shields.io/badge/license-MIT-green)

---

## 一、项目特色

- **四模态检测**：文本 / 图片 / 音频 / 视频全通道
- **双引擎融合**：本地正则（确定性兜底）+ 豆包多模态大模型（语义层），结果按 `raw` 去重、`level` 取高
- **国产化双通道**：`AI_PROVIDER=ark|huawei` 一键切换；华为云 MaaS（OpenAI 兼容）+ RDS MySQL + DCS Redis，能力不足时自动降级
- **隐私零留存**：服务端日志 100% 脱敏，身份证/银行卡/手机/邮箱/IP/Bearer/api_key 一律不落盘
- **离线可用**：PWA 已配置，断网仍能浏览历史；可装到桌面/手机主屏
- **中英双语**：UI 文案与弹窗支持一键切换
- **开箱即测**：172 项自动化测试，无外部依赖即可跑通全部

## 二、检测能力

| 输入 | 引擎 | 状态 | 容量 |
|---|---|---|---|
| 文本消息 | 本地正则 + 大模型语义复检 | ✅ | 12,000 字 |
| 图片（PNG / JPG / WebP） | 多模态模型识别 + 框选 | ✅ | 14MB |
| 音频（MP3 / WAV / AAC / M4A） | 模型转写 + 识别 | ✅（华为云通道自动回退方舟；SIS 流水线待接入） | 25MB |
| 视频（MP4） | 模型转写 + 识别 | ✅（同上） | 25MB |

### 检测的隐私字段（共 13 类）

| 类别 | 示例 | 风险等级 |
|---|---|---|
| 短信验证码 | `387294` | **L4 强制阻断** |
| 密码 / 密钥 | `pwd=abc123` | L3 倒计时 |
| 身份证号 | `110105199003071239` | L1 脱敏 |
| 银行卡号 | `6228480012345671` | L2 弹窗 |
| 手机号 | `13800138000` | L1 脱敏 |
| 邮箱 | `alice@example.com` | L1 脱敏 |
| 链接（含 token） | `https://x.com/?token=abc` | L2 弹窗 |
| 护照号 | `E12345678` | L2 |
| 统一社会信用代码 | `91110000600037341L` | L2 |
| IPv4 / IPv6 | `192.168.1.1` | L1 |
| MAC 地址 | `AA:BB:CC:DD:EE:FF` | L1 |
| 姓名（中国常见 2-4 字） | `张三` | L1 |
| 家庭住址 | `北京市朝阳区xx路x号` | L1 |

### 校验位分级（不误伤也不漏报）

| 场景 | verified | 风险分 |
|---|---|---|
| 身份证过 GB11643 校验 | true | 1.0 |
| 银行卡过 Luhn 校验 | true | 1.0 |
| 格式像但校验不过 | false | 0.6（仍上报，标「存疑」） |

## 三、v3.0 - v3.3 新增能力

| 版本 | 能力 | 价值 |
|---|---|---|
| v3.0 P0 | 服务端日志脱敏 | "零留存"从口号变成事实 |
| v3.0 P1 | 本地正则 + 6 类新字段 | 覆盖面 +75% |
| v3.0 P2 | 上传前人脸模糊 | 敏感照片零信任外发 |
| v3.0 P3 | 转写文本可读性 + 时间戳 | 老年/取证场景友好 |
| **v3.1 P4** | **PWA 离线 + 桌面装** | **断网仍可浏览历史** |
| v3.1 P5 | 完整测试套件 118 项 | 5 分钟跑完全部回归 |
| v3.1 P6 | README + 架构图 + 截图 | 作品集展示 |
| v3.1 P7 | 中英双语切换 | 海外用户友好 |
| **v3.2 A1** | **SQLite 持久化历史 + 云同步** | **换设备不丢记录（Node 内置 node:sqlite，零依赖）** |
| **v3.2 A2** | **用户账号 + 登录** | **scrypt 哈希 + HttpOnly 会话 Cookie，30 天免登录** |
| **v3.2 A3** | **检测报告 PDF 导出** | **一键打印/另存 PDF，含条目表/等级/建议，零依赖** |
| v3.2 A4 | 历史 JSON 导出/导入备份 | 免费部署磁盘重置也不怕 |
| **v3.3 B1** | **模型层 Provider 抽象** | **`AI_PROVIDER=ark\|huawei` 一键切换，140 项旧测试零回归** |
| **v3.3 B2** | **RDS for MySQL 存储适配** | **`DB_DRIVER=sqlite\|mysql`，账号与历史迁云，异步仓储层** |
| **v3.3 B3** | **DCS Redis 共享限流 + 会话缓存** | **多实例限流不再各算各的；连不上自动降级** |
| v3.3 B4 | 华为云部署文档 + 32 项专项测试 | 一条 `curl /api/health` 验收整条云上链路 |

> ⚠️ Render 免费档磁盘是**临时**的：重新部署会清空账号与历史。
> 长期数据请定期用历史面板的 ⬇️ 按钮导出 JSON 备份，或为服务挂载持久磁盘（$7/月）。

## 四、架构

```
┌──────────────────────────────────────────────┐
│  前端 (PWA · 双语)                            │
│  ┌────────┐  ┌────────┐  ┌────────┐          │
│  │ 聊天 UI │  │ 检测结果 │  │ 历史记录 │         │
│  └────────┘  └────────┘  └────────┘          │
│  manifest.webmanifest  sw.js  i18n.js        │
└──────────────────┬───────────────────────────┘
                   │ POST /api/analyze
                   │ {kind, dataUrl, profile}
                   ▼
┌──────────────────────────────────────────────┐
│  Node.js + Express                           │
│  ┌────────────────────────────────────┐      │
│  │ routes/analyze.js                  │      │
│  │   └─ rateLimiter                   │      │
│  │       Redis INCR → 内存兜底        │      │
│  └────┬─────────────┬─────────────────┘      │
│       │             │                        │
│  ┌────▼─────┐  ┌────▼──────────────────┐     │
│  │ 本地正则  │  │ providers/index.js    │     │
│  │ 13 类字段 │  │  AI_PROVIDER 路由     │     │
│  │ 国标校验  │  │   ├─ ark.js（方舟）   │     │
│  └────┬─────┘  │   └─ huawei.js（MaaS） │     │
│       │        └───────────┬───────────┘     │
│       └────────┬───────────┘                 │
│                ▼                              │
│  services/analyzer.js（fuse 去重 · L1-L4）    │
│                                              │
│  services/auth.js                            │
│    ├─ services/store（sqlite | RDS MySQL）   │
│    └─ services/redis（DCS 会话缓存 · 可降级） │
└──────────────────┬───────────────────────────┘
                   │ JSON 响应
                   ▼
              用户 UI 弹窗 + 历史
```

## 五、快速开始

### 5 步跑起来

```bash
# 1. 克隆
git clone https://github.com/yourname/privacy-sentinel.git
cd privacy-sentinel

# 2. 安装依赖
npm install

# 3. 配置环境变量（可选，不配则用本地规则引擎）
cp .env.example .env
# 编辑 .env 填入 ARK_API_KEY=<你的火山方舟 API Key>

# 4. 启动
npm start
# 访问 http://localhost:8080

# 5. 跑测试
npm test
```

### 火山方舟 API Key 获取

1. 打开 https://console.volcengine.com/ark
2. 开通「方舟」服务 → API Key 管理 → 创建 Key
3. 在「模型广场」确认账号有 `doubao-seed-2-0-mini-260428`（默认模型）
4. 把 Key 填到 `.env` 的 `ARK_API_KEY=`

## 六、API 文档

### `POST /api/analyze`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `kind` | `text \| image \| audio \| video` | ✅ | 检测类型 |
| `text` | string | kind=text 时 | 文本内容，≤12000 字 |
| `dataUrl` | string | 图片/音视频时 | `data:<mime>;base64,...` 格式 |
| `profile` | object | ❌ | 用户画像 `{age, literacy, sensitivity}` |

**响应**：
```json
{
  "success": true,
  "kind": "text",
  "source": "fuse",
  "engine": { "local": 2, "ai": 1 },
  "hasSensitive": true,
  "maxLevel": 3,
  "levelName": "高风险",
  "summary": "检测到手机号 1 项 + 身份证 1 项",
  "items": [
    { "type": "phone", "label": "手机号", "raw": "13800138000", "masked": "138****8000", "level": 1, "verified": true }
  ],
  "advice": "建议脱敏后发送",
  "warnings": [],
  "meta": { "model": "doubao-seed-2-0-mini-260428", "elapsedMs": 1240 }
}
```

### `GET /api/health`

返回 `{ success, version, uptime, model, arkKeyConfigured, aiProvider, aiProviderConfigured, aiFallback, db, dbDriver, redis }`

`aiProvider` 为 `ark` / `huawei`，`dbDriver` 为 `sqlite` / `mysql`，`redis` 为 `ready` / `disabled` / `error` —— 一眼确认当前跑的是哪套底座。

### `POST /api/auth/register | /api/auth/login`（v3.2）

`{ "username": "2-24位", "password": "≥6位" }` → 种下 `ps_session` HttpOnly Cookie（30 天）。
密码仅以 scrypt 哈希 + 随机盐存储。

### `GET /api/auth/me` / `POST /api/auth/logout`

探测当前登录状态 / 登出并清除会话。

### `GET·POST·DELETE /api/history`、`POST /api/history/import`（v3.2，需登录）

云端预警历史：列表（最新 50）/ 追加（每人上限 200 条）/ 清空 / 批量导入备份。
条目结构：`{ level, action, content, detections:[{label,value}], time, date }`

### `GET /manifest.webmanifest`

PWA 配置：name / icons / theme_color / start_url

## 七、测试

```bash
npm test
# 总计：172 通过 / 0 失败 / 172 项
```

7 个独立套件：

| 套件 | 文件 | 覆盖 |
|---|---|---|
| 离线自检 | `scripts/check.js` | 65+ 项核心逻辑 |
| 日志脱敏 | `scripts/test-logger.js` | 10+ 项隐私字段 |
| 本地正则 | `scripts/test-local-extended.js` | 16+ 项字段识别 |
| HTTP 层 | `scripts/test-server.js` | 12 项 API 行为 |
| 端到端 AI | `scripts/test-end-to-end.js` | 11 项模型流程 |
| 账号与历史 | `scripts/test-auth-history.js` | 22 项注册/登录/云同步 |
| 华为云适配 | `scripts/test-huawei-cloud.js` | 32 项 Provider / RDS / Redis |

## 八、部署

### Render（一键）

1. Render → New Web Service → 连 GitHub repo
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Environment: 添加 `ARK_API_KEY=...`
5. 免费档会休眠，访问后约 30-60 秒唤醒

### 华为云（MaaS + RDS + DCS）

完整步骤见 **[docs/huawei-deploy.md](docs/huawei-deploy.md)**：区域选择、RDS 建库、DCS 连接串、Node 22 安装、PM2 守护、验收清单与回滚方式。

```ini
AI_PROVIDER=huawei
HW_MAAS_BASE_URL=<控制台复制的地址>/v1
HW_MAAS_API_KEY=<Key>
DB_DRIVER=mysql
MYSQL_HOST=<RDS 内网地址>
REDIS_URL=redis://:<密码>@<DCS 内网地址>:6379/0
```

切换是**运行时**的：`AI_PROVIDER` 改回 `ark`、`DB_DRIVER` 改回 `sqlite`，即刻回到原架构，无需改代码。

### Docker（自托管）

```bash
docker build -t privacy-sentinel .
docker run -p 8080:8080 -e ARK_API_KEY=xxx privacy-sentinel
```

## 九、隐私承诺

> "你的内容不会成为你泄露的证据。"

| 环节 | 处理方式 |
|---|---|
| 浏览器 → 服务端 | HTTPS（Render 自动） |
| 服务端日志 | **100% 脱敏**（`services/logger.js`） |
| 内存中的数据 | 识别完成后立即释放 |
| 浏览器历史 | 只存脱敏后的标签，不存原文 |
| 服务端磁盘 | **不保存任何用户内容** |

详细脱敏规则见 `services/logger.js` 的 `sanitizeForLog()`。

## 十、路线图

- [x] **v2.0** P0 图片识别 / P1 音视频 / P2 结构化输出 / P3 历史+bbox
- [x] **v2.0.1** 音视频超时 + 请求体上限
- [x] **v2.0.2** Chat Completions 字段修复 + 修复轮
- [x] **v2.0.3** Render 502 重试 + 预热
- [x] **v3.0** P0 日志脱敏 / P1 正则扩展 / P2 人脸模糊 / P3 转写可读
- [x] **v3.1** P4 PWA / P5 118 项测试 / P6 README+截图 / P7 双语
- [x] **v3.2** 账号登录 / SQLite 云同步 / PDF 报告 / JSON 备份
- [x] **v3.3** Provider 抽象 / RDS MySQL / DCS Redis / 华为云部署文档 / 172 项测试
- [ ] **v3.4** SIS 音频转写流水线（国产化音视频闭环）
- [ ] **v4.0**（产品级）批量检测 / 团队空间 / 更细的权限
- [ ] **v5.0**（商业级）SaaS 多租户 / 计费 / 管理后台

## 十一、贡献

欢迎 PR！测试覆盖率必须保持 100%。

```bash
# 开发流程
npm run dev        # 启动开发服务（nodemon 自动重启）
npm test           # 跑完全部测试
```

## License

MIT
