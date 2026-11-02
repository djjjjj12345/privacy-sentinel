# docs/archive · 已暂停的华为云链路

这里放的是**暂时用不上、但不打算删**的材料。放进 archive 的意思是「先别照着做」，不是「废弃」。

## 为什么归档

v3.9 起项目与云厂商解绑，主线改成独立部署（[../standalone-deploy.md](../standalone-deploy.md)）。
直接原因是**华为云账号被冻结**：

```
npm run probe:sis
一句话识别 short-audio   RESTRICTED   364ms
极速版 asr/flash         RESTRICTED    58ms
普通版 asr/transcriber   frozen        49ms
```

三个接口被**同一个原因**拦下 = 账号级，不是某个服务没开通（同期 OBS 上传/列举/删除 7 项全过，
说明 AK/SK、区域、桶、权限都没问题）。实务点：**代金券 / 免费额度 ≠ 账户余额**，
按需计费的冻结只认余额，SIS 也没有宽限期，所以去控制台点「开通服务」对这个错没用。

## 文件清单

| 文件 | 内容 | 什么时候再看 |
|---|---|---|
| [huawei-deploy.md](huawei-deploy.md) | 华为云 ECS + RDS + DCS 部署全流程 | 账号恢复后要迁到云上时 |
| [huawei-cloud-setup-step-by-step.md](huawei-cloud-setup-step-by-step.md) | MaaS / SIS / OBS 开通与排错（含免费额度定位、账号体检） | 重新配 `HW_*` 变量时 |
| [huawei-ict-2026-topic1-review.md](huawei-ict-2026-topic1-review.md) | 华为 ICT 大赛赛题1 材料 | 赛事相关，与主线无关 |
| [SIS-OBS-真实联调验收清单.html](./SIS-OBS-真实联调验收清单.html) | SIS + OBS 联调的验收清单 | 重跑 `npm run verify:sis` 时对照 |

## 代码删了吗？没有

- `services/providers/huawei.js`（MaaS 文本/图片）、`services/providers/huawei-sis.js`（SIS 音频转写）都在
- `scripts/test-huawei-cloud.js`（32 项）、`scripts/test-huawei-sis.js`（52 项）仍在 `npm test` 里跑，
  它们全部用 mock，**不联网、不需要凭证**，所以账号冻结不影响测试通过
- `npm run probe:sis` / `verify:sis` / `probe:huawei` 这些脚本也留着，解冻后可直接用来验收

## 想接回来怎么办

1. 账号状态恢复正常（「费用与成本 → 总览」余额不为 0，且无欠费）
2. `npm run probe:sis` —— 三个接口不再报 RESTRICTED/frozen 才算真的通了
3. 按 [huawei-cloud-setup-step-by-step.md](huawei-cloud-setup-step-by-step.md) 补 `HW_*` 环境变量
4. `.env` 里 `AI_PROVIDER=huawei`（存储可选 `DB_DRIVER=mysql`）
5. `npm run verify:sis -- --audio <16k wav>` 拿到真机证据

切换是**运行时**的：改回 `AI_PROVIDER=ark` / `DB_DRIVER=sqlite` 就立刻回到独立架构，不需要动代码。
