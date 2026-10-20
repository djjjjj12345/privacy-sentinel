# 华为云部署指南（v3.3）

> 目标：把隐私哨兵从 Render 迁到华为云，跑通「**码道 CodeArts 开发 + 华为云部署 + RDS/Redis**」这条链路。
> 适用：第十一届华为 ICT 大赛创新赛·赛题一；也适用于普通生产部署。

## 0. 资源与区域

| 资源 | 用途 | 建议规格 | 区域 |
|---|---|---|---|
| 弹性云服务器 ECS / Flexus | 跑 Node 服务 | 2 vCPU / 4 GB 起 | 西南-贵阳一 |
| RDS for MySQL | 用户、会话、历史 | 2 vCPU / 4 GB，40 GB | 同 VPC |
| DCS for Redis | 共享限流 + 会话缓存 | 单机 256 MB 起 | 同 VPC |
| MaaS 预置服务 | 文本 / 图片识别 | Qwen2.5-VL-7B + DeepSeek-V4.1-Flash | **仅西南-贵阳一** |

**三条硬约束：**

1. MaaS 预置服务只在**西南-贵阳一**开通，其他区域模型列表是空的。
2. ECS、RDS、DCS 必须**同区域、同 VPC**，否则内网地址不通，只能走公网（慢且不安全）。
3. 安全组：RDS 3306 / DCS 6379 **只放内网网段**；应用端口（8080 或 80）才对公网开放。

## 1. 开通 RDS for MySQL

1. 控制台搜索「云数据库 RDS」→ 购买实例 → MySQL 8.0 → 最小规格（2C4G）→ 选西南-贵阳一。
2. 网络选**与 ECS 相同的 VPC 和子网**，安全组选应用所在安全组。
3. 创建数据库：

```sql
CREATE DATABASE privacy_sentinel DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
```

4. 记录**内网地址**、端口、用户名、密码。
5. 应用首次启动会自动建表（`users` / `sessions` / `history`），无需手工执行 DDL。

> 表结构说明：`username` 使用 `utf8mb4_bin`，保证和 SQLite 一样大小写敏感；`history.detections` 存 JSON 字符串，与前端结构完全一致。

## 2. 开通 DCS for Redis

1. 控制台搜索「分布式缓存服务 DCS」→ 购买 Redis → 单机 → 最小规格 → 同 VPC。
2. 设置访问密码，记录**内网地址**与端口。
3. 连接串格式：

```
REDIS_URL=redis://:<密码>@<内网地址>:6379/0
```

用途有两个：

- **共享限流**：多实例部署时，`INCR + PEXPIRE` 保证 30 次/分钟是全局计数，而不是每台机器各算一份。
- **会话缓存**：`ps:sess:<token>` 缓存 1 天，减少 RDS 查询；DB 仍是权威数据源。

Redis 不可用时自动降级到进程内存，**不会导致登录或检测失败**。

## 3. 部署应用

### 3.1 装 Node 22

项目使用 `node:sqlite`，要求 **Node ≥ 22.13**；如果服务器是鲲鹏（ARM），必须下 `linux-arm64` 包：

```bash
# x86_64 用 linux-x64，鲲鹏用 linux-arm64
curl -fsSL https://nodejs.org/dist/v22.13.1/node-v22.13.1-linux-arm64.tar.xz -o node.tar.xz
sudo mkdir -p /opt/node && sudo tar -xJf node.tar.xz -C /opt/node --strip-components=1
echo 'export PATH=/opt/node/bin:$PATH' >> ~/.bashrc && source ~/.bashrc
node -v   # 必须 ≥ v22.13
```

### 3.2 拉代码并安装依赖

```bash
git clone <你的仓库地址> privacy-sentinel
cd privacy-sentinel
npm ci --omit=dev
```

### 3.3 配置 .env

```bash
cp .env.example .env
vi .env
```

最小可用配置（华为云全栈）：

```ini
AI_PROVIDER=huawei
AI_FALLBACK_PROVIDER=ark          # 音视频回退（可选）
HW_MAAS_BASE_URL=https://<控制台复制的地址>/v1
HW_MAAS_API_KEY=<你的 Key>
HW_VISION_MODEL=Qwen2.5-VL-7B-Instruct
HW_TEXT_MODEL=DeepSeek-V4.1-Flash

DB_DRIVER=mysql
MYSQL_HOST=<RDS 内网地址>
MYSQL_PORT=3306
MYSQL_USER=<用户名>
MYSQL_PASSWORD=<密码>
MYSQL_DATABASE=privacy_sentinel

REDIS_URL=redis://:<密码>@<DCS 内网地址>:6379/0
RATE_LIMIT_PER_MINUTE=30
PORT=8080
```

### 3.4 用 PM2 守护

```bash
npm i -g pm2
pm2 start server.js --name privacy-sentinel
pm2 startup && pm2 save
pm2 logs privacy-sentinel
```

### 3.5 开放端口

ECS 安全组入方向放通 `8080`（或直接用 Nginx 反代 80/443）。

## 4. 验收清单

