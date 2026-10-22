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

## 第 1 步：申请 MaaS API Key（约 10 分钟）

> 目的：让 SIS 语音识别真正跑起来。没有它，SIS 永远不会被调用。

**1.1 打开控制台**

浏览器访问 `https://www.huaweicloud.com/product/modelarts/studio.html`，点「ModelArts Studio 控制台」，登录。

**1.2 切换区域**（最容易漏的一步）

页面**顶部**的区域选择器，切换为 **「西南-贵阳一」**。

> 怎么确认做对了：页面左上角显示的区域名是「西南-贵阳一」。选错区域后面根本看不到预置服务。

**1.3 开通模型服务**

左侧菜单 → **模型推理 → 在线推理** → 点「**预置服务**」页签 → 找到想用的模型（例如 DeepSeek 系列，页面上有「免费额度」标记的优先）→ 右侧「操作」列点「**开通服务**」→ 勾选同意 → 「一键开通」。

> 怎么确认做对了：该服务的状态变成「运行中」。

**1.4 拿到 API 地址**

在已开通的服务右侧「操作」列 → 「**调用说明**」→ 选择版本 → 页面上会显示 **API 地址** 和 **模型名称**。

**把 API 地址抄下来** —— 这就是 `HW_MAAS_BASE_URL`（形如 `https://xxx.modelarts-maas.com/v1/...`，以页面显示为准，不要照抄本文件）。

**1.5 创建 API Key**

左侧菜单 → 「**API Key 管理**」→ 右上角「**创建 API Key**」→ 填标签和描述（随便填，比如 `ict-contest`）→ **权限选「全部」** → 确定。

> 🚨 **密钥只显示这一次，关掉窗口就再也看不到了。** 立刻复制保存到本地。

**1.6 填进 `.env`**

```bash
HW_MAAS_BASE_URL=<1.4 抄的 API 地址>
HW_MAAS_API_KEY=<1.5 创建的密钥>
HW_MAAS_AUTH=bearer
AI_PROVIDER=huawei        # 关键：这一行才让 SIS 真正启用
```

**1.7 验证**

```bash
node scripts/probe-huawei.js     # 探测 MaaS 是否可用
node scripts/make-test-tone.js 4 .tmp-tone.wav   # 生成测试音频（合成音，不含真人声）
# 启动服务后提交音频，看服务端日志里有没有 SIS / OBS 记录
```

> 怎么确认做对了：日志出现 SIS 相关输出。**到这一步，华为云 SIS + MaaS 两个 AI 服务都真跑起来了。**
> 如果报 `SIS.0535 wrong audio format`：多半是 SIS 的服务授权委托没建（不是音频格式问题，这个报错有误导性），去 SIS 控制台做「服务授权」即可。

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
