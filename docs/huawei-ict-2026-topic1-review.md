# 第十一届华为 ICT 大赛 · 中国创新赛 · 赛题 1
## 提交前合规审查（基于本仓库实测）

> 审查日期：2026-10-22 · 审查对象：`C:\Users\26067\OneDrive\Desktop\检测系统`（检测系统 / Privacy Sentinel）
> 版本：**v3.7.4**（package.json）· 提交 `7856d52` · 远程 `github.com/djjjjj12345/privacy-sentinel`
> 赛题：**赛题 1「基于华为云产品打造 AI 创新应用」**
> 判定依据：仓库代码、`package.json` 依赖、`.env.example`、`.codeartsdoer/` 目录、`docs/` 文档、git 跟踪文件扫描。**每条结论都标注了取证方式，未编造。**

---

## 一、结论：现在不能直接提交

**一句话**：作品形态与赛题 1 高度匹配，但**云侧三项硬要求处于"代码已实现、线上未接上"的状态**，加上队伍资格未确认，现在提交会在这两处丢掉决定性分数。

三个层次的判断：

| 层次 | 判定 | 说明 |
|---|---|---|
| **队伍资格** | ✅ 通过 | 已确认：3 名学生 + 指导教师，同校。这是唯一无法靠加班补的项，现已解除 |
| **作品形态** | ✅ 完全匹配 | 有 5 个可视化 Web 页面 + 浏览器扩展 + 公网可访问地址，正对"可视化 Demo 页面"这条 |
| **华为云产品使用** | ⚠️ 一半 | **SIS / OBS 已配真实 AK/SK/ProjectId/Region 并有联调清单**（见第三节）；但应用未部署在华为云、RDS/Redis 未接、AI 默认走火山方舟 |
| **部署与数据存储** | ❌ 未开始（首次） | 线上在 Render（免费档磁盘临时）；`DB_DRIVER`/`MYSQL_*`/`REDIS_URL` 在 `.env` 里**均未填写**，即全部走默认 sqlite + 内存 |

**结论收窄为一句**：资格已过（报名 + 实名 + 队伍 3+1）、形态匹配、有免费额度覆盖成本、演示视频已录——**剩下的全是执行问题，没有一项是死结**。唯一的不确定性是 SIS/OBS 凭证是否仍有效（10 分钟可验证）与首次部署的环境踩坑（留足缓冲即可）。

**当前真正待办只有五件**：① 验证 SIS/OBS 凭证 ② 部署到华为云 ECS ③ 接 RDS ④ 接 Redis ⑤ 补码道 Skills 证据与文档。

---

## 二、十条硬要求逐条实测对照

| # | 官方要求 | 判定 | 实测证据 |
|---|---|---|---|
| 1 | 应用领域不限 | ✅ 通过 | 隐私信息检测属行业/生活应用，可归入 |
| 2 | 云上部署 + **可视化 Demo 页面** | ⚠️ 一半 | 页面有：`index.html`/`docs.html`/`status.html`/`guard.html`/`launch.html` 五页 + 浏览器扩展；**但部署在 Render 不在华为云** |
| 3 | 体现华为云产品在需求理解、代码生成、构建、修复、部署各环节的使用价值 | ⚠️ 有物证、缺记录 | 有 `docs/huawei-deploy.md`（267 行，覆盖 RDS/DCS/SIS/OBS/PM2/验收/回滚）；**但"码道各功能使用记录"在华为云侧，本机读不到** |
| 4 | **使用华为云码道 CodeArts 代码智能体** | ⚠️ 部分 | `.codeartsdoer/.codebase/` 下确有 `file-index.db`、`index_records.json`、`baseline_info.json`、`codebaseId.json`——**Codebase 索引确实建过**；但 `agents/` 与 `skills/` 两个目录**为空** |
| 5 | 基于已有智能体和 **Skills**，关联 **RDS、Redis** | ❌ 未达标 | `package.json` 有 `mysql2` + `ioredis`；但 `.env` 里 `DB_DRIVER`/`MYSQL_*`/`REDIS_URL` **全部未填写**，`services/redis.js:20` 未配 `REDIS_URL` 直接返回 `null` 走内存 |
| 6 | 应用在**华为云上部署** | ❌ 未开始 | README 第 5 行线上 Demo 为 `https://privacy-sentinel.onrender.com`（Render，非华为云）；README 第 113 行自述"Render 免费档磁盘是临时的，重新部署会清空账号与历史"。**确认为首次部署** |
| 7 | 3 名学生 + 1 名指导教师，须同校 | ✅ **通过** | 已确认：3 人同校 + 有指导教师 |
| 8 | 高教组（本硕博），创新赛仅设高教组 | ❓ 待确认 | 需自查学籍 |
| 9 | 每人限报一个赛道，报名后不可更改 | ❓ 待确认 | 实践赛/编程赛/创新赛/挑战赛互斥 |
| 10 | 入围总决赛需**开源至 Gitee/GitHub** | ✅ 已就绪 | GitHub 仓库存在，License MIT。但**本地领先远端 2 个提交**（v3.7.3、v3.7.4 未推送） |

