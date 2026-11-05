# CHANGELOG

## 0.2.4

针对实测现象"控制台一行 `[xianshou]` 都没有"（= 客户端半边从未被执行）做的定向修改。

### 修复

- **客户端半边不再声明服务依赖**（`inject = []`）。Cordis 的 `inject` 语义是"服务不到、插件不激活"，
  而且**不报错**：声明 `slots` 之后，只要宿主没先准备好这个服务，模块连执行都轮不到，
  控制台一行日志都不会有 —— 表现就是"装了插件、完全没入口、也查不到原因"。
  改为按需获取（先读属性、再退回 `ctx.get('slots')`），拿不到就打明确错误。
  最坏情况从"悄无声息"变成"有日志可查"。

### 新增

- `docs/UI-INTEGRATION.md` §12 增加 boot map 检查：`Object.keys(window.__DSH_BOOT__)`。
  列表里没有 `xianshou` = 宿主从未计划加载这个半边，问题在包声明/安装层，改 UI 代码无用。

### 说明

0.2.0 用 `client.cjs`、0.2.1~0.2.3 用 `client.js` + CJS 边界，两版都无入口
→ 可排除"文件名/模块类型"这一类假设，问题在"这一行有没有被激活/纳入名单"。

## 0.2.3

不再猜"为什么没入口"，让插件自己报到哪一步。此版本**不改注册逻辑**，只加探针与容错。

### 新增

- 加载探针：模块一被 require 就打 `[xianshou] 客户端半边已加载`。看不到这行 = 半边根本没进 boot map（包声明问题），看得到 = 代码跑到了。
- `apply` 探针：打出访问级别、`slots` 是否存在、每个槽位的注册结果。
- 诊断出口 `window.__xianshou.dump()`：版本 / 面板 id / 权限判定 / 已注册槽位 / `slots` API 键名。
  `registered` 为空且 `slotsApi` 里没有 `register` → 服务没拿到；有 `register` 但逐项报错 → 注册被拒。

### 修复

- 两个槽位改为**逐个 try/catch 注册**，单点失败不再拖垮另一个（原来 `apply` 内抛错会让整个半边静默失效）。
- 取 `slots` 时先读属性、再退回 `ctx.get('slots')`，两条路径都容错（与宿主半边同样的 Cordis Proxy 约束）。

### 文档

- `docs/UI-INTEGRATION.md` §12：控制台日志 → 原因 → 下一步的对照表。

## 0.2.2

修一个会让插件**完全不激活**的启动期崩溃。真实报错：

```
dsh: warning: 1 entry did not activate xianshou (dsh-plugin-xianshou):
Error: cannot get property "version" without inject
```

### 原因

Cordis 的 Context 是 Proxy：**读取未在 `inject` 里声明的服务属性会直接抛错**。
`detectHostVersion()` 写的是 `ctx.version` / `ctx.app` / `ctx.harness` 这类"猜着读"，
而它又是 `apply()` 的第一行 —— 抛一次，整个插件（含九个工具与闸门）全部不激活。
用普通对象做假 ctx 的测试永远发现不了这个，因为普通对象不抛。

### 修复

- 所有宿主探测改为「容错读属性 + `ctx.get(name)`」双路径，任何一条抛错都吞掉：
  - `propOf()` / `methodOf()` 内部 try/catch，永不抛
  - 新增 `safeGet(ctx, name)`，走 `ctx.get()` 且兜住异常
  - `readHost()` 不再直接 `record[name]`
- 探测顺序：先读属性（已 inject 的服务直接可读），再退回 `ctx.get()`。反过来会把 `tools` 误认成别的服务。
- 版本读不到时回落基线 `0.2.1-rc.1` 并输出告警，可用环境变量 `DSH_VERSION` 覆盖。
- 客户端半边同类问题一并修掉：`ctx.config` / `ctx.permissions` / `ctx.xianshouFeed` / `ctx.on` 全部经 `safeRead` / `safeCall`，避免面板白屏。

### 测试

- 新增 `test/cordis.contract.test.js`（7 条）：用**严格 Proxy** 复现 Cordis 语义（读未注入属性即抛错），
  断言插件在严格上下文下仍能挂载、九个工具齐全、版本可回落、`get` 抛错也能活。
- 客户端新增 3 条同类断言（apply 不抛、权限回落只读、渲染不白屏）。
- 累计 127 个用例。

## 0.2.1

修"装上但侧边栏没有入口"这一类问题。两处是 0.2.0 的实现缺陷，不是配置问题。

### 修复

- **客户端文件名**：`client/client.cjs` → `client/client.js`，并新增 `client/package.json`（`{"type":"commonjs"}`）。
  宿主按固定名提供 `/plugins/<id>/client.js`；根包是 `type: module` 时 `.js` 会被当 ESM，用嵌套 `package.json` 建立 CJS 边界，两边同时满足。