| 检查项 | 命令 / 操作 | 期望 |
|---|---|---|
| 服务活着 | `curl http://127.0.0.1:8080/api/health` | `success:true` |
| 版本正确 | 同上 | `"version":"3.3.0"` |
| 模型通道 | 同上 | `"aiProvider":"huawei"`, `"aiProviderConfigured":true` |
| 存储驱动 | 同上 | `"dbDriver":"mysql"`, `"db":"ok"` |
| Redis | 同上 | `"redis":"ready"` |
| 注册登录 | 浏览器打开公网地址 → 注册 | 顶栏显示用户名 |
| 历史落库 | 发一条含身份证的文本 → 触发预警 | RDS `history` 表新增一行 |
| 重启不丢 | `pm2 restart privacy-sentinel` → 刷新 | 历史仍在 |
| 限流 | 连续快速请求 40 次 | 出现 429 |
| 降级 | 临时停 Redis | 服务仍可用，日志出现降级告警 |

## 5. 常见问题

**① 启动报 `node:sqlite` 相关错误**
Node 版本低于 22.13。用 `node -v` 确认，必要时按 3.1 重装。

**② 连不上 RDS / DCS**
90% 是区域或 VPC 不一致。确认三者同区域同 VPC，且安全组放通内网网段。

**③ `npm ci` 报缺少 mysql2**
确认 `package.json` 里已有 `mysql2`，并在服务器上重新 `npm ci`（不要只拷 node_modules，里面有平台相关二进制）。

**④ 华为云通道 401**
检查 `HW_MAAS_API_KEY` 是否复制完整（明文只显示一次），以及 `HW_MAAS_BASE_URL` 是否来自同一模型服务。

**⑤ 音频/视频报 501**
这是**预期行为**：MaaS 预置模型没有音频/视频直传入参。设置 `AI_FALLBACK_PROVIDER=ark` 回退，或按第 6 节接 SIS。

**⑥ 中文乱码**
数据库、表、连接三处都必须是 `utf8mb4`；RDS 建库语句见第 1 节。

## 6. 音频接入（SIS 两级流水线，已实现）

当前状态：`providers/huawei-sis.js` 已实现完整流水线，`providers/huawei.js` 在 SIS 配置齐全时把
`capabilities.audio` 动态置为 `true`；未配置时仍为 `false`，按 `AI_FALLBACK_PROVIDER` 回退或返回 501，
不存在"假成功"。

```
音频 base64
  → 上传 OBS（tmp/sis/{uuid}.{ext}，建议给桶配 1 天生命周期兜底）
  → SIS 录音文件识别（只吃 URL，不吃 base64；提交任务后 1s 间隔轮询，上限 60s）
  → 拿到转写文本，finally 中立即删除 OBS 对象（删除失败只记日志，不覆盖结果）
  → 本地正则引擎先扫一遍（13 类字段，零成本）
  → 转写稿再送华为云文本模型做语义兜底（复用 analyzeText 的 system prompt 与解析）
```

需要的环境变量（与 `.env.example` 一致）：

| 变量 | 说明 |
|---|---|
| `HW_AK` / `HW_SK` | 我的凭证 → 访问密钥（明文只显示一次） |
| `HW_PROJECT_ID` | 我的凭证 → 项目列表里对应区域的项目 ID |
| `HW_REGION` | 如 `cn-north-4`，需与 SIS、OBS 同区域 |
| `HW_SIS_ENDPOINT` | 如 `https://sis-ext.cn-north-4.myhuaweicloud.com` |
| `HW_OBS_BUCKET` / `HW_OBS_ENDPOINT` | 临时落地的桶与端点，如 `https://obs.cn-north-4.myhuaweicloud.com` |
| `HW_SIS_PROPERTY` | 选填，默认 `chinese_16k_media` |

> **必装 `uuid`**：官方 `@huaweicloud/huaweicloud-sdk-sis` 漏声明了传递依赖 `uuid`，不装的话服务能正常启动、
> 测试也全绿，但**第一个音频请求**会抛 `Cannot find module 'uuid'`。`package.json` 已显式声明。

### 6.0 开通与建桶（一次性）

1. **SIS**：控制台 → 服务列表 → AI 应用 > 语音交互服务 SIS → 开通。区域建议 `华北-北京四 cn-north-4`
   （注意：MaaS 只在西南-贵阳一，SIS 与 MaaS 区域可以不同，但 **SIS 与 OBS 必须同区域**）。
2. **OBS**：控制台 → 对象存储服务 OBS → 创建桶。区域 `华北-北京四`、桶名全局唯一
   （建议 `privacy-sentinel-audio-<随机4位>`）、存储类别**标准存储**、桶策略**私有**、**不要**开公共读。
   建好后进桶 → 基础配置 > 生命周期规则，加一条「前缀 `tmp/sis/`，1 天后删除」——代码会立刻删，这条只是断网崩溃时的兜底。
3. **AK/SK**：我的凭证 → 访问密钥 → 新增访问密钥，**csv 只在下载时显示一次**。
   建议用 IAM 子账号并只授予 `SIS FullAccess` + `OBS Buckets Viewer/Editor`，不要用主账号 AK。