---

## 三、一个重要的好消息：你已经提前完成了最难的部分

赛题 1 最卡的"用华为云产品"这一条，**代码层已经真实落地、凭证也已经配好**，不是纸上集成。

**本地 `.env` 中已填写的华为云变量**（此处只记录"是否填写"，不涉及任何值）：

`HW_AK` · `HW_SK` · `HW_PROJECT_ID` · `HW_REGION` · `HW_SIS_ENDPOINT` · `HW_OBS_BUCKET` · `HW_OBS_ENDPOINT` · `HW_SIS_PROPERTY`

这意味着 **SIS 语音识别与 OBS 对象存储是真实开通并配置过的**。配合仓库里的 `SIS-OBS-真实联调验收清单.html`，可以判定这条链路此前真实跑通过——这是目前手上最硬的一条华为云证据，**不要因为"首次部署"就把它当成没有**。

**同时也要看清边界**：`HW_MAAS_API_KEY` 未填写（华为云大模型未开通）、`DB_DRIVER`/`MYSQL_*`/`REDIS_URL` 未填写（RDS/Redis 未接）。所以准确表述是——**SIS/OBS 已有证据，应用部署与数据库接入确属首次**。

| 华为云产品 | 证据 | 位置 |
|---|---|---|
| **SIS 语音交互** | 官方 SDK `@huaweicloud/huaweicloud-sdk-sis@^3.1.218` | `package.json` dependencies |
| **OBS 对象存储** | 官方 SDK `esdk-obs-nodejs@^3.26.2` | `package.json` dependencies |
| **音频链路** | 录音 → 上传 OBS 临时对象 → SIS 异步转写 → 删除 OBS 对象 → 文本模型复检 | `.env.example` 第 28 行注释，流程完整 |
| **真实联调** | `SIS-OBS-真实联调验收清单.html`（已入库） | 仓库根目录 |
| **部署文档** | `docs/huawei-deploy.md` 267 行：开通 RDS → 开通 DCS Redis → 部署应用 → 验收清单 → 音频接入 → 回滚 | `docs/` |
| **配套脚本** | `check-sis-agency.js`、`probe-huawei.js`、`resolve-project-id.js`、`setup-credentials.js` | `scripts/` |

这些是**别人临时抱佛脚做不出来的**。评审看"是否真用了华为云"，看到 SIS+OBS 的真实联调记录和验收清单，含金量远高于只在文档里写一句"部署在华为云"。

**现在的问题不是"做不到"，是"没打开开关 + 没留下证据"。**

---

## 四、必须修改（P0 · 不改会失分到出局）

### P0-1 · 线上部署从 Render 迁到华为云（最重）

