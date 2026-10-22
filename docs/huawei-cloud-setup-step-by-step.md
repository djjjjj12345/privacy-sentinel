# 华为云开通手把手指南（照着点就行）

> 适用：第十一届华为 ICT 大赛 · 赛题 1 · 检测系统首次上云
> 前置：已完成注册与实名认证（你已满足）· 有免费额度
> 目标：拿到 MaaS Key → 开通 ECS / RDS / DCS → 服务跑在华为云上

---

## 第 0 步：先记住三个决定，后面所有操作都依赖它

| 决策 | 选什么 | 为什么 |
|---|---|---|
| **区域** | **华北-北京四（cn-north-4）** | 你现有的 SIS 和 OBS 都在这个区域（已实测确认）。ECS/RDS/DCS 必须跟它同区域，否则走不了内网、还要多花流量费 |
| **VPC** | 都用**默认 VPC**（`vpc-default`） | 同一个 VPC 内，ECS 才能用内网地址连 RDS 和 Redis |
| **计费模式** | **按需计费** | 免费额度只能抵扣「按需计费」的资源。选包年包月不抵扣，会真扣钱 |

> ⚠️ **唯一的例外是 MaaS**：它只能选「西南-贵阳一」，跟其他服务不同区域。这是正常的，MaaS 是通过公网 API 调用，不需要内网。

---

## 第 0.5 步：先做账号体检（2 分钟，跳过会白跑后面全部）

2026-10-22 实测：`AI_PROVIDER=huawei` 启动后提交 4 秒合成音频，SIS 直接报错：

```
SIS.0101  auth failed, the request resource type is RESTRICTED   # 极速版
SIS.0101  auth failed, the request resource type is frozen       # 普通版
```

同一个请求里 **OBS 上传/列举/删除 7 项全过**（AK/SK、桶、区域、权限都没问题），
所以这不是密钥配错，而是 **账号侧状态问题**。官方文档口径：`SIS 无宽限期，欠费后继续调用会冻结，
冻结后按需资源不可调用`；`从未调用过的接口视为未开通服务，欠费后不可调用`。

**先跑一条命令定性**（判断是「账号级」还是「某个接口没开通」）：

```bash
npm run probe:sis        # 依次敲 一句话识别 / 极速版 / 普通版 三个接口
```

实测输出（三个接口**全被同一原因拦下**）：

```
一句话识别 short-audio   ⛔ 被拦截   auth failed, the request resource type is RESTRICTED
极速版 asr/flash         ⛔ 被拦截   auth failed, the request resource type is RESTRICTED
普通版 asr/transcriber   ⛔ 被拦截   auth failed, the request resource type is frozen
→ 三个接口全被同一原因拦下 = 账号级问题（欠费冻结/账号受限），不是某个接口没开通
```

> 判读规则：**三个都拦 = 账号级**（去控制台点「开通」没用，得充值/解冻）；
> **只拦一个 = 接口级**（去 SIS 控制台「开通管理」按接口开通）。

**按顺序查 3 件事：**

| # | 去哪看 | 看什么 | 不是这样怎么办 |
|---|---|---|---|
| 1 | 控制台 → **费用与成本 → 总览** | 账户余额、是否存在欠费/冻结 | 有欠费或**余额为 0** → 先充值 1~10 元（录音文件识别约 **2.5 元/小时**，4 秒音频约 0.003 元）。⚠️ **代金券/免费额度 ≠ 账户余额**：按需欠费冻结只认余额，券再多也解不了冻 |
| 2 | **费用与成本 → 优惠折扣** | 比赛/开发者空间发的代金券是否到账、使用范围是否含 SIS / ECS | 未到账 → 去「免费试用 / 大赛权益页」领取；不含 SIS → 就只能小额充值 |
| 3 | 控制台搜索「**语音交互服务 SIS**」→ 服务介绍 → **开通管理** | cn-north-4 这个项目下是否是「已开通」 | 显示未开通 → 点开通（默认按需，**不使用不计费**）。⚠️ 开通是**按项目维度**的，必须给 `HW_PROJECT_ID=01a14ef0436c7a2a82a5f940238ff342`（= cn-north-4）这个项目开 |