4. 把 7 个值填进项目根目录的 `.env`，重启服务。
5. **服务授权（必做，否则转写一定失败）**：SIS 控制台 → 左侧「服务授权」→ 创建委托，授予语音识别读取 OBS 的权限。
   桶是私有的，SIS 没有这个委托就拿不到音频；表现在返回上却是 `SIS.0535 [wrong audio format]`，
   极易误判成音频格式问题（本项目实际踩过，别被它骗）。

**项目 ID 别抄错**：控制台「账号 ID（domain_id）」和「项目 ID」都是 32 位十六进制。填成账号 ID 时 SIS 报
`APIG.0602 Bad request`，看不出原因。用下面的命令直接查，避免手抄：

```bash
npm run resolve:project              # 列出当前账号所有区域的项目 ID
npm run resolve:project -- --write   # 把 HW_REGION 对应的项目 ID 写进 .env
```

### 6.1 三步验收（脚本自动跑）

```bash
npm run verify:sis                      # A + C：OBS 连通性 + 残留检查，不消耗 SIS 配额
npm run verify:sis -- --audio 录音.wav  # 追加 B：真实录音端到端转写
npm run verify:sis -- --purge           # 发现残留对象时顺手清掉
```

- **A** 阶段用本地合成的单频音（不是语音），只验证 AK/SK、桶名、区域、读写权限，**不提交 SIS 任务、不产生费用**。
- **B** 阶段才真实提交一次录音文件识别任务，会消耗 SIS 额度。
- **C** 阶段确认 `tmp/sis/` 下没有留下对象。

脚本对常见报错都给了定位提示：`NoSuchBucket` 多为桶名或区域错，`AccessDenied` 多为未实名/欠费/子账号无权限，
`SignatureDoesNotMatch` 是 SK 填错（只能重建访问密钥）。

**这条链路对隐私是升级而非妥协**：原始音频只在 OBS 停留分钟级（且用完即删）；送模型的是纯文本；可以先脱敏再送。

### 6.2 两条识别通道：必须开通极速版

SIS 的「录音文件识别」有两个子服务，能力差别很大，实测结论如下：

| | 极速版（`flash`，推荐） | 普通版（`standard`，兜底） |
|---|---|---|
| 指定音频的方式 | `obs_bucket_name` + `obs_object_key` | `data_url`（OBS 对象 URL） |
| 读私有桶 | 走「服务授权」委托，**能读到** | 实测常常读不到，返回 FINISHED 但 `segments` 为空 |
| 支持的容器 | **mp3 / m4a / aac / wav / opus** | 仅裸 PCM（`pcm16k16bit` 等 8 种） |
| 返回方式 | 同步返回 `flash_result` | 提交任务 + 轮询（job_id） |
| 模型 | `chinese_16k_conversation`、`chinese_8k_common` | `chinese_16k_media` 等 |
| 开通 | **需在控制台单独开通**，未开通报 `SIS.0004` | 「录音文件识别」页签开通 |

所以要做的三件事：

1. **服务授权**（一次性）：SIS 控制台 → 服务授权 → 对象存储服务授权，会自动创建名为 `agency_for_voice`
   的委托（委托方 `op_svc_asr`）。只有主账号或有 Security Administrator 权限的子账号能做。
   验证：`npm run check:agency`。
2. **开通极速版**：SIS 控制台 →「录音文件识别极速版」页签 → 开通管理 → 按需计费。
3. 设置 `HW_SIS_MODE=auto`（默认）：先走极速版，未开通自动回落普通版并打警告。

### 6.3 音频转码（`services/audioPcm.js`）

普通版只接受裸 PCM，所以代码会在上传前统一转码成 **16 kHz / 16 bit / 单声道 / 小端裸流**：

- **WAV → PCM**：纯 JS 解析（支持 8/16/24/32bit、多声道混单、线性插值重采样），零依赖。
- **mp3/m4a/aac/ogg/webm → PCM**：调 ffmpeg。查找顺序 `FFMPEG_PATH` → `ffmpeg-static`
  → `@ffmpeg-installer/ffmpeg` → 系统 PATH。找不到时抛 501 并提示安装。
- **裸 PCM → 直接透传**（ffmpeg 解不了没有容器头的裸流）。

> 注意：`ffmpeg-static` 的 postinstall 要从 GitHub 下二进制，国内常失败；
> 项目用的是 `@ffmpeg-installer/ffmpeg`，二进制随 npm 包分发，镜像源也能装上。

更彻底的方案是**前端就用 Web Audio 重采样成 16k PCM 再上传**（浏览器 MediaRecorder 默认产出
44.1k/48k 的 webm/opus），后端转码只作为兜底。这条待办记在 README 的 roadmap 里。


## 7. 回滚

任何一步出问题都可以单点回滚，不影响其他部分：

```ini
AI_PROVIDER=ark        # 模型回滚到火山方舟
DB_DRIVER=sqlite       # 存储回滚到本地文件
# 删掉 REDIS_URL       # 缓存回滚到内存
```

代码层没有破坏性改动：SQLite 仍是默认驱动，`AI_PROVIDER` 不填就是 ark，Render 上的现有部署可以直接继续跑。
