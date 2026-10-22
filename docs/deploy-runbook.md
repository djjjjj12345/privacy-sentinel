# 隐私哨兵 · 生产部署运行手册（v3.7.4）

> 适用版本：`3.7.4`（在 `a7a12f7` / v3.7.3 基础上增加部署就绪改动）
> 目标读者：第一次部署的人。所有命令可**逐条复制执行**，每步都标了「作用」和「风险」。
> 本手册基于**代码实测**写成，不是通用模板：文中的端口、体积上限、超时时间、环境变量都来自仓库里的真实实现。

---

## 〇、先选路线：两条路，别混着走

| | 方案 A：华为云 ECS 自建（推荐） | 方案 B：Render（现在已经在跑） |
|---|---|---|
| 适合 | 比赛现场演示、长期对外、要控数据 | 快速验证、临时分享 |
| 运维量 | 中（一台机器，你全权负责） | 低（平台托管） |
| 成本 | ECS 2C4G 约 ¥100–150/月（学生认证更便宜） | 免费档有睡眠与磁盘限制 |
| 数据持久 | ✅ 本地盘 / 云硬盘，重启不丢 | ❌ 免费档磁盘**每次部署清空** |
| 冷启动 | 无 | 15 分钟无访问即休眠，**唤醒 30–60s** |
| 大文件（图片/音视频） | ✅ 可承载 | ⚠️ 512MB 内存，45MB 请求易 OOM |

**结论**：比赛演示与正式对外，用 **方案 A**；方案 B 只作备用入口（差异见附录 B）。
**不要**在 Render 上做「部署完就演示」——冷启动会把 90 秒的演示卡在第一屏。

---

## 一、开跑前需要你确认的 6 项（已给默认值，可不答复直接按默认走）

| # | 要确认的 | 为什么必须先定 | 默认假设（按此执行） | 若不同，改哪里 |
|---|---|---|---|---|
| 1 | 部署到哪 | 决定后面所有步骤 | 华为云 ECS，Ubuntu 22.04，2C4G | 换平台看附录 B |
| 2 | 域名 + 是否已 ICP 备案 | 大陆 ECS 上 80/443 绑域名**必须备案**，否则会被拦截 | 有已备案域名 `ps.example.com` | 无备案：走 `http://<公网IP>:8080`（比赛够用），或选香港节点 |
| 3 | AI 供应商与 Key | 不配 Key，图片/音视频全不可用，只有本地文本规则 | 火山方舟（`AI_PROVIDER=ark`），你提供 `ARK_API_KEY` | 华为云 MaaS：见 `docs/huawei-deploy.md` 第 6 节 |
| 4 | 数据库 | 决定备份与扩容方式 | **SQLite**（零依赖、单机足够） | 多人并发/多实例：RDS MySQL（`docs/huawei-deploy.md` 第 1 节） |
| 5 | 是否开放注册 | 公开站会被脚本刷账号 | 开放（`/api/auth/register` 无白名单） | 需要邀请制时告诉我，加 `ALLOW_REGISTER=false` |
| 6 | 备份放哪 | 只有本机备份 = 机器挂了全没 | 本机 `data/backups` 保留 14 天 | 需要异地：加 OBS 或另一台机器（见 3.12 备注） |

> 这 6 项里只有 **#3 的 Key** 是硬阻塞：没有它服务能起来，但「图片/音频/视频检测」会返回明确的未配置提示。

---

## 二、部署前准备清单

### 2.1 资源规格（这些数字不是拍的，是按代码算的）

| 资源 | 最低 | 建议 | 依据 |
|---|---|---|---|
| CPU | 1 核 | 2 核 | 单请求内要做 base64 解码 + 本地正则全量扫描 |
| 内存 | 2 GB | **4 GB** | `express.json({limit:'45mb'})`，45MB JSON 解析峰值可达 100–200MB；并发 2–3 个就顶到 2G |
| 磁盘 | 20 GB | 40 GB | 系统 + node_modules(~300MB) + 日志 + SQLite |
| 带宽 | 1 Mbps | 5 Mbps | 上传图片/音频走的是同一入口 |
| swap | — | **2 GB** | 2G 内存机器必加，防 OOM Killer 直接杀进程 |

### 2.2 环境变量分组

**A. 必填（不填服务能起，但功能残缺）**

| 变量 | 示例 | 说明 |
|---|---|---|
| `ARK_API_KEY` | `xxxxxxxx-...` | 方舟控制台 → API Key 管理。**只显示一次** |
| `PUBLIC_BASE_URL` | `https://ps.example.com` | 决定分享卡片图与 sitemap 的绝对地址；填错会导致微信/飞书预览无图 |
| `DATA_DIR` | `/srv/privacy-sentinel/data` | **必须指到代码目录之外**，否则每次发版 `git clean` 会连库一起删 |

**B. 强烈建议（安全相关）**