> 修完再跑一次：`node scripts/verify-sis-live.js --audio 录音-转码后16k.wav`
> 期望看到「端到端转写 ✅」，并且转写文本里出现手机号/身份证号。

---

## 第 1 步：申请 MaaS API Key（约 10 分钟）

> 目的：让「SIS 转写 → 大模型分析」这条链路的**后半段**有国产模型可用。
> 澄清（重要）：`AI_PROVIDER=huawei` 这一行才决定 SIS 被调用；
> MaaS Key 缺了只会让「转写出文本之后的大模型分析」失败，**不影响 SIS 本身跑起来**。
> 也就是说：**你现在不做第 1 步，也能先拿到 SIS 的运行证据。**

**1.1 打开控制台**

浏览器访问 `https://www.huaweicloud.com/product/modelarts/studio.html`，点「ModelArts Studio 控制台」，登录。

**1.2 切换区域**（最容易漏的一步）

页面**顶部**的区域选择器，切换为 **「西南-贵阳一」**。

> 怎么确认做对了：页面左上角显示的区域名是「西南-贵阳一」。选错区域后面根本看不到预置服务。

**1.3 免费额度到底在哪（找不到就看这段）**

官方口径的入口是：**在线推理 → 预置服务 → 「免费服务」页签 → 右侧「领取额度」**（每个模型 200 万 tokens，
领取按钮变灰即已领过）。如果你在页面上只看到一列「未开通」、且「优惠折扣」全是 `-`，
说明**你看的是「商用服务」列表，或者免费活动已对你的账号/当前版本下线**。别在这上面耗时间：

| 兜底 | 怎么做 | 花钱吗 |
|---|---|---|
| 兜底 1（推荐） | 直接在商用列表点「开通服务」。MaaS 预置服务是**按需计费、不开通不能用、开通本身 0 元、不用不计费**；创建 API Key 也**完全免费** | 0 元起步，按 token 计（演示几十次调用≈几角钱，通常代金券就能抵） |
| 兜底 2 | 走「华为开发者空间」入口：devstation 工作台 → 我的开发工具 → ModelArts Studio → 立即前往，那里有「免费服务」引导 | 免费 |
| 兜底 3 | 控制台 → 费用与成本 → 优惠折扣，看代金券/资源券的**使用范围**是否覆盖 MaaS | — |

> 结论：**免费额度不是必要条件。** 只要账户没被冻结（见第 0.5 步），开通 + 建 Key 就能拿到调用能力，
> 账单由代金券或几分钱的按需费用覆盖。第 0.5 步的账号体检优先级更高。

**1.4 开通模型服务**

左侧菜单 → **模型推理 → 在线推理** → 点「**预置服务**」页签 → 找到想用的模型（例如 DeepSeek 系列）→ 右侧「操作」列点「**开通服务**」→ 勾选同意 → 「一键开通」。

> 怎么确认做对了：该服务的状态变成「运行中」。

**1.5 拿到 API 地址**

在已开通的服务右侧「操作」列 → 「**调用说明**」→ 接口类型选 **OpenAI SDK** → 页面上会显示 **API 地址** 和 **模型名称**。

**把 API 地址抄下来** —— 这就是 `HW_MAAS_BASE_URL`（形如 `https://xxx.modelarts-maas.com/v1/...`，以页面显示为准，不要照抄本文件）。

> ⚠️ 复制的地址如果以 `/chat/completions` 结尾，**把这段去掉**（代码会自动补，重复会 404）。

**1.6 创建 API Key**

左侧菜单 → 「**API Key 管理**」→ 右上角「**创建 API Key**」→ 填标签和描述（随便填，比如 `ict-contest`）→ **权限选「全部」** → 确定。

> 🚨 **密钥只显示这一次，关掉窗口就再也看不到了。** 立刻复制保存到本地。

**1.7 填进 `.env`**

```bash
HW_MAAS_BASE_URL=<1.5 抄的 API 地址>
HW_MAAS_API_KEY=<1.6 创建的密钥>
HW_MAAS_AUTH=bearer
AI_PROVIDER=huawei        # 关键：这一行才让 SIS 真正启用
```