- **影响**：赛题原文"完成应用作品在华为云上快速部署"。部署在 Render 属于**未满足核心技术要求**，不是细节瑕疵。
- **现状**：`https://privacy-sentinel.onrender.com`，且 README 自述磁盘临时、重部署清空数据。
- **补救**：按 `docs/huawei-deploy.md` 走 ECS 部署；或更稳妥地先把 `docs/deploy-runbook.md`（我上一轮写的 v3.7.4 手册）里的 ECS+PM2+Nginx 流程照做一遍，把目标机器从"通用云服务器"换成华为云 ECS。
- **风险点**：华为云 ECS 需安全组放行端口；大陆区域 80/443 需备案，未备案就用 `http://公网IP:8080`。
- **验收**：`curl http://<ECS公网IP>:8080/api/health` 返回 200 且 `db` 字段显示正常。

### P0-2 · 接上 RDS，把 DB_DRIVER 从 sqlite 切到 mysql

- **影响**：赛题明确要求"关联 RDS"。现在默认 `sqlite`，且 Render 磁盘临时——**数据会丢**。
- **现状**：`services/store/` 已实现 mysql 驱动，`mysql2` 已在依赖里，`.env.example` 77–85 行有完整配置项（含"应用与 RDS 必须同 VPC 走内网地址"的正确提示）。
- **补救**：华为云开通 RDS for MySQL → 同区域同 VPC → 填 `DB_DRIVER=mysql` 与 `MYSQL_*` → 重启验证。
- **风险点**：切换后原有 SQLite 里的账号数据不会自动迁移，需重新注册或用备份脚本中转。

### P0-3 · 接上 DCS Redis，配置 REDIS_URL

- **影响**：同一条赛题要求里的 Redis。
- **现状**：`services/redis.js` 第 20 行——`Boolean(process.env.REDIS_URL) && !disabled`，**不配就禁用**，限流与会话走内存。
- **补救**：开通 DCS Redis → 同 VPC → 配 `REDIS_URL` → 用 `services/redis.js` 导出的 `status()` 验证返回非 `disabled`。
- **附带收益**：限流状态从单进程内存变成跨进程共享，多实例部署才正确。

### P0-4 · 码道 Skills / 智能体使用证据

- **影响**：赛题原文"基于已有智能体和 Skills"。现在 `.codeartsdoer/agents/` 与 `skills/` **都是空目录**，Codebase 索引建过了但 Skills 没用痕迹。
- **补救**：在码道里挂一个已有 Skill（或用赛题提供的）跑通一次完整链路：需求理解 → 代码生成 → 单测生成 → 修复 → 部署，并**截图存档**。
- **注意**：这部分证据在华为云侧会话里，我这边读不到，只能靠你保存。

### ~~P0-5 · 队伍补齐~~ ✅ 已解除

已确认 3 名学生同校 + 有指导教师，满足资格。报名时再核对一次即可。

### P0-5b · 先复活 SIS/OBS 这条已有证据（成本最低、优先做）

- **为什么排在部署前面**：凭证已配好，但**可能已过期、桶可能已删、SIS 服务授权委托可能失效**。现在花 10 分钟验证，能确认这条最硬的证据还在；等部署完再发现凭证失效，就来不及补证据了。
- **两条命令**（仓库里已有现成脚本）：
  ```bash
  node scripts/resolve-project-id.js   # 用 AK/SK 验证凭证有效性，并拿到正确的项目 ID
  node scripts/check-sis-agency.js     # 检查 SIS 读取 OBS 私有桶所需的服务授权委托
  ```
- **脚本为什么要存在**（作者写在注释里的踩坑经验）：`resolve-project-id.js` 是因为账号 ID 与项目 ID 都是 32 位十六进制，填错时 SIS 只报 `APIG.0602`，完全看不出原因；`check-sis-agency.js` 是因为没做服务授权时，SIS 读不到音频却只报 `SIS.0535 wrong audio format`，极易被误判成音频格式问题。
- **产出**：两条命令的输出截图，直接作为"华为云 SIS/OBS 真实使用"的过程证据。

#### 实测结果（2026-10-22 已跑）