| 变量 | 建议值 | 作用 |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://ps.example.com` | 留空 = 任意网站都能调你的 API（烧你的 Key）。本版新增，见 3.7 |
| `RATE_LIMIT_PER_MINUTE` | `30` | 每 IP 每分钟上限，保护 Key |
| `MAX_TEXT_LENGTH` | `200000` | 防 12MB 文本直冲模型；**不影响** 2 万字以内的正常长文检测 |
| `PORT` | `8080` | 只监听内网，由 Nginx 反代 |

**C. 按需**

`AI_PROVIDER`、`ARK_VISION_MODEL`、`DB_DRIVER`、`MYSQL_*`、`REDIS_URL`、`HW_*`（华为云全栈才需要，详见 `.env.example` 与 `docs/huawei-deploy.md`）。

> ⚠️ **注意**：`.env.example` 里 `ARK_API_KEY=your-ark-api-key-here` 是占位符。**不要**直接 `cp` 后忘了改——服务会启动成功，但每次 AI 调用都报鉴权失败，日志里看起来像「模型服务故障」。

### 2.3 敏感信息管理（四条铁律）

1. **只存在服务器上**：`.env` 落在 `/srv/privacy-sentinel/app/.env`，权限 `600`、属主 `psapp`。绝不进 Git（`.gitignore` 已排除，但每台机器都要复核）。
2. **不进命令历史**：不要 `export ARK_API_KEY=xxx` 或写在 `pm2 start` 参数里——`history` 和 `ps aux` 都能看到。统一走 `.env`。
3. **不进日志**：本项目 logger 已对 key/token 做脱敏，但**第三方库的报错不经它**。排障时贴日志前先自己扫一眼。
4. **轮换流程**（怀疑泄露时 5 分钟内做完）：
   ```
   方舟控制台新建 Key → 改服务器 .env → pm2 reload → 验证 /api/health 的 arkKeyConfigured=true
   → 到方舟控制台删除旧 Key → 观察 10 分钟 err.log 无 401
   ```
   ⚠️ 顺序不能反：先删旧 Key 会让线上立刻中断。

### 2.4 安全加固清单（上线前逐项打勾）

**主机层**

- [ ] SSH 只允许密钥登录（`PasswordAuthentication no`），`PermitRootLogin prohibit-password`
- [ ] 新建 `psapp` 普通用户跑应用，**不用 root 跑 Node**
- [ ] `ufw` 只放 22 / 80 / 443；**8080 永不对外开放**（安全组也别开）
- [ ] 系统补丁 `apt upgrade`，开启 `unattended-upgrades`（可选）
- [ ] 时区设为 `Asia/Shanghai`（否则日志时间对不上排障）

**网络层**

- [ ] 华为云安全组入方向仅 22/80/443，来源尽量限自己的 IP（22 端口）
- [ ] HTTPS 强制（80 → 301）
- [ ] Nginx 隐藏版本号：`server_tokens off;`

**应用层**（代码里已实现，部署时确认即可）

- [ ] `x-powered-by` 已关闭（`server.js`）
- [ ] CSP 带 nonce，且**无 `unsafe-inline`**（`services/securityHeaders.js`）
- [ ] 安全响应头齐全：CSP / X-Frame-Options / nosniff / Referrer-Policy / Permissions-Policy / COOP / CORP / HSTS
- [ ] `ALLOWED_ORIGINS` 已收紧
- [ ] 限流生效（`/api/analyze` 30 次/分钟/IP）
- [ ] SSRF 守卫（私网/环回/云元数据地址一律拒绝）
- [ ] 目录穿越无效（`/engine/:file` 有白名单）

**数据层**

- [ ] 每日 03:15 自动备份 SQLite（3.12）
- [ ] 备份文件权限 `600`，不与 `.env` 同目录
- [ ] 备份**至少异地一份**（否则磁盘坏 = 全丢）
- [ ] 确认 `/api/privacy` 文案与实际行为一致（本版已对齐：历史只存脱敏值）

### 2.5 上线前本机预检（5 分钟，别跳）

```bash
# 1) 全套测试必须 522 通过 / 0 失败
npm test

# 2) 前端多分辨率 + 可访问性审计，必须 严重 0 / 中等 0 / 轻微 0
npm run audit:ui

# 3) 确认 .env 没有被 Git 跟踪（输出应有一行 .env）
git check-ignore -v .env

# 4) 确认要发布的提交里没有密钥字面量（应无输出）
git grep -nE "(ARK_API_KEY|HW_MAAS_API_KEY|HW_SK)=[A-Za-z0-9]" $(git rev-list --all | head -20)

# 5) 打标签，供回滚用
git tag -a v3.7.4 -m "生产部署 v3.7.4" && git push origin v3.7.4
```

> ⚠️ 第 4 条只扫最近 20 个提交。若历史上推过真实 Key，必须先在控制台**吊销**，再考虑重写历史——只删文件不算修复。

---

## 三、部署步骤（逐条执行）

> 约定：`ps.example.com` 换成你的域名；`<公网IP>` 换成 ECS 弹性公网 IP。
> 命令默认在**你自己的 Windows 电脑（Git Bash）**或**服务器 SSH 会话**中执行，每段开头会标明。

### 3.1 创建服务器与安全组（控制台操作）