**1.8 验证（先验证 SIS，再验证 MaaS）**

```bash
# A. 只验 SIS（不需要 MaaS Key）：OBS 连通 + 端到端转写 + 残留清理
node scripts/verify-sis-live.js --audio 录音-转码后16k.wav

# B. 验 MaaS：拿 Key 之后再跑
node scripts/probe-huawei.js
```

> 怎么确认做对了：
> - A 出现「端到端转写 ✅」→ **SIS + OBS 真跑起来了**（这是赛题 1 最值钱的证据）。
> - B 返回模型回复 → MaaS 通了，此时音频链路才是「SIS 转写 + 国产大模型分析」完整国产化。
>
> 已知报错对照：
> - `SIS.0101 ... RESTRICTED / frozen` → 账号欠费冻结或服务未开通，回去做 **第 0.5 步**。
> - `SIS.0535 wrong audio format` → 有误导性，多半是 SIS 的服务授权委托没建，去 SIS 控制台做「服务授权」。
> - `data url is unreachable` → 普通版要求 OBS 是**公开桶**，或改走极速版（`HW_SIS_MODE=flash`）。

---

## 第 2 步：开通 ECS 云服务器（约 15 分钟）

**2.1 领免费额度**

控制台**顶部搜索框**输入「免费试用」→ 进入活动页 → 找到「弹性云服务器 ECS」→ 点「立即领取」。

> 找不到入口就在搜索框搜「免费体验」，这是最快的路径。

**2.2 创建实例**

控制台 → 弹性云服务器 ECS → 「购买弹性云服务器」，按下表选：

| 配置项 | 选什么 |
|---|---|
| 计费模式 | **按需计费** |
| 区域 | **华北-北京四** |
| CPU 架构 | x86（选鲲鹏的话后续所有安装命令都要换 arm64 包） |
| 规格 | 2 核 4G 起（1 核 2G 也能跑，但装依赖会慢） |
| 镜像 | **Ubuntu 22.04**（文档里的命令都按 Ubuntu 写） |
| 网络 | 默认 VPC、默认安全组 |
| 公网 IP | **勾选**（否则你连不上） |
| 带宽 | 按流量计费即可，1~5M |

**2.3 放行端口**（新手最常卡在这里）

创建完成后 → 实例详情页 → 「安全组」页签 → 添加规则，放行：

| 端口 | 用途 |
|---|---|
| 22 | SSH 登录 |
| 8080 | 应用（未备案时用它访问） |
| 80 / 443 | 备案后走域名访问 |

**2.4 登录服务器**

控制台 → 实例列表 → 「远程登录」（或用你自己的 SSH 工具连公网 IP）。

**2.5 装环境**（照抄即可）

```bash
sudo apt update && sudo apt install -y nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v    # 应输出 v22.x
```

**2.6 部署应用**

```bash
sudo mkdir -p /srv/privacy-sentinel && sudo chown -R $USER /srv/privacy-sentinel
cd /srv/privacy-sentinel
git clone https://github.com/djjjjj12345/privacy-sentinel.git app
cd app && npm ci --omit=dev
cp docs/env.production.template .env   # 然后按第 3、4 步填真实值
sudo npm i -g pm2 && pm2 start ecosystem.config.js
```

> 怎么确认做对了：`curl http://localhost:8080/api/health` 返回 `{"success":true,...}`。

**2.7 Nginx 反代**（可选，走域名时才需要）

按 `docs/deploy-runbook.md` 里的站点配置，注意三处必须写对：
`client_max_body_size 50m`（否则大文件 413）、`proxy_read_timeout 300s`（否则 AI 长请求 504）、`proxy_set_header X-Forwarded-Proto $scheme`（否则登录后刷新掉登录）。

---

## 第 3 步：开通 RDS for MySQL（约 10 分钟）

**3.1 创建实例**

控制台 → 云数据库 RDS → 「购买数据库实例」：

| 配置项 | 选什么 |
|---|---|
| 计费模式 | **按需计费** |
| 区域 | **华北-北京四**（必须与 ECS 一致） |
| 引擎 | MySQL 8.0 |
| 规格 | 2 vCPUs / 4 GB，存储 40 GB（免费额度通常覆盖这个规格） |
| 虚拟私有云 | **与 ECS 同一个 VPC** |
| 密码 | 设好并**立刻保存** |

