# 隐私哨兵 · 独立部署指南（v3.9）

> **给不想碰任何云厂商控制台的人。**
> 一台能跑 Node 22 的机器 + 一个 SQLite 文件即可完整上线，**不需要开通任何云服务**。
> 需要更细的生产手册（Nginx 完整配置、防火墙、回滚）请看 [deploy-runbook.md](deploy-runbook.md)；
> 原华为云链路已暂停，文档在 [archive/](archive/)。

---

## 〇、先确认跑哪一层

| 配置 | 能用什么 | 什么时候选 |
|---|---|---|
| **一个变量都不填** | 文本检测（14 类字段 + 国标校验）、批量、脱敏导出、输入守卫、SDK、浏览器扩展 | 内网/离线/纯工具类部署；隐私要求最高（原文不出机器、也不出进程） |
| **只填 `ARK_API_KEY`** | 上面全部 + 图片/音视频多模态 + 大模型语义复检 | 绝大多数场景，推荐 |
| 再加 `REDIS_URL` | 多实例共享限流与会话 | 有多副本部署时；不填则内存计数，单机完全够用 |

存储默认 SQLite（Node 内置 `node:sqlite`，**零依赖、不需要装数据库**）。
`DB_DRIVER=mysql` 是可选项，只在你要多机共享历史记录时才用。

---

## 一、本地 3 步跑起来

```bash
git clone https://github.com/djjjjj12345/privacy-sentinel.git
cd privacy-sentinel
npm install

# 零配置启动（只用本地引擎）
npm start
# 想启用语义层：cp .env.example .env，填 ARK_API_KEY 后重启

npm test          # 607 项，应全部通过
```

打开 http://localhost:8080 ，另有 `/guard.html`（输入守卫）、`/docs.html`、`/status.html`。
换端口：`PORT=8099 npm start`。

> **端口起不来？** 报 `listen EACCES` 不是权限问题，是端口被系统预留
> （Windows：`netsh int ipv4 show excludedportrange protocol=tcp`；Linux 查 `ss -lntp`）。换个端口即可。

---

## 二、任意 Linux 主机（VPS / 物理机 / 开发板）

### 2.1 装 Node 22.13+

```bash
# x86_64；ARM 机器把 linux-x64 换成 linux-arm64
curl -fsSL https://nodejs.org/dist/v22.13.0/node-v22.13.0-linux-x64.tar.xz -o node.tar.xz
sudo mkdir -p /opt/node && sudo tar -xJf node.tar.xz -C /opt/node --strip-components=1
echo 'export PATH=/opt/node/bin:$PATH' | sudo tee /etc/profile.d/node.sh
export PATH=/opt/node/bin:$PATH
node -v     # 必须 ≥ v22.13，node:sqlite 才可用
```

### 2.2 放代码 + 装依赖

```bash
sudo useradd -r -m -s /bin/bash ps || true
sudo mkdir -p /srv/privacy-sentinel && sudo chown ps:ps /srv/privacy-sentinel
sudo -u ps git clone https://github.com/djjjjj12345/privacy-sentinel.git /srv/privacy-sentinel
cd /srv/privacy-sentinel && sudo -u ps npm install --omit=dev
```

> ffmpeg 不用单独装：`@ffmpeg-installer/ffmpeg` 会随依赖带一份二进制（音视频抽帧用）。

### 2.3 写 `.env`（最小可用）

```ini
PORT=8080

# 对外地址：og:image / canonical / robots Sitemap 会用它补成绝对地址
# 线上必须是 https + 真实域名，末尾不要带斜杠
PUBLIC_BASE_URL=https://your.domain

# 跨域白名单，逗号分隔；留空 = 允许任意来源（方便调试），上线建议填自己的域名
ALLOWED_ORIGINS=https://your.domain

# 只填这一项就启用语义层；留空则纯本地引擎
ARK_API_KEY=

# 数据库文件放代码目录之外，方便备份与升级（默认 <项目>/data）
DB_DRIVER=sqlite
DATA_DIR=/srv/privacy-sentinel-data
# SQLITE_PATH=/srv/privacy-sentinel-data/privacy-sentinel.db

# 限流（内存计数，单机够用）
RATE_LIMIT_PER_MINUTE=30
```

```bash
sudo mkdir -p /srv/privacy-sentinel-data && sudo chown ps:ps /srv/privacy-sentinel-data
```

完整变量清单见 [.env.example](../.env.example)；华为云那一段当前用不上，已在文件里标为「可选 · 已暂停」。

### 2.4 用 PM2 守护

```bash
sudo npm install -g pm2
cd /srv/privacy-sentinel
sudo -u ps pm2 start server.js --name privacy-sentinel --time
sudo -u ps pm2 save
sudo env PATH=$PATH:/opt/node/bin pm2 startup systemd -u ps --hp /home/ps
# ↑ 会打印一条命令，原样再执行一次，开机自启就配好了

pm2 logs privacy-sentinel --lines 50
pm2 restart privacy-sentinel --update-env   # 改完 .env 用这条
```

不想用 PM2 就用 systemd：

```ini
# /etc/systemd/system/privacy-sentinel.service
[Unit]
Description=Privacy Sentinel
After=network.target

[Service]
Type=simple
User=ps
WorkingDirectory=/srv/privacy-sentinel
EnvironmentFile=/srv/privacy-sentinel/.env
ExecStart=/opt/node/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now privacy-sentinel
```

### 2.5 Nginx 反向代理