1. 华为云 → 弹性云服务器 ECS → 购买：Ubuntu 22.04，2 核 4G，系统盘 40G，按需/包年。
2. 安全组入方向规则：

| 协议 | 端口 | 源地址 | 用途 |
|---|---|---|---|
| TCP | 22 | 你的公网 IP/32 | SSH（**别开 0.0.0.0/0**） |
| TCP | 80 | 0.0.0.0/0 | HTTP（证书签发 + 跳转） |
| TCP | 443 | 0.0.0.0/0 | HTTPS |
| ~~8080~~ | — | — | **不要开**，由 Nginx 反代 |

**作用**：只暴露必要的三个端口，应用端口不直接面对公网。
**风险**：22 端口全开会被暴力破解（日志里每天几千次），限源 IP 是最省事的防护。

### 3.2 系统初始化【服务器上】

```bash
sudo timedatectl set-timezone Asia/Shanghai
sudo apt update && sudo apt -y upgrade
sudo apt -y install curl git nginx ufw sqlite3 rsync

# 2G 内存机器加 2G swap（4G 内存可跳过）
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

**作用**：装运行依赖、统一时区、加交换分区。
**风险**：`apt upgrade` 可能升级内核并提示重启（`Need to restart`）。选「稍后重启」，等部署验证完再重启，避免中途断连。

### 3.3 安装 Node 22（≥ 22.13）

```bash
# x86 机器用 linux-x64；鲲鹏/ARM 用 linux-arm64
curl -fsSL https://npmmirror.com/mirrors/node/v22.13.1/node-v22.13.1-linux-x64.tar.xz -o /tmp/node.tar.xz
sudo tar -xJf /tmp/node.tar.xz -C /opt
sudo mv /opt/node-v22.13.1-linux-x64 /opt/node
sudo ln -sf /opt/node/bin/node /usr/local/bin/node
sudo ln -sf /opt/node/bin/npm  /usr/local/bin/npm
sudo ln -sf /opt/node/bin/npx  /usr/local/bin/npx
node -v   # 必须 v22.13.x 或更高
npm -v
```

**作用**：项目用 Node 内置的 `node:sqlite`，**低于 22.13 会直接报 `Cannot find module 'node:sqlite'`**。
**风险**：用 apt 装的是 Node 18/20，一定不行；用 nvm 装多版本容易在 `sudo` 下丢失 PATH。这里用固定路径 + 软链，最稳。

### 3.4 建运行用户与目录【服务器上】

```bash
sudo useradd --create-home --shell /bin/bash psapp
sudo mkdir -p /srv/privacy-sentinel/app
sudo mkdir -p /srv/privacy-sentinel/data        # 数据库放代码目录之外
sudo mkdir -p /var/log/privacy-sentinel
sudo chown -R psapp:psapp /srv/privacy-sentinel /var/log/privacy-sentinel
```

**作用**：`psapp` 只拥有自己的目录，应用被攻破也拿不到系统权限。
**风险**：目录属主错了，启动时报 `EACCES: permission denied, mkdir '/srv/privacy-sentinel/data'`。改完用 `ls -ld` 核对。

### 3.5 上传代码（二选一）

**方式 A：服务器上直接 clone（推荐，后续升级方便）**

```bash
sudo -u psapp git clone https://github.com/djjjjj12345/privacy-sentinel.git /srv/privacy-sentinel/app
sudo -u psapp git -C /srv/privacy-sentinel/app log --oneline -1
```

**方式 B：从本机推上去（国内拉 GitHub 慢，或仓库是私有的）**

```bash
# ① 在你自己的电脑（Git Bash，项目根目录）执行：先传到服务器临时目录
rsync -avz \
  --exclude node_modules --exclude .git --exclude data --exclude venv \
  --exclude '.env' --exclude '*.log' --exclude '*.m4a' --exclude '*.wav' \
  ./ <你的登录用户>@<公网IP>:/tmp/ps-upload/