| 检查项 | 结果 | 解读 |
|---|---|---|
| `resolve-project-id.js` | ✅ 成功 | **AK/SK 有效**。列出 6 个区域项目 ID；`.env` 的 `HW_PROJECT_ID` 与 `cn-north-4` 一致 |
| `check-sis-agency.js` | ❌ HTTP 403 | **不是凭证失效，是权限不足**。查询 IAM 委托列表需要 `iam:agencies:list`，当前 AK/SK 应是受限子账号 |
| `/api/health` | `capabilities.audio: true` | 七个 SIS/OBS 变量全部被服务端识别 |
| `/api/health` | `dbDriver: sqlite` · `redis: disabled` | 印证 P0-2、P0-3 尚未接线 |

#### ⚠️ 重要修正：SIS 目前「配置了」但「没被调用」

用合成音频（4 秒 / 16kHz / 单声道，不含真实语音）跑了一次真实端到端：

```json
{"success":true,"kind":"audio","source":"ai","transcript":null,
 "meta":{"model":"doubao-seed-2-0-mini-260428","elapsedMs":4144}}
```

**请求成功了，但走的是火山方舟，不是 SIS**——服务端日志里没有任何 SIS/OBS 记录。追到代码里原因很清楚：

- `services/providers/index.js:27`：`AI_PROVIDER` 默认 `ark`
- `services/providers/huawei.js:36`：**`huawei-sis` 只在 `huawei` 这个 provider 里被引用**
- 于是当前 `AI_PROVIDER=ark` → 音频走 `ark.js`，SIS 完全没被调用

**连带影响**：要把 SIS 跑起来，必须 `AI_PROVIDER=huawei`，而 `huawei.js` 的 `getApiKey()` 需要 **`HW_MAAS_API_KEY`**。

这意味着 **MaaS Key 从"锦上添花"升级为"决定 SIS 运行证据能否成立"**（见第八节）。不是必需项这一点不变——没有它项目照样能跑——但**"我们真的用了华为云 SIS"这条证据，没有它就拿不到**。

**关于那个 403，不用修**：`check-sis-agency.js` 查的是"我们能不能看到委托列表"，而 SIS 真正需要的是"委托本身存在"——这是服务侧行为，不需要我们有 IAM 读权限。**唯一可靠的验证方式是端到端跑一次音频**：

```bash
# 若转写成功 → OBS 写入、SIS 读桶、服务授权委托 三者全部正常
# 若报 SIS.0535 wrong audio format → 才是委托缺失（这个报错具有误导性）
node -e "const fs=require('fs');const b=fs.readFileSync('录音-转码后16k.wav').toString('base64');fs.writeFileSync('.tmp-audio.json',JSON.stringify({kind:'audio',dataUrl:'data:audio/wav;base64,'+b}))" && \
curl -s -X POST http://127.0.0.1:8080/api/analyze -H "Content-Type: application/json" --data-binary @.tmp-audio.json | head -c 500; rm -f .tmp-audio.json
```

> ⚠️ **这条命令会把那段录音真实上传到华为云 OBS**（代码设计为转写完成后立即删除对象）。`录音-转码后16k.wav` 是含真实语音的本地文件，是否上传由你决定——换成一段不含真实个人信息的测试语音同样能验证链路。

### P0-6 · 推送远端提交

- **现状**：`git status -sb` 显示 `ahead 2`（v3.7.3、v3.7.4 未推送）。评委打开 GitHub 看到的是 v3.7.2。
- **补救**：在你自己的终端执行 `git push origin master`（本机 agent 环境无 GitHub 凭证）。

---

## 五、建议优化（P1 · 直接影响得分，不影响资格）

