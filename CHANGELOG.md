# 更新日志

版本号遵循 `主版本.次版本.修订`：能力新增进次版本，缺陷修复进修订。
更完整的提交历史见 `git log --oneline`。

## 未发布

- 新增独立「发布沙盘」，支持社团招新和规律打卡场景，按受众重放跨帖线索、比较调整前后结果，并计算保留正文的最少遮挡方案。支持作为 PWA 独立安装。
- 新增「先脱敏，再交给 AI」文本复检。浏览器预先隐藏本地命中的字段，确认后只上传预览文本。云端新增命中在浏览器内通过唯一原文区间校验后才加入脱敏结果。
- 本地引擎补查被换行、制表符、窄空格和 Unicode 横线拆开的完整手机号、身份证号和银行卡号。常见的点号分组也可识别，其中身份证与银行卡须通过校验位校验。
- 在明确的手机标签后，识别括号分组和连续的中文口述手机号，支持「幺」「〇」等写法。
- 脱敏按原文区间替换，覆盖号码内部的分隔符。网页版、浏览器扩展和 SDK 共用更新后的规则。

## v3.9.0 —— 与云厂商解绑，主线改为独立部署

**原因**：华为云账号被冻结，`npm run probe:sis` 敲三个接口全部返回 `SIS.0101 RESTRICTED / frozen`
（三个接口同因 = 账号级，不是某个服务没开通；同期 OBS 上传/列举/删除全过，凭证本身没问题），
云上链路无法继续验收。

**处理方式：保留代码、只换主线**，业务代码一行未删。`AI_PROVIDER` 不配时本来就是 `ark`，
音视频默认走方舟多模态，华为云一直只是可选的第二通道——真正绑住项目的是文档与部署主线。

### 新增

- `docs/standalone-deploy.md`：任意 Node 22 主机 + SQLite 的完整独立部署指南，
  含本地 3 步、Linux + PM2/systemd、Nginx 反代、备份恢复、5 分钟冒烟清单与常见问题表
- `docs/archive/`：归档华为云部署、华为云配置排错、ICT 赛题1 材料、SIS-OBS 验收清单，
  每份顶部注明暂停原因与接回方式，另附 `docs/archive/README.md` 说明目录用途

### 变更

- `.env.example`：华为云整段移到文件末尾「可选 · 已暂停」区，头部改为「主线配置」并写明不填 Key 也能跑
- `docs/deploy-runbook.md`：方案 A 从「华为云 ECS」改为不挑厂商的通用服务器步骤，
  OBS → 对象存储、CES 监控 → UptimeRobot、RDS → 通用 MySQL；测试基准 522 → 607
- `README.md`：顶部独立版声明、「国产化双通道」→「模型通道可插拔」、
  架构图中 huawei.js / MySQL / Redis 标为可选、新增 v3.9 定位调整小节

### 修正（文档与实现不符）

- 音频能力描述原本写「SIS 转写 + 识别」——**错的**，默认走方舟多模态直传（`ARK_AUDIO_MODEL`），已改回
- README 里的 `docker build -t privacy-sentinel .` —— 仓库当时**根本没有 Dockerfile**，照抄必失败；
  已改为指向 `standalone-deploy.md` 里可自建的最小镜像，并标注本机无 Docker、未做构建验证

### 验证

- `npm test` **607 项全绿**（华为云 32 + SIS 52 项为纯 mock，不联网，不受影响）
- 零配置启动（不设 `ARK_API_KEY`）：`/api/health` 返回 `3.9.0 / ark / sqlite / redis disabled`
- 零配置下文本检测：`engine={local:4, ai:0}`，命中姓名/手机号/身份证/邮箱四类
- 引擎白名单路由：`/engine/schema.js` 200、`/engine/secret.js` 404

## v3.8.0 —— 可嵌入 SDK + 插件内检测工具

### 新增：SDK（`sdk/`，零运行时依赖）

- `sdk/src/index.js`：`detect` / `analyze` / `mask` / `analyzeAndMask` / `detectBatch` /
  `desensitize` / `types` / `levels` / `strategies`
- **默认不返回原文**，需 `includeRaw: true` 显式开启；返回字段走 `PUBLIC_FIELDS` 白名单
- 三种引入方式均实测：Node `require`、Node `import`（`dist/privacy-sentinel.esm.mjs`）、
  浏览器 `<script>`（`window.PrivacySentinel`）
- 手写 `sdk/types/index.d.ts`，`package.json` 四路 `exports`（types / browser / import / require）
- `scripts/build-sdk.js` 从 `services/` 生成产物并写入来源 + SHA256 头，`--check` 校验副本未漂移
- 三个示例（Node CJS / Node ESM / 浏览器）+ `sdk/README.md`
- 刻意不引打包器：引擎本身零依赖，上 rollup/webpack 只是平白多几百个间接依赖

### 新增：浏览器扩展 v1.1.0「一个插件两种用法」

- popup 增加「实时守卫 / 检测工具」双标签，选择被记住（`psPopupTab`）
- 检测页：粘贴即时检测、策略切换（mask / label / remove）、复制与下载脱敏结果
- 界面只渲染脱敏值，原文零回显；统计累加已脱敏条数

### 修复

- **P0 扩展装不上**：`manifest.json` 声明了 `"default_locale": "zh_CN"`，但仓库里没有
  `_locales/zh_CN/messages.json`，Chromium 会**拒绝装载整个扩展**，连 ID 都不注册。
  单测抓不到（jsdom 是把 popup 脚本内联跑的，不解析 manifest），是 `--load-extension`
  真机验证时才暴露的。已删掉 `default_locale`（项目里没有任何 `__MSG_` 占位符）
- `scripts/check.js` 的 49871 端口在本机被系统预留，报 `EACCES` 而非 `EADDRINUSE`，
  容易被误判成权限问题。改为启动前真实试绑并按需顺延

### 测试

- 新增 `scripts/test-sdk.js` 64 项：产物一致性 / Node API / 浏览器 UMD / ESM 与 `.d.ts` /
  隐私约束（先剥注释再扫源码，禁 `fetch(`、`localStorage`、`require('fs')`）
- `scripts/test-guard.js` 增加 E 段与 manifest 装载自检，69 → 90 项
- 总计 522 → **607 项，13 个套件**

### 真机验证（Edge 156 + `--load-extension`）

popup 4 个引擎脚本就位、双标签可切、粘贴即命中 4 条、列表只有脱敏值、原文零残留、0 个 page error。
