# 引擎副本（自动生成）

本目录由 `node scripts/build-extension.js` 从 `services/` 复制而来，不要手改。

- `schema.js` — 类型枚举、等级、脱敏规则
- `localDetector.js` — 本地正则引擎（抗变形、校验位）
- `guardCore.js` — 输入守卫的纯逻辑（读写输入框、按区间脱敏）

浏览器扩展不能 `require`，所以只能把文件带在包里；但规则必须只有一份，
因此由脚本同步，测试会校验两边是否一致（`scripts/test-guard.js`）。