```nginx
server {
    listen 443 ssl;
    server_name your.domain;

    ssl_certificate     /etc/letsencrypt/live/your.domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your.domain/privkey.pem;

    client_max_body_size 30m;          # 图片/音视频上传上限
    gzip on;
    gzip_proxied any;                  # 少了这行，216KB 首页会原样下发
    gzip_types text/html text/css application/javascript application/json;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;       # 多模态分析较慢
    }
}
```

证书：`sudo certbot --nginx -d your.domain`。

---

## 三、Docker（自托管）

> **如实说明**：仓库当前**没有内置 `Dockerfile`**（README 早期那两行 `docker build` 是没落地过的，
> 别直接照抄）。下面这份最小镜像可以自建，**本机没有 Docker 环境，未做构建验证**，用前先 `docker build` 跑一遍。

```dockerfile
# Dockerfile（放到项目根目录）
FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080 DATA_DIR=/srv/data
VOLUME /srv/data
EXPOSE 8080
CMD ["node", "server.js"]
```

```bash
docker build -t privacy-sentinel .
docker run -d --name ps \
  -p 8080:8080 \
  -e ARK_API_KEY=你的Key \
  -e PUBLIC_BASE_URL=https://your.domain \
  -v ps-data:/srv/data \
  privacy-sentinel
```

不填 `ARK_API_KEY` 也能起，只是没有语义层。数据卷挂 `/srv/data`，对应 `DATA_DIR`。

---

## 四、数据、备份与恢复

SQLite 单文件，备份用 `VACUUM INTO`（一致性快照，**服务无需停机**）：

```bash
npm run backup
```

产物落在 `<DATA_DIR>/backups/privacy-sentinel-<时间戳>.db`（`DATA_DIR` 默认是项目里的 `data/`，
`BACKUP_DIR` 可单独指定）。脚本会保留最近若干份并清理旧的。

```bash
# 每日自动备份
0 3 * * * cd /srv/privacy-sentinel && DATA_DIR=/srv/privacy-sentinel-data \
  /opt/node/bin/node scripts/backup-db.js >> /var/log/ps-backup.log 2>&1

# 恢复：停服务 → 覆盖 db 文件 → 起服务
sudo systemctl stop privacy-sentinel
cp /srv/privacy-sentinel-data/backups/privacy-sentinel-20261102-0300.db \
   /srv/privacy-sentinel-data/privacy-sentinel.db
sudo systemctl start privacy-sentinel
```

历史记录还能在前端「历史 → 导出 JSON」手动带走，导入同理。

---

## 五、上线冒烟清单（5 分钟）

```bash
# 1) 健康检查：provider 应为 ark（或未配置），dbDriver 应为 sqlite
curl -s https://your.domain/api/health | python -m json.tool

# 2) 文本检测（不配 Key 也应返回结果，engine.local > 0）
curl -s -X POST https://your.domain/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{"kind":"text","text":"我叫王五，手机 13800138000，身份证 11010519491231002X"}'

# 3) 安全头：必须有 CSP 且带 nonce、HSTS、nosniff
curl -sI https://your.domain/ | grep -iE 'content-security-policy|strict-transport|x-content-type'

# 4) 引擎白名单：schema.js 可下发，密钥模块不可下发（应 404）
curl -s -o /dev/null -w '%{http_code}\n' https://your.domain/engine/schema.js    # 200
curl -s -o /dev/null -w '%{http_code}\n' https://your.domain/engine/secret.js    # 404

# 5) 前端三个页面都要 200
for p in / /guard.html /status.html; do
  curl -s -o /dev/null -w "$p %{http_code}\n" https://your.domain$p
done
```

期望：2) 返回手机号与身份证（脱敏值）、`hasSensitive: true`；
5) 全 200；3) CSP 里出现 `nonce-` 而不是 `unsafe-inline`。

---

## 六、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `listen EACCES` / `EADDRINUSE` | 端口被系统预留或占用，换端口（见第一节） |
| `node:sqlite` 报错 / 找不到模块 | Node < 22.13，升级；`node:sqlite` 在 22.13 才稳定可用 |
| `/api/health` 里 `aiProvider` 是 `huawei` | `.env` 里 `AI_PROVIDER` 被设成了 huawei，改回 `ark` 或删掉该行 |
| 图片/音视频提示「未配置」 | 没填 `ARK_API_KEY`，属预期行为；文本检测不受影响 |
| 上传大于 14MB 的图失败 | 上限就是 14MB（图片）/ 25MB（音视频），别调 Nginx 的 `client_max_body_size` 硬顶 |
| 检测「一三八零零一三八零零零」检不出 | 已知边界：中文数字属语义层，本地正则无解（能力矩阵里如实保留为 1 条失败） |
| 想接回华为云 | 见 [archive/huawei-deploy.md](archive/huawei-deploy.md)，补 `HW_*` 变量后 `AI_PROVIDER=huawei` 即可，代码不用动 |

---

## 七、和另外两个交付物一起用

- **浏览器扩展**：`npm run build:extension` 后，Chrome/Edge 打开 `chrome://extensions` → 开发者模式 →
  加载 `extension/` 目录。装不上先看 README 的「装不上排查」（`default_locale` 必须有 `_locales`）。
- **SDK**：`npm run build:sdk`，产物在 `sdk/dist/`，接入方式见 [sdk/README.md](../sdk/README.md)。

两者都不联网、不落盘，与服务端部署完全解耦——**可以只发 SDK 不部署服务**。