# ② 在服务器上执行：搬到正式目录并改属主
sudo mkdir -p /srv/privacy-sentinel/app
sudo rsync -a /tmp/ps-upload/ /srv/privacy-sentinel/app/
sudo chown -R psapp:psapp /srv/privacy-sentinel/app
rm -rf /tmp/ps-upload
```

> 为什么不直接传到 `psapp` 家目录：3.4 建的 `psapp` 是**无密码、无 SSH Key** 的服务账号，你无法用它登录。走「登录用户 → /tmp → sudo 搬运」最省事，也不用给它配密钥。
> ⚠️ **首次不要加 `--delete`**。确认两边一致后再用，否则会删掉服务器上已有文件。
> ⚠️ 从 Windows 上传时，`前端/` 目录名是中文，确保用 Git Bash（UTF-8），不要用 CMD/PowerShell 的 `scp` 递归脚本，容易乱码。
> ⚠️ 方式 B 没有 `.git`，**不能**用 `git checkout <tag>` 回滚；后续升级要么改用方式 A，要么每次整包重传。建议首次用 B 跑通，之后换 A。

**校验（两种方式都要做）**：
```bash
ls /srv/privacy-sentinel/app/前端/index.html   # 必须存在
```

### 3.6 安装依赖

```bash
sudo -u psapp bash -c 'cd /srv/privacy-sentinel/app && npm config set registry https://registry.npmmirror.com && npm ci --omit=dev'
```

**作用**：`--omit=dev` 跳过 jsdom / puppeteer-core / nodemon（只用于测试），生产包更小、攻击面更少；`npm ci` 严格按 `package-lock.json` 装，保证和测试过的版本完全一致。
**风险**：
- 提示 `npm ci can only install with an existing package-lock.json` → 仓库不完整，改用方式 B 重传。
- 卡在 `@ffmpeg-installer/ffmpeg` → 该包自带二进制，正常会成功；若失败，`sudo apt -y install ffmpeg` 兜底。

**验证 ffmpeg（音频检测的前提）**：
```bash
cd /srv/privacy-sentinel/app && node -e "console.log(require('@ffmpeg-installer/ffmpeg').path)"
# 期望输出类似 /srv/.../node_modules/@ffmpeg-installer/linux-x64/ffmpeg
```
若报错：`sudo apt -y install ffmpeg`，然后在 `.env` 写 `FFMPEG_PATH=/usr/bin/ffmpeg`。

### 3.7 写生产配置 `.env`

```bash
sudo -u psapp cp /srv/privacy-sentinel/app/.env.example /srv/privacy-sentinel/app/.env
sudo -u psapp nano /srv/privacy-sentinel/app/.env
```

**最小可用内容（其余保持注释即可）**：

```ini
NODE_ENV=production
PORT=8080

# 对外地址：必须 https + 真实域名，末尾无斜杠
PUBLIC_BASE_URL=https://ps.example.com

# 跨域白名单：只允许自己的站点调 API
ALLOWED_ORIGINS=https://ps.example.com

# AI 通道（把占位符换成真实 Key）
AI_PROVIDER=ark
ARK_API_KEY=<你的方舟 Key>
ARK_VISION_MODEL=doubao-seed-2-0-mini-260428

# 存储：SQLite + 指向代码目录之外
DB_DRIVER=sqlite
DATA_DIR=/srv/privacy-sentinel/data

# 防护参数
RATE_LIMIT_PER_MINUTE=30
MAX_TEXT_LENGTH=200000
```

```bash
sudo chmod 600 /srv/privacy-sentinel/app/.env
sudo chown psapp:psapp /srv/privacy-sentinel/app/.env
sudo -u psapp grep -c "your-ark-api-key-here" /srv/privacy-sentinel/app/.env   # 必须是 0
```

**作用**：一次性把所有运行参数固化，避免用命令行传参泄漏到 `ps aux`。
**风险**：
- `PUBLIC_BASE_URL` 写错 → 页面能开，但分享卡片无图、sitemap 指向错误域名。
- `DATA_DIR` 写进代码目录 → 下次发版可能丢库（本手册已刻意分离）。
- 忘改占位符 Key → 服务正常启动，AI 调用全失败（日志可见 `ARK_API_KEY` 鉴权错误）。

### 3.8 用 PM2 启动

```bash
sudo npm i -g pm2 --registry=https://registry.npmmirror.com
sudo -u psapp bash -c 'cd /srv/privacy-sentinel/app && pm2 start ecosystem.config.js'
sudo -u psapp pm2 status
sudo -u psapp pm2 logs privacy-sentinel --lines 30 --nostream
```

期望日志（关键两行）：
```
隐私哨兵服务已启动: http://0.0.0.0:8080
模型通道: 火山方舟 (ark) · 存储: SQLite (本地文件) · Redis: disabled
```

**作用**：`ecosystem.config.js` 里已设好 `kill_timeout: 30000`（配合代码里的 25 秒优雅退出）、`max_memory_restart: 700M`（防 OOM）、单实例 fork（SQLite 单写者，不能开 cluster）。
**风险**：
- `EADDRINUSE` → 端口被占，`ss -lntp | grep 8080` 找进程。
- 进程反复重启 → 看 `pm2 logs --err`，常见是 `.env` 格式错误（值里有空格没加引号）或 Node 版本不够。

**开机自启**：

```bash
sudo env PATH=$PATH:/opt/node/bin pm2 startup systemd -u psapp --hp /home/psapp
# ↑ 该命令会打印一条 sudo env PATH=... 的命令，把它原样再执行一次
sudo -u psapp pm2 save
```

**风险**：`pm2 save` 必须在 `pm2 startup` **之后**执行，否则重启后进程列表是空的。验证：`sudo reboot` 后 `pm2 status` 应显示 online。

### 3.9 Nginx 反向代理

**第一步：先写 80 端口配置（用于签证书）**

```bash
sudo mkdir -p /var/www/certbot
sudo tee /etc/nginx/sites-available/privacy-sentinel > /dev/null <<'EOF'
server_tokens off;

