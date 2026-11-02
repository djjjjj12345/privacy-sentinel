# privacy-sentinel SDK

敏感信息检测与脱敏 SDK。**零依赖、纯本地运行、默认不回显原文。**

同一个引擎支撑着隐私哨兵的网页版、浏览器扩展和后端服务；SDK 把它做成第三方可直接接入的库。

---

## 一、安装与引入

**Node（CommonJS）**

```bash
npm install privacy-sentinel        # 发布后
# 本地开发可直接指向本目录：require('./sdk/src/index.js')
```

```js
const PS = require('privacy-sentinel');
```

**Node（ESM）**

```js
import PS, { detect, mask } from 'privacy-sentinel';
```

**浏览器（单文件，无构建）**

```html
<script src="privacy-sentinel.js"></script>
<script>
  const res = PrivacySentinel.analyzeAndMask('手机号13800138000');
</script>
```

产物由 `node scripts/build-sdk.js` 生成：

| 文件 | 用途 |
|---|---|
| `src/index.js` | Node 入口（`main`），依赖 `src/engine/*.js` |
| `dist/privacy-sentinel.js` | 浏览器 UMD 单文件，挂 `window.PrivacySentinel` |
| `dist/privacy-sentinel.esm.mjs` | ESM 单文件 |
| `types/index.d.ts` | TypeScript 类型声明 |

> ⚠️ `dist/` 只能在浏览器/ESM 环境用，不要在 Node 里 `require` 它；Node 请用 `src/index.js`。

---

## 二、API

### `detect(text, opts) → Item[]`

检测敏感信息，返回命中项（按等级从高到低）。

```js
PS.detect('手机号 13800138000');
// [{ type:'phone', label:'手机号', level:1, levelName:'', start:4, end:15,
//    masked:'138****8000', verified:true, reason:'匹配到固定格式规则，校验通过', engine:'local' }]
```

### `analyze(text, opts) → AnalyzeResult`

检测 + 可直接展示的摘要。

```js
PS.analyze(text);
// { items:[...], count:2, level:3, levelName:'', summary:'检测到 手机号、身份证号', elapsedMs:1 }
```

### `mask(text, opts) → string`

把命中区间替换成脱敏值，返回整段文本。按 `start/end` 区间重建，不是字符串替换——两处相同的手机号不会被误替换或漏替换。

```js
PS.mask('手机号 13800138000');                       // '手机号 138****8000'
PS.mask(text, { strategy: 'label' });                // '手机号 [手机号]'
PS.mask(text, { strategy: 'remove' });               // '手机号 '
```

### `analyzeAndMask(text, opts) → AnalyzeAndMaskResult`

检测 + 脱敏一步到位，最常用。

```js
const { summary, level, items, masked } = PS.analyzeAndMask(text);
```

### `detectBatch(list, opts) → BatchResult[]`

批量检测，等长同序返回。**单条出错不中断整批**，该项记为 `{ ok:false, error }`。

### `desensitize(value, type, strategy) → string`

已知类型时给单个值脱敏：`PS.desensitize('13800138000','phone')` → `138****8000`。

### `types()` / `levels()`

```js
PS.types();    // { id:'身份证号', phone:'手机号', bankcard:'银行卡号', ... }
PS.levels();   // { 1:'低', 2:'中', 3:'高', 4:'极高' }
```

### 选项 `opts`

| 字段 | 默认 | 说明 |
|---|---|---|
| `types` | 全部 | 类型白名单，如 `['phone','id']` |
| `minLevel` | `1` | 低于该等级的命中被过滤 |
| `strategy` | `'mask'` | `mask` 打码 / `label` 替换成 `[手机号]` / `remove` 删除 |
| `includeRaw` | **`false`** | 是否在结果里带原文 |
| `includeReason` | `true` | 是否带命中原因 |

---

## 三、为什么默认不给原文

SDK 的典型用法是「检测 → 把结果写进日志 / 上报后台」。如果默认返回 `raw`，调用方很容易在毫不知情的情况下，把身份证号又存了一份到日志里——那等于 SDK 自己成了第二个泄露源。

所以默认只给 `type / level / start / end / masked`，调用方本来就有原文，需要时按 `start/end` 自己切片即可；确实要 `raw` 就显式传 `{ includeRaw: true }`，让"我要拿原文"变成一个需要主动做出的决定。

---

## 四、隐私边界（接入时请一起遵守）

- **不联网**：SDK 不发任何请求，没有 `fetch`、没有 `XMLHttpRequest`。
- **不落盘**：不写文件、不写 `localStorage`、不打日志。
- **原文不出函数**：所有计算在内存里完成。
- **脱敏结果可安全展示**：`masked` 已经处理过，`items` 里没有原文。

---

## 五、示例

```bash
node scripts/build-sdk.js              # 先生成 dist
node sdk/examples/node.js              # CommonJS 用法（7 个场景）
node sdk/examples/node-esm.mjs         # ESM 用法
# 浏览器：直接打开 sdk/examples/browser.html（或起个静态服务）
```

---

## 六、维护约定

- **规则只在 `services/` 改一份**。`sdk/src/engine/` 下的文件由 `scripts/build-sdk.js` 自动生成，带来源哈希；`npm test` 里的 SDK 套件会校验两边是否漂移。
- **没有打包器**。引擎本身就是零依赖的 IIFE 双端写法，引入 webpack/rollup 只会给一个零依赖的包平白加上几百个间接依赖。
- **改完记得**：`node scripts/build-sdk.js` → `npm test`。