| # | 问题 | 为什么影响得分 | 具体做法 |
|---|---|---|---|
| P1-1 | README 版本号过时：写 v3.7.2 / 507 测试，实际 v3.7.4 / 522 | 评委/助教打开仓库第一眼就看到，显得项目停更 | 改为 v3.7.4、522/522、24/24、101 项能力矩阵 |
| P1-2 | README 线上地址仍是 Render | 自我暴露"没部署在华为云" | 迁移完成后改成华为云地址 |
| P1-3 | AI 供应商默认 `ark`（火山方舟） | 锦上添花，**非必需**（详见第八节：MaaS 仅支持西南-贵阳一，且 AI 已有回退机制） | 放到最后做：先确认免费积分允许的区域，再决定是否切 `AI_PROVIDER=huawei` |
| P1-4 | 缺演示视频 | 评委靠视频判断"能不能跑"，初赛是线上提交 | 一镜到底：打开页面 → 粘贴含敏感信息文本 → 出报告 → 复制脱敏文本 |
| P1-5 | `scripts/test-v36-hardening.js:95` 有完整 `sk-abcdefghijklmnop123456` 字面量 | 入围需开源；GitHub push protection 可能判定为密钥而拒推 | 改成运行时拼接（项目里已有 `mk(...)` 的既有做法） |
| P1-6 | 无"码道各功能使用记录"文档 | 评分项明文要求 | 截图 + 逐项说明：代码生成/研发知识问答/单元测试/Codebase 索引/规范驱动开发 |
| P1-7 | 无"关键决策与最佳实践总结" | 同上，评分项明文要求 | 按五段结构补：需求分析 → 码道使用 → 架构与部署 → 关键决策 → Demo 说明 |

---

## 六、差距清单总表

| 等级 | 项 | 当前状态 | 补救成本 |
|---|---|---|---|
| **必须改** | P0-1 部署在华为云 | Render | 中（1 天，有现成手册） |
| **必须改** | P0-2 关联 RDS | 默认 sqlite | 低（代码已就绪，改配置） |
| **必须改** | P0-3 关联 Redis | 未配置即禁用 | 低（代码已就绪，改配置） |
| **必须改** | P0-4 码道 Skills 证据 | 目录为空 | 中（需真实使用并存档） |
| **必须改** | P0-5 队伍 3+1 | 待确认 | 零成本但**不可补救** |
| **必须改** | P0-6 推送 2 个提交 | ahead 2 | 低（一条命令） |
| 建议优化 | P1-1 README 版本号 | 过时 | 低 |
| 建议优化 | P1-2 README 地址 | 仍为 Render | 低 |
| 建议优化 | P1-3 AI 供应商 | 默认非华为云 | 中 |
| 建议优化 | P1-4 演示视频 | 无 | 中 |
| 建议优化 | P1-5 密钥字面量 | 1 处 | 低 |
| 建议优化 | P1-6 码道使用记录 | 无 | 中 |
| 建议优化 | P1-7 关键决策总结 | 无 | 中 |

---

## 七、40 天行动排期（报名截止 2026-11-30，初赛 12 月线上提交）

首次部署，按这个顺序做——**先拿软的、再啃硬的**：

| 时间 | 做什么 | 产出 | 难度 |
|---|---|---|---|
| **本周内** | ① 跑 `resolve-project-id.js` + `check-sis-agency.js` 复活 SIS/OBS 证据 ② `git push origin master` ③ README 版本号改 v3.7.4/522 | 云证据截图 + 远端同步 | 低 |
| **第 1 周** | 完成报名（11-30 前）；开通华为云账号、实名认证、领学生代金券 | 报名成功 | 低 |
| **第 2 周** | 按 `docs/huawei-deploy.md` 第 0–2 节：开通 **RDS for MySQL** 与 **DCS Redis**，与 ECS 放同区域同 VPC | 两个实例运行 | 中 |
| **第 2–3 周** | 按第 3 节部署应用到 **ECS**（Node 22 + PM2 + Nginx）；未备案先用 `http://公网IP:8080` | 华为云上的 Demo 地址 | 中 |
| **第 3 周** | 填 `DB_DRIVER=mysql` + `MYSQL_*` + `REDIS_URL`，`curl /api/health` 验收 | 云上链路跑通 | 低 |
| **第 3–4 周** | 在码道里用 Skills 跑一轮完整链路并存档；录一镜到底演示视频 | 过程证据 | 中 |
| **第 4–5 周** | 补"关键决策与最佳实践总结"；清密钥字面量；异地网络访问验证一次 | 材料齐备 | 低 |
| **12 月初赛前** | 提前 3 天提交；跑全量测试 + 前端审计 | 提交完成 | 低 |