server {
    listen 80;
    listen [::]:80;
    server_name ps.example.com;

    location /.well-known/acme-challenge/ { root /var/www/certbot; }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/privacy-sentinel /etc/nginx/sites-enabled/privacy-sentinel
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

**第二步：签证书**

```bash
sudo apt -y install certbot
sudo certbot certonly --webroot -w /var/www/certbot -d ps.example.com --agree-tos -m you@example.com --no-eff-email
```

**第三步：换成最终配置（80 跳转 + 443 反代）**

```bash
sudo tee /etc/nginx/sites-available/privacy-sentinel > /dev/null <<'EOF'
server_tokens off;

# 代理响应默认不压缩，必须写 gzip_proxied any，否则 216KB 的首页原样下发
gzip on;
gzip_proxied any;
gzip_comp_level 5;
gzip_min_length 1024;
gzip_vary on;
gzip_types text/plain text/css application/javascript application/json application/xml image/svg+xml;

server {
    listen 80;
    listen [::]:80;
    server_name ps.example.com;

    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ps.example.com;

    ssl_certificate     /etc/letsencrypt/live/ps.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ps.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # 应用侧 express.json 上限 45MB，这里必须更大，否则 Nginx 先返回 HTML 413
    client_max_body_size 50m;
    client_body_timeout 120s;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # 缺这行，登录 Cookie 不会带 Secure；也会让限流算错 IP
        proxy_set_header X-Forwarded-Proto $scheme;

        # AI 通道最长 180s（音视频），超时给到 300s 才不会 504
        proxy_connect_timeout 10s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        proxy_buffering off;
    }
}
EOF
sudo nginx -t && sudo systemctl reload nginx
```

**作用**：TLS 终止、HTTP→HTTPS、压缩、放行大请求、延长超时。
**风险（逐个都很常见）**：
- 少了 `client_max_body_size 50m` → 传图报 **413**，而且返回的是 Nginx 的 HTML 错误页，前端只显示「服务返回异常」。
- 少了 `proxy_read_timeout 300s` → 音视频分析报 **504**（实际后端还在跑）。
- 少了 `X-Forwarded-Proto` → 登录后刷新掉登录（Cookie 没加 Secure，在 HTTPS 下被浏览器按策略处理）。
- Ubuntu 22.04 的 Nginx 是 1.18，`http2 on;` 这种新语法会报错，所以上面用的是 `listen 443 ssl http2;`。若你的 Nginx ≥ 1.25 想用新语法，改这一行即可。

### 3.10 防火墙

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
sudo ufw status verbose
```

**风险**：先放 SSH 再 enable。顺序反了会把自己关在门外（只能去控制台 VNC 救）。

### 3.11 SQLite 目录权限

```bash
sudo chown -R psapp:psapp /srv/privacy-sentinel/data
sudo -u psapp ls -ld /srv/privacy-sentinel/data
```

首次启动会自动建库建表（`data/privacy-sentinel.db`），不需要手动执行 SQL。

### 3.12 每日自动备份

```bash
sudo -u psapp crontab -e
```

加入一行：

```
15 3 * * * cd /srv/privacy-sentinel/app && /usr/local/bin/node scripts/backup-db.js >> /var/log/privacy-sentinel/backup.log 2>&1
```

手动验一次：

```bash
sudo -u psapp bash -c 'cd /srv/privacy-sentinel/app && node scripts/backup-db.js'
ls -lh /srv/privacy-sentinel/data/backups/
```

**作用**：用 SQLite 的 `VACUUM INTO` 生成一致性快照，**服务不用停**；保留最近 14 份，自动清理。
**风险**：只备份在本机 = 磁盘坏就全丢。异地备份任选其一：
- 华为云 OBS + `obsutil cp`（配一个桶，cron 里加一条）
- 另一台机器 `rsync -az /srv/.../backups/ user@backup-host:/backup/ps/`
- 低频场景也可用前端「历史导出 JSON」，但**不能替代**数据库备份（不含账号）

---

## 四、上线后验证

### 4.1 接口冒烟（12 条，逐条对照期望）

```bash
BASE=https://ps.example.com   # 没证书就先用 http://<公网IP>:8080
```

| # | 命令 | 期望 | 说明 |
|---|---|---|---|
| 1 | `curl -s -o /dev/null -w '%{http_code} %{time_total}\n' $BASE/api/health` | `200` 且 <2s | 服务活着 |
| 2 | `curl -s $BASE/api/health` | `"db":"ok"`、`"dbDriver":"sqlite"`、`"version":"3.7.4"` | 存储真的可用 |
| 3 | 同上 | `"arkKeyConfigured":true`、`"aiProviderConfigured":true` | Key 生效 |
| 4 | `curl -s $BASE/api/health` | `"capabilities":{"text":true,"image":true,"audio":true,"video":true}` | 能力矩阵 |
| 5 | `curl -s -X POST $BASE/api/analyze -H 'Content-Type: application/json' -d '{"kind":"text","mode":"local","text":"联系我 13800138000，身份证 11010519491231002X"}'` | `"hasSensitive":true`、`"masked":"138****8000"`、`"source":"local"` | 核心功能通 |
| 6 | `curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/api/analyze -H 'Content-Type: application/json' -d '{bad'` | `400` | 错误处理正常 |
| 7 | `python3 -c "import json;print(json.dumps({'kind':'text','mode':'local','text':'a'*300000}))" > /tmp/big.json` 然后 `curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/api/analyze -H 'Content-Type: application/json' --data-binary @/tmp/big.json` | `413` | 防 DoS 生效（注意必须是合法 JSON，否则拿到的是 400） |
| 8 | `curl -sI $BASE/` | 含 `content-security-policy`（带 `nonce-`）、`x-frame-options: DENY`、`nosniff`、`strict-transport-security` | 安全头齐 |
| 9 | `for p in / /docs.html /status.html /guard.html /launch.html /robots.txt /sitemap.xml; do curl -s -o /dev/null -w "$p %{http_code}\n" $BASE$p; done` | 全部 `200` | 页面与 SEO 文件 |
| 10 | `curl -s $BASE/sitemap.xml \| grep '<loc>'` | 域名是 `https://ps.example.com` | `PUBLIC_BASE_URL` 生效 |
| 11 | `curl -s -X POST $BASE/api/analyze -H 'Content-Type: application/json' -d '{"kind":"image","imageUrl":"http://169.254.169.254/latest/meta-data/"}'` | `400`（SSRF 被拒） | 云元数据不可达 |
| 12 | `curl -s -X POST $BASE/api/auth/register -H 'Content-Type: application/json' -d '{"username":"smokeuser01","password":"Passw0rd!2026"}'` | `201` + 之后 `/api/auth/me` 带 Cookie 返回该用户 | 账号链路通 |

> 第 7 条用 `python3` 造 30 万字符（≈300KB），恰好越过 `MAX_TEXT_LENGTH=200000`。
> 第 12 条会**真的建一个用户**，验证完请在数据库里删掉，或直接跳过——不要在生产留测试账号。

### 4.2 浏览器端验证（5 分钟）

1. 打开首页 → **强制刷新**（Ctrl+F5），确认样式正常（样式全丢 = CSP 把外链挡了）。
2. 粘贴含手机号的文本 → 点检测 → 结果卡片出块、脱敏显示 `138****8000`。
3. 点「复制脱敏文本」→ 粘贴到记事本，**里面不能有完整手机号**（这是 v3.7.3 修的重点）。
4. 刷新页面 → 历史里应只有脱敏值。
5. 切换深色主题 → 文字仍可读（v3.7.3 补过暗色对比度）。
6. DevTools → Console 应**零报错**；Network 里本地模式检测**不应出现 POST /api/analyze**。

**自动化复测 CSP（本机跑，需装好 devDependencies 与 Edge）**：

```bash
# 打到线上
AUDIT_BASE=https://ps.example.com npm run audit:csp
# 期望：每个页面 "共 0 条"
```

### 4.3 日志

```bash
sudo -u psapp pm2 logs privacy-sentinel --lines 100       # 实时
sudo -u psapp pm2 logs privacy-sentinel --err --lines 50  # 只看错误
tail -f /var/log/privacy-sentinel/out.log                  # 直接看文件
```

日志是**单行 JSON**：`{"t":"...","lv":"INFO","msg":[...]}`。已内置脱敏，手机号/身份证/Key 都会变成 `***REDACTED[phone](len=11)***`。

> ⚠️ 若日志里出现**明文手机号**，说明有第三方库绕过了 logger。立即停服排查，这是隐私事故。

**日志轮转**（PM2 自己写文件，必须配，否则半年后撑满磁盘）：

```bash
sudo tee /etc/logrotate.d/privacy-sentinel > /dev/null <<'EOF'
/var/log/privacy-sentinel/*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    copytruncate
}
EOF
sudo logrotate -d /etc/logrotate.d/privacy-sentinel
```

### 4.4 监控（4 个指标就够）

| 指标 | 怎么看 | 告警阈值 |
|---|---|---|
| 存活 | 华为云 CES「URL 监控」或 UptimeRobot 探 `GET /api/health` 每 1 分钟 | 连续 2 次非 200 |
| 错误率 | `grep -c '"lv":"ERROR"' /var/log/privacy-sentinel/err.log` | 5 分钟内 > 10 条 |
| 内存 | `pm2 status` 的 memory 列 / `free -m` | 常驻 > 600MB 或 swap 持续占用 |
| 磁盘 | `df -h /` | > 80% |

```bash
# 一条命令看全貌
sudo -u psapp pm2 status && free -m && df -h / && curl -s localhost:8080/api/health
```

### 4.5 常见故障排查表

| 现象 | 最可能原因 | 定位命令 | 处理 |
|---|---|---|---|
| 502 Bad Gateway | 应用没起 / 端口不对 | `pm2 status`、`ss -lntp \| grep 8080` | `pm2 logs --err` 看崩溃原因；确认 `.env` 的 `PORT` 与 Nginx `proxy_pass` 一致 |
| 413（Nginx 的 HTML 页） | `client_max_body_size` 没配 | `nginx -T \| grep client_max_body_size` | 改成 `50m` 并 reload |
| 504 Gateway Timeout | 代理超时 < AI 耗时 | `nginx -T \| grep -E "proxy_(read\|send)_timeout"` | 设 300s；同时看应用日志是否还在处理 |
| 上传大图后进程重启 | 内存不足被 OOM | `dmesg -T \| tail -30`、`pm2 status` 重启次数 | 加 swap、升到 4G、调低 `max_memory_restart` 之外的并发 |
| `Cannot find module 'node:sqlite'` | Node < 22.13 | `node -v` | 按 3.3 重装 |
| `EACCES ... /srv/privacy-sentinel/data` | 目录属主错 | `ls -ld /srv/privacy-sentinel/data` | `chown -R psapp:psapp` |
| 音频检测报 ffmpeg 找不到 | 二进制缺失 | `node -e "console.log(require('@ffmpeg-installer/ffmpeg').path)"` | `apt install ffmpeg` + `.env` 设 `FFMPEG_PATH` |
| 登录成功但刷新掉登录 | 少了 `X-Forwarded-Proto` / 未走 HTTPS | `curl -sI https://域名/api/auth/me` 看 `Set-Cookie: ... Secure` | 补 Nginx 头；确认访问的是 https |
| 浏览器报 CORS 错误 | `ALLOWED_ORIGINS` 没包含当前域名 | `curl -sI -H 'Origin: https://你的域名' $BASE/api/health \| grep -i access-control` | 补白名单或临时留空 |
| 页面样式全丢、Console 报 CSP | 出现内联 `style`/`script` 或 nonce 未注入 | `AUDIT_BASE=... npm run audit:csp` | 回滚到上一版；按报告改用 class / CSSOM |
| 分享卡片没图 | `PUBLIC_BASE_URL` 错 | `curl -s $BASE/ \| grep og:image` | 改成绝对 https 地址并 reload |
| 证书续期失败 | 80 端口被封 / 域名解析变了 | `sudo certbot renew --dry-run` | 放通 80；确认 A 记录；大陆机器确认备案 |
| 所有用户被限流 | 出口 NAT 后共享 IP | 日志里 `clientKey` 全相同 | 调高 `RATE_LIMIT_PER_MINUTE` 或前置按用户限流 |

**拿不到结论时，按这个顺序看**：`pm2 status` → `pm2 logs --err` → `nginx -t` + `tail /var/log/nginx/error.log` → `curl` 直连 `127.0.0.1:8080/api/health`（绕开 Nginx，判断是应用问题还是代理问题）。

---

## 五、版本更新与回滚

### 5.1 发布流程（每次发版照做）

```bash
# ① 本地：测试全绿 + 打标签（在你自己电脑上）
npm test                                  # 必须 522 通过 / 0 失败
git tag -a v3.7.5 -m "release v3.7.5" && git push origin master --tags   # 本机无凭证时由你在终端执行

# ② 服务器：先备份（关键！先备份再改代码）
sudo -u psapp bash -c 'cd /srv/privacy-sentinel/app && node scripts/backup-db.js'

# ③ 拉新版本
sudo -u psapp git -C /srv/privacy-sentinel/app fetch --tags
sudo -u psapp git -C /srv/privacy-sentinel/app checkout v3.7.5

# ④ 装依赖（lockfile 变了才需要，但每次跑最安全）
sudo -u psapp bash -c 'cd /srv/privacy-sentinel/app && npm ci --omit=dev'

# ⑤ 平滑重载（不是 restart）
sudo -u psapp bash -c 'cd /srv/privacy-sentinel/app && pm2 reload ecosystem.config.js'

# ⑥ 冒烟（至少跑 4.1 的第 1、2、5、8、9 条）
curl -s https://ps.example.com/api/health
```

**为什么用 `reload` 不用 `restart`**：`reload` 先起新进程、再停旧进程，配合代码里的 SIGTERM 排空，进行中的检测请求不会被切断。`restart` 是硬停。

**风险**：
- 跳过 ② → 新版本若改了表结构，回滚时数据对不上。
- 跳过 ④ → 依赖变更后启动即崩（`Cannot find module`）。
- 发版窗口选在有人用的时候 → 虽然 reload 平滑，仍建议避开演示/答辩前 10 分钟。

### 5.2 回滚（三种情况，分开处理）

**A. 代码有问题（最常见，30 秒）**

```bash
sudo -u psapp git -C /srv/privacy-sentinel/app checkout v3.7.3
sudo -u psapp bash -c 'cd /srv/privacy-sentinel/app && npm ci --omit=dev'
sudo -u psapp bash -c 'cd /srv/privacy-sentinel/app && pm2 reload ecosystem.config.js'
curl -s https://ps.example.com/api/health   # 确认 version 回到 3.7.3
```

**B. 配置改坏了（改回 `.env`）**

```bash
sudo -u psapp cp /srv/privacy-sentinel/app/.env.bak /srv/privacy-sentinel/app/.env
sudo -u psapp pm2 reload ecosystem.config.js
```
> 所以每次改 `.env` 前先 `cp .env .env.bak`（`.env.bak` 已被 `.gitignore` 忽略）。

**C. 数据坏了（必须停服再恢复）**

```bash
sudo -u psapp pm2 stop privacy-sentinel          # ① 必须先停，运行中覆盖文件会损坏
ls -lt /srv/privacy-sentinel/data/backups/ | head
sudo cp /srv/privacy-sentinel/data/backups/privacy-sentinel-20261022-031500.db \
        /srv/privacy-sentinel/data/privacy-sentinel.db
sudo chown psapp:psapp /srv/privacy-sentinel/data/privacy-sentinel.db
sudo -u psapp pm2 start privacy-sentinel
curl -s localhost:8080/api/health                # db 应为 ok
```

> ⚠️ **不要边跑边覆盖数据库文件**——这是唯一一个「操作错就彻底没救」的步骤。
> 恢复前把当前坏库改名留档（`mv privacy-sentinel.db privacy-sentinel.bad.db`），别直接覆盖。

**数据库结构变更的历史包袱**：当前 schema 只有 `CREATE TABLE IF NOT EXISTS`，**没有迁移机制**。这意味着：
- 回滚代码到旧版本，对新库是安全的（旧代码不认新列也不会崩，因为没加列）；
- 一旦将来加了列/改了列，**回滚必须同时回滚数据**，否则旧代码读到新结构可能报错。
- 建议：以后任何改表，都在同一次发布里写清「回滚是否需恢复备份」。

### 5.3 回滚演练（上线后一周内做一次）

选一个低峰期，按 5.2-A 回滚到上一版、验证、再升回来。**没演练过的回滚方案等于没有方案**——真出事时手忙脚乱地翻文档，比没有文档更糟。

---

## 六、上线检查表（打印出来逐项打勾）

**部署前**
- [ ] `npm test` 522/0
- [ ] `npm run audit:ui` 严重/中等/轻微 全 0
- [ ] `git check-ignore .env` 有输出
- [ ] 标签已打并推送
- [ ] 已确认域名解析到公网 IP / 备案状态

**部署中**
- [ ] Node ≥ 22.13
- [ ] `.env` 权限 600、占位 Key 已替换
- [ ] `DATA_DIR` 在代码目录之外
- [ ] ffmpeg 可执行
- [ ] Nginx `client_max_body_size 50m` + `proxy_read_timeout 300s` + `X-Forwarded-Proto`
- [ ] 8080 未对公网开放
- [ ] HTTPS 证书有效，80 已跳转

**部署后**
- [ ] 4.1 十二条冒烟全过
- [ ] 浏览器零 Console 报错，深色主题可读
- [ ] 「复制脱敏文本」不含完整敏感值
- [ ] 备份任务已跑通一次
- [ ] 日志轮转已配置
- [ ] 重启一次机器，`pm2 status` 自动 online

---

## 附录 A：不想用 PM2？用 systemd（更少依赖）

```ini
# /etc/systemd/system/privacy-sentinel.service
[Unit]
Description=Privacy Sentinel
After=network.target

[Service]
Type=simple
User=psapp
WorkingDirectory=/srv/privacy-sentinel/app
EnvironmentFile=/srv/privacy-sentinel/app/.env
ExecStart=/usr/local/bin/node server.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now privacy-sentinel
sudo systemctl status privacy-sentinel
sudo journalctl -u privacy-sentinel -f      # 日志（不用 PM2 的日志文件）
```

> 差异：systemd 的日志进 journald，持久化要开 `Storage=persistent`；PM2 的 `pm2 logs` 更直观。二选一，别同时开（会抢 8080）。

## 附录 B：Render 部署差异（你现在的线上环境）

| 项 | 做法 |
|---|---|
| 环境变量 | Dashboard → Environment → 逐条添加（`.env` 文件不生效） |
| 启动命令 | `npm start`（平台自动注入 `PORT`） |
| 版本 | 部署后看 `/api/health` 的 `version`，不要看控制台 |
| 磁盘 | **免费档临时盘**：每次部署清空账号/历史。要么接受，要么挂 Disk（付费），要么切 MySQL |
| 冷启动 | 15 分钟无访问休眠，唤醒 30–60s。演示前先访问一次预热 |
| 大文件 | 512MB 内存，45MB 请求体容易 OOM。图片建议 <5MB，音视频别在免费档演示 |
| 回滚 | Dashboard → Deploys → 选上一个成功部署 → Redeploy（没有 git tag 概念） |

---

## 附：本手册涉及但对不上的地方，以代码为准

| 说法 | 代码位置 |
|---|---|
| 请求体上限 45MB | `server.js` `express.json({limit:'45mb'})` |
| 图片 base64 14MB / 音视频 30MB | `services/providers/common.js` |
| AI 超时 60s/120s/180s | `services/providers/ark.js` |
| 限流 30 次/分钟/IP | `routes/analyze.js` + `services/rateLimiter.js` |
| 会话 Cookie `HttpOnly; SameSite=Lax`，HTTPS 下加 `Secure` | `services/auth.js` `isSecure()` |
| 优雅退出 25s 窗口 | `server.js` `shutdown()`；PM2 `kill_timeout: 30000` |
| CSP 无 `unsafe-inline`，nonce 注入 | `services/securityHeaders.js` |