**3.2 拿到内网地址**

创建完成后 → 实例详情 → 「连接信息」→ 复制 **内网地址**（形如 `xxx.mysql.rds.cn-north-4.myhuaweicloud.com`）。

> 🚨 必须复制**内网**地址，不要复制公网地址。内网更快、免费，公网要走流量费。

**3.3 建库**

RDS 控制台 → 「数据库管理」→「创建数据库」，库名填 `privacy_sentinel`。

**3.4 放行 ECS**

RDS 实例 → 「安全组」→ 确保允许 ECS 所在安全组访问 3306 端口（同 VPC 通常默认放行）。

**3.5 填进 `.env`**

```bash
DB_DRIVER=mysql
MYSQL_HOST=<3.2 复制的内网地址>
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=<3.1 设的密码>
MYSQL_DATABASE=privacy_sentinel
```

> 怎么确认做对了：重启服务后 `curl /api/health` 里 `dbDriver` 变成 `mysql`、`db` 是 `ok`。

---

## 第 4 步：开通 DCS Redis（约 5 分钟）

**4.1 创建实例**

控制台 → 分布式缓存服务 DCS → 「购买缓存实例」：

| 配置项 | 选什么 |
|---|---|
| 计费模式 | **按需计费** |
| 区域 | **华北-北京四** |
| 类型 | Redis（单机即可，最便宜） |
| 版本 | Redis 5.0+ |
| 虚拟私有云 | **与 ECS 同一个 VPC** |
| 密码 | 可设可不设，设了要填进连接串 |

**4.2 拿到连接地址**

创建完成后 → 实例详情 → 复制 **内网连接地址**（IP 或域名）。

**4.3 填进 `.env`**

```bash
# 开了 SSL 用 rediss://，没开用 redis://
REDIS_URL=rediss://<用户名>:<密码>@<内网地址>:6379/0
```

> 怎么确认做对了：`curl /api/health` 里 `redis` **不再是 `disabled`**。
> 填完还是 disabled：说明 `REDIS_URL` 格式不对或连不上，先检查密码里有没有 `@`、`:` 这类特殊字符（需要做 URL 编码）。

---

## 第 5 步：一分钟验收

```bash
curl http://<ECS公网IP>:8080/api/health
```

对照这张表，全对才算完成：

| 字段 | 期望值 | 对应哪一步 |
|---|---|---|
| `dbDriver` | `mysql` | 第 3 步 RDS |
| `redis` | 不是 `disabled` | 第 4 步 DCS |
| `db` | `ok` | RDS 连通 |
| `capabilities.audio` | `true` | SIS 配置齐全 |
| `aiProvider` | `huawei` | 第 1 步 MaaS |

---

## 常见坑与排查

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 免费额度领了还是扣钱 | 选了包年包月，或规格超出免费范围 | 改按需计费；去「费用中心 → 资源包」看剩余额度 |
| ECS 连不上 RDS | 不同 VPC，或用了公网地址 | 同一 VPC + 内网地址 |
| 页面 502 | 应用没起来 | `pm2 logs` 看报错 |
| 上传大文件 413 | Nginx 默认 1MB | `client_max_body_size 50m` |
| AI 请求 504 | Nginx 默认 60s，AI 最长 180s | `proxy_read_timeout 300s` |
| 登录成功但刷新掉登录 | 没传 `X-Forwarded-Proto` | 在 Nginx 加上该请求头 |
| Redis 一直 disabled | 连接串格式错或密码含特殊字符 | 检查并做 URL 编码 |
| SIS 报 `SIS.0535` | 服务授权委托没建（不是音频格式问题） | SIS 控制台做「服务授权」 |

---

## 三条省钱与止损建议

1. **设余额预警**：控制台 → 费用中心 → 开启短信/邮件提醒。免费额度用完会开始真扣钱。
2. **不用就关机**：比赛演示之外的时间把 ECS 关机，只收存储费。
3. **到期前检查**：「费用中心 → 资源包」里能看到每个资源的到期时间，快到期时决定续用还是释放。