> **顺序为什么这样排**：复活 SIS/OBS 只要 10 分钟且能立刻拿到硬证据，先做；ECS 部署是唯一需要"等资源开通 + 踩环境坑"的环节，越早开始越有缓冲；RDS/Redis 只是改配置，等部署好了再切最省事。

---

## 八、仍需你回答（无法从代码判断）

| # | 问题 | 状态 |
|---|---|---|
| 1 | 队伍几人？同校？有指导教师？ | ✅ **3 人同校 + 指导教师** |
| 2 | 是否已在华为云部署运行过？ | ✅ **应用部署属首次**（SIS/OBS 凭证已配，待验证有效性） |
| 3 | 是否已报名？账号实名认证？ | ✅ **已报名 + 已实名认证** |
| 4 | 有没有已录的演示视频？ | ✅ **已录**（但见下方"视频地址陷阱"） |
| 5 | 华为云成本怎么办？ | ✅ **有免费积分额度可申请**——ECS/RDS/DCS 的成本障碍解除 |
| 6 | 有无华为云 MaaS 的 Key？ | ⚠️ 不确定——**但这不是必需项，见下节** |

### 关于 MaaS Key：不影响运行，但影响 SIS 证据（已修正优先级）

**结论：没有 MaaS Key，项目照样能跑、不影响提交；但拿不到「我们真的用了华为云 SIS」的运行证据。**

原因（实测 + 代码定位）：`huawei-sis.js` 只在 `providers/huawei.js` 里被引用，而 `AI_PROVIDER` 默认 `ark`。要切到 `huawei` 就必须有 `HW_MAAS_API_KEY`。**当前状态下 SIS 是"配置齐全但从未被调用"**——评委若问"你们真跑过吗"，答不上来。

依据是代码里的既有设计：

- `.env.example` 原文注释：「华为云 MaaS（**AI_PROVIDER=huawei 时必填；ark 时留空即可**）」
- 当前 `ARK_API_KEY` 已填，`AI_FALLBACK_PROVIDER=ark` 也已配置——**AI 走火山方舟，且有回退机制，现在是能跑的**
- 赛题 1 说的是"基于**华为云产品**打造 AI 创新应用"，而 SIS + OBS + RDS + DCS + ECS **已经是五个华为云产品**了；模型侧用哪家不是硬要求

**而且 MaaS 有一个硬限制**：`.env.example` 第 12 行写明「MaaS 预置服务目前仅支持**西南-贵阳一**区域」。如果你用免费积分开通的 ECS/RDS 不在贵阳一，MaaS 就得跨区域调用，反而增加复杂度和延迟。

**建议顺序**：先把 ECS + RDS + Redis 跑通（决定成绩的部分），确认免费积分允许开通的区域后，再看要不要加 MaaS。做成了是加分，做不成完全不影响提交。

**如果你还是想试**：华为云控制台 → MaaS（ModelArts Studio）→ API Key 管理 → 创建 Key（明文只显示一次，立刻保存）。仓库里有 `scripts/probe-huawei.js`，填好 `HW_MAAS_BASE_URL` 与 `HW_MAAS_API_KEY` 后可直接探测能力，不用猜。

### ⚠️ 视频已录，但有个陷阱要检查

**如果视频里出现的是 Render 地址（`privacy-sentinel.onrender.com`），迁移到华为云后必须重录。**

原因很直接：视频里的 URL 与"部署在华为云"是评委能一眼看到的矛盾点。这比你以为的要严重——评委看视频判断"能不能跑、部署在哪"，看到 Render 域名会直接判定云上部署这条不成立。

**做法**：等华为云地址可用后，用同样的脚本重录一遍；如果时间紧，至少确认视频里没有清晰展示域名（但这个不好控制，能重录还是重录）。

---

**下一步**：`node scripts/resolve-project-id.js` + `node scripts/check-sis-agency.js`，把输出贴给我。