- **入口不再因权限误判而消失**：自动探测到权限拒绝时改为 `locked`——入口保留，点开是一张说明页（写明缺哪个权限点）。只有显式配置 `access: "hidden"` 才真正不注册。
  原实现"拒绝就不注册"的取舍是错的：入口静默消失是最难排查的失败模式，用户会以为插件没装上。
- **权限探测收窄**：只认 `ctx.permissions` / `ctx.get('permissions')`，不再顺手探测 `ctx.auth` / `ctx.get('access')`。任何带 `has()` 的对象都可能是 feature flag 注册表，误判即导致入口消失。

### 新增

- `npm run doctor`：自检包声明、文件名、CJS 边界、槽位注册（模拟宿主 ctx），并区分"包的问题"与"宿主/安装的问题"。
- `docs/UI-INTEGRATION.md` §11：入口不出现的六步排查顺序，每步都能否决一层。

### 测试

- 117 个用例（新增 2 条：权限探测不泛化、显式 hidden 才不注册）。

## 0.2.0

新增 Web 端功能入口模块（控制台）。宿主半边向后兼容，工具与闸门行为不变。

### 新增

- **客户端半边** `client/client.cjs`：单文件 CJS，仅依赖 React，注册 `sidebar.panellist` 入口与 `main` 整页面板。
- **八个模块**：概览 / 任务台账 / 先手闸门 / 留痕账本 / 回收队列 / 拒绝率 / 健康度 / 设置。全部可交互：搜索、分区筛选、排序、选中详情、三问自评、主题与密度切换、诊断复制。
- **权限**：`xianshou.view` / `xianshou.operate`。无查看权限时不注册任何槽位；只读权限下写按钮禁用并给出原因；权限服务抛错按拒绝处理。
- **hash 路由**：`#xianshou/<module>[/<id>][?query]`，支持深链、刷新、前进后退；未知模块回落概览，非法编码不抛错。
- **响应式**：900 px 导航转横向、560 px 卡片两列；零 `:has()` 依赖、零固定宽度、无 `fixed` 定位；动效可被 `prefers-reduced-motion` 关闭。
- **数据源降级**：`service` / `broadcast` / `injected` 三级探测；都没有时显示"数据源未连接"，不填充示例数据。
- **验收产物**：`npm run preview` 生成 `docs/console-preview.html`，六种宽度真实渲染（含深色）。

### 变更

- 宿主事件 `task.created` / `task.saved` 增加 `title` 字段，供控制台展示任务名（向后兼容，旧消费者可忽略）。

### 测试

- 新增 45 个客户端用例：逻辑 19 / 渲染 15 / 静态规范 11。累计 115 个。

## 0.1.0

首个可用版本。目标宿主 `>=0.2.1-rc.1 <0.3.0`。

### 新增

- **插件骨架**：`apply(ctx, config)` / `mount(options)`，基于 Cordis 的模块形态，`inject = ['tools']`。
- **三区分级**：`ZoneClassifier` + 四条规则 + 兜底规则，判据为"是否重复做 / 是否在能力圈内 / 是否与成长有关"。
- **先手闸门**：`tools/pre-execute` 水位线 + `ctx.tools.guard` 单调守卫；三种模式 `advisory` / `ask` / `deny`。
- **来源账本**：按权重计比例（默认字符数），三档判定 `<30%` / `30–60%` / `>60%`。
- **回收闸门**：交付时生成 24h 与 7d 两次 3 问复述；`<80%` 打回黄区并置 `rework`；同一窗口不可重答。
- **拒绝率面板**：`(rejected + 0.5×partial) / total`，健康区间 15%–40%，`<10%` 提示"可能在盲从"。
- **健康度报告**：复述准确率 / 首版自主率 / 拒绝率 / 跨任务迁移率，样本不足时不编数字。
- **存储**：会话状态 → 文件（原子写）→ 内存三级；`MigratingRepository` 支持 `v1 → v2`，未来版本 fail closed；`ResilientRepository` 写失败降级并告警。
- **版本兼容**：自实现 semver（含预发布排序）、支持矩阵、`VersionGate`、`AdapterRegistry`，以及 0.3.x 预留适配器。
- **UI**：卡片 IR + 设计令牌（浅/深）+ Markdown/Plain 渲染器 + 六类视图；`docs/ui-tokens.css` 由令牌生成。

### 测试

- 70 个用例：领域 16 / 版本 11 / 集成 20 / 存储 9 / UI 10 / 兼容矩阵 4。
- 兼容矩阵：9 版本 × 7 接缝组合 = 63 单元，全绿，单次约 0.5 秒。

### 已知限制

- 同步守卫依赖内存缓存镜像，存在一次写库往返的误差窗口。
- 丑版本校验只能提高敷衍成本，不能消灭敷衍（方案本身亦如此定位）。
- 回收默认自评，可自欺；插件不做自动判定。
- 真机安装/热重载/模型遵从度未在自动化中覆盖，清单见 `docs/COMPATIBILITY.md` §6。
