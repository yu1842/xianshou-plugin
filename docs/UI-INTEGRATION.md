# 功能入口模块 · 集成说明

> 适用 DSH Desktop / Web `>=0.2.1-rc.1 <0.3.0`
> 代码：`client/client.cjs`（单文件 CJS，只依赖 `require('react')`）
> 可视化验收：`docs/console-preview.html`（六种宽度真实渲染）

---

## 1. 交付了什么

| 项 | 值 |
| --- | --- |
| 侧边栏入口 | `sidebar.panellist` 槽位，`id = xianshou`，`order = 1`（紧跟官方"插件"分组之后） |
| 入口图标 | 门框 + 穿越箭头（20×20，`currentColor`，随主题变色） |
| 入口文案 | 「先手协议」（`label: () => string`，支持后续接 locale） |
| 功能页面 | `main` 槽位，`key = xianshou`（与入口 id 严格相等） |
| 模块数 | 8 个：概览 / 任务台账 / 先手闸门 / 留痕账本 / 回收队列 / 拒绝率 / 健康度 / 设置 |
| 客户端体积 | 约 63 KB 源码，gzip 后约 15 KB |
| 运行时依赖 | 仅 React（宿主已提供） |

**为什么入口是一行而不是一个分组**：`sidebar` / `root` / `rightbar` 是 DSH 的 single 槽位，由官方 `ui-layout` / `ui-sidebar` 占用，插件不可替换。插件能做的是"往列表里加一行"和"注册一个整页面板"，这两件事恰好就是需求要的形态，也不与社区布局插件（如 two-pane-sidebar 会把 `sidebar.panellist` 的行渲染到窄轨上）冲突。

---

## 2. 槽位契约

```js
// 入口（多值槽位，按 order 排序；行长得像"插件"，点击权归宿主侧边栏）
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist',
  id: 'xianshou',
  order: 1,
  label: () => '先手协议',
}, SidebarIcon));

// 面板（键控槽位：key 必须等于入口 id，否则 selectPanel 找不到目标）
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main',
  key: 'xianshou',
}, Page));
```

三条硬约束，写错任何一条都会表现为"点了没反应"：

1. **`main` 用 `key` 而不是 `id`**。`main` 是键控槽位，用 `id` 注册不会报错，但永远打不开。
2. **`key` 与入口 `id` 必须相等**。宿主点击入口时按 `id` 去 `main` 里找同名 `key`。
3. **注册必须放进 `ctx.slots.inject` 的回调里**。这样插件卸载或热更新时注册会被一并回收，不会残留幽灵入口。

`apply` 的 `inject` 只声明 `['slots']`：`locale` 等其它服务按可选方式取，缺了不影响挂载，避免"服务不在就整个插件挂起"。

---

## 3. 点击链路

```
用户点击侧边栏「先手协议」
  → 宿主侧边栏读取该行的 id（xianshou）
  → 宿主调用 selectPanel('xianshou')
  → 在 main 槽位里查找 key === 'xianshou' 的面板
  → 渲染 ConsolePage
  → ConsolePage 读取 location.hash 决定初始模块
```

插件不接管点击事件（入口行没有自己的 onClick）：点击权属于宿主侧边栏，这是社区布局插件能自由重排入口的前提。我们只保证 `id` 与 `key` 对齐。

---

## 4. 权限控制

### 4.1 权限点

| 权限点 | 含义 | 缺失时的表现 |
| --- | --- | --- |
| `xianshou.view` | 能否看到面板内容 | 入口**仍然注册**，点开是一张锁定说明页（写明缺哪个权限点），不渲染任何模块 |
| `xianshou.operate` | 能否执行写操作 | 入口可见、面板可读、写按钮禁用并给出原因 |

四档访问级别：

| 级别 | 入口 | 面板 | 出现条件 |
| --- | --- | --- | --- |
| `hidden` | 不注册 | —— | **仅当**部署配置 `access: 'hidden'`（旧写法 `'deny'` 同义） |
| `locked` | 可见 | 锁定说明页 | 宿主权限服务拒绝 `xianshou.view` |
| `view` | 可见 | 只读 | 有 view 无 operate，或未检测到权限服务 |
| `operate` | 可见 | 可读写 | 两个权限点都有 |

### 4.2 判定顺序

```
1. 显式 access=hidden（部署配置）  → hidden，直接不注册
2. 宿主权限服务（只认 ctx.permissions 或 ctx.get('permissions')，要求有 has()）
     → 拒绝 view：locked（入口保留，面板锁定）
     → 有 view 无 operate：view
     → 都有：operate
     → has() 抛错：按拒绝处理（locked）
3. 都没有：view，并在页头与页脚明示"未检测到平台权限服务"
```

四条设计取舍：

- **只认 `has()`，不猜角色名**。不同部署的 role 命名不统一（owner / admin / operator / member），按名字猜一定会猜错。
- **探测范围刻意收窄**。只认明确命名为 `permissions` 的服务，不再顺手探测 `ctx.auth` / `ctx.get('access')`。任何带 `has()` 的对象都可能是 feature flag 注册表，误判的代价是入口静默消失。
- **自动拒绝只降级到 `locked`，不隐藏入口**。入口消失会让用户以为插件没装上；入口还在、点开写明原因，问题才查得动。
- **宿主判定优先于部署覆盖**。配置不能把被宿主拒绝的人放进来，只能收紧（`hidden`），不能放宽（`operate` 会被宿主拒绝覆盖）。


### 4.3 与平台权限规范的关系

平台侧的权限模型是**访问模式预设**（Full access / Standard），管的是 Agent 能做什么；本模块管的是"谁能看这个面板、谁能改账本"。两者不冲突：入口只读展示闸门模式，修改闸门仍要改 profile 配置（`gate.mode`），界面不提供第二处写入口。

因为 DSH 客户端插件目前没有公开的"权限点声明"清单，本模块把权限当作**可绑定的端口**：宿主一旦提供 `permissions.has()` 就自动接管；没有时按只读降级并在界面上说明。这样既不会假装自己受平台管控，也不会因为缺少服务而整块不可用。

---

## 5. 路由

### 5.1 为什么用 hash 而不是路径

DSH 的前端静态服务是 SPA dist 服务器，**对未知路径返回 404，不做 history fallback**，插件也没有注册服务端路由的公开接口。用路径路由会出现"刷新即 404"。hash 不经过服务端，刷新、深链、前进后退都成立。

### 5.2 路由表

| hash | 页面 |
| --- | --- |
| `#xianshou/overview` | 概览（默认，无 hash 时也落这里） |
| `#xianshou/tasks` | 任务台账 |
| `#xianshou/tasks/xs-7f21?zone=red&q=订单` | 台账 + 选中任务 + 筛选条件 |
| `#xianshou/gate` | 先手闸门 |
| `#xianshou/ledger/xs-7f21` | 指定任务的留痕 |
| `#xianshou/recalls` | 回收队列 |
| `#xianshou/refusal` / `#xianshou/health` | 拒绝率 / 健康度 |
| `#xianshou/settings` | 设置与诊断 |

行为保证（均有测试覆盖）：

- 未知模块回落 `overview`，不白屏
- 非法 `%` 编码不抛错，保留原始字符串
- 空查询不产生多余 `?`
- `hashchange` 驱动（浏览器前进/后退可用），面板内导航写 hash 而不是只改 state
- 从侧边栏重新打开面板时，沿用当前 hash 恢复上次位置

---

## 6. 响应式与浏览器兼容

### 6.1 断点

| 宽度 | 布局 |
| --- | --- |
| ≥ 900 px | 左侧 190 px 竖向导航 + 右侧内容；卡片自适应三列 |
| < 900 px | 导航变顶部横向条（可横向滚动），内容单列，激活项用下划线而非左侧色条 |
| < 560 px | 指标卡两列、任务行改为纵向堆叠，按钮不截断 |

所有断点下：**不出现整页横向滚动条，不出现被裁掉的按钮，不出现文字覆盖**。主容器不设固定像素宽度，`min-width:0` 保证 grid 子项可收缩。

### 6.2 刻意规避的特性

| 特性 | 为什么不用 |
| --- | --- |
| `:has()` 作为唯一布局手段 | 老内核降级后整行撑不开；本项目 `:has()` 用量为 0 |
| `container-type` / `@container` | 需要容器查询支持，媒体查询已足够 |
| `color-mix()` / `:where()` | 新增语法，宿主内核版本不可控 |
| `position: fixed` | 会覆盖宿主标题栏与侧边栏（有测试断言禁止） |
| 自定义滚动条 / 大量动画 | 与宿主滚动手感冲突；动效全部可被 `prefers-reduced-motion` 关闭 |

### 6.3 浏览器清单

| 浏览器 | 最低版本 | 说明 |
| --- | --- | --- |
| Chrome / Edge | 100+ | 主要验证环境 |
| Firefox | 100+ | `:focus-visible`、`gap` 均支持 |
| Safari | 15.4+ | 避开 `:has()` 依赖；`aspect-ratio` 未使用 |

### 6.4 怎么验证

```bash
npm run preview     # 生成 docs/console-preview.html 并打开
```

页面里是**六份真实渲染的面板**（1280 / 1024 / 900 / 768 / 560 / 375 px，最后一份为深色主题），内容与线上同一套代码，只注入了示例事件。它是产物而不是截图，改完代码重跑命令即可更新。

自动化部分由 `test/client.static.test.mjs` 兜住：断点存在性、无固定宽度、无 `fixed` 定位、无 `:has()` 依赖、无 `eval/innerHTML`、体积预算。

---

## 7. 与设计规范的一致性

| 规范 | 做法 |
| --- | --- |
| 颜色 | 只消费宿主令牌 `--dsw-*`，且**每个令牌都带兜底值**（换肤或令牌改名时不至于白屏） |
| 圆角 / 焦点环 | `--dsw-radius-*`、`--dsw-focus-ring-*` |
| 字体 | 继承宿主 `font: inherit`，不覆盖全局字体 |
| 图标 | 全部内联 SVG，`aria-hidden`、`stroke="currentColor"`，随主题自动变色 |
| 密度 | 提供 `cozy` / `compact` 两档，只调整间距与字号，不改变信息层级 |
| 文案 | 中文优先，数字必须带含义（不出现孤立的百分比），不说教 |
| 无障碍 | 导航 `aria-current`、筛选项 `aria-pressed`、计量条 `role="img"` + `aria-label`、`:focus-visible` 焦点环、`prefers-reduced-motion` |

样式表由插件在首次挂载时注入，`<style data-plugin="dsh-plugin-xianshou">`：带上 `data-plugin` 之后，宿主的"无主样式清扫"不会把它回收掉。

---

## 8. 数据来源与降级

面板不直接读文件、不发私有请求，只接受三种来源（按优先级）：

| 来源 | 条件 | 界面标记 |
| --- | --- | --- |
| `ctx.xianshouFeed` 服务 | 宿主未来提供订阅接口 | `数据源 service` |
| `ctx.on('xianshou/*')` 广播 | 客户端能收到事件 | `数据源 broadcast` |
| `window.__XIANSHOU_FEED__` 注入 | 预览挂具 / 集成测试 | `数据源 injected` |
| 都没有 | —— | `数据源未连接` + 明确说明，**不填充任何示例数据** |

这条规则是有意的：一个用假数据把面板填满的插件，比一个承认"没连上"的插件危险得多——用户会以为自己看到的是真实账本。

写入侧的边界同样明确：**界面只做暂存与展示，所有会改账本的动作都在会话工具里完成**（`xianshou_mark` / `xianshou_recall` / `xianshou_refusal`）。一条写入路径比两处都能写更安全，也避免界面与工具的状态互相覆盖。

---

## 9. 验收清单

| 需求 | 实现 | 证据 |
| --- | --- | --- |
| 1. 侧边栏可见入口，位置合理、标识清晰、风格统一 | `sidebar.panellist`，`order=1`，门框图标 + 名称，随主题变色 | `test/client.logic.test.mjs`「注册」三条；`docs/console-preview.html` 页头 |
| 2. 点击打开功能页面容器 | `main` 槽位，`key === id` | 同上 + 渲染测试（面板骨架含 8 个模块入口） |
| 3. 完整展示所有模块与操作项，可交互 | 8 模块 + 搜索/筛选/排序/选中/自评/主题/密度/复制诊断 | `test/client.render.test.mjs` 13 条渲染断言（含逐页空态冒烟） |
| 4. 权限控制 | `xianshou.view` / `xianshou.operate`；宿主拒绝时入口保留但锁定；写操作禁用并说明；隐藏入口需显式配置 | `test/client.logic.test.mjs`「权限」六条 |
| 5. 路由配置，跳转无异常 | hash 路由表 + `hashchange` + 深链恢复 + 非法输入容错 | 「路由」四条 |
| 6. 不同分辨率与主流浏览器 | 三个断点、零 `:has()` 依赖、零固定宽度、无 `fixed` 定位；六宽预览 | `test/client.static.test.mjs` 11 条 |
| 7. 遵循现有设计规范与交互 | 宿主令牌 + 兜底、继承字体、`aria-*`、reduced-motion、密度档 | 静态检查 + `docs/UI-SPEC.md` |

---

## 10. 已知限制

1. **不能替换官方侧边栏**。`sidebar` / `root` / `rightbar` 是 single 槽位，插件只能加行。想把入口搬到独立窄轨，需要额外装布局插件（如 two-pane-sidebar），它会自动读取 `sidebar.panellist` 的注册。
2. **装完必须重启 `dsh web`**。Web 端在启动时编译客户端包名单，只刷新浏览器不会加载新插件。
3. **面板内不写账本**。所有写入走会话工具；界面的"暂存"只是本地草稿，刷新即失。
4. **实时性取决于数据源**。`broadcast` 模式下只能看到本次连接之后的事件；更早的历史需要宿主提供 `xianshouFeed` 之类的回放接口。
5. **权限细化到模块级尚未做**。当前是"整块面板"级别；若要按模块授权（例如只允许看健康度），需要平台提供权限点清单后扩展。

---

## 11. 入口不出现时的排查顺序

按顺序走，一步否决一层，不要跳步。

### 第 0 步：先在本机跑自检

```bash
npm run doctor
```

它只回答一个问题：**问题在插件包这边，还是在宿主/安装那边**。全部 ✓ 说明包没问题，往下走；有 ✗ 就先修包。

### 第 1 步：插件是否进了 profile

```bash
dsh plugin --profile web list | grep xianshou
dsh --profile web --dump-config | grep -i xianshou
```

- 没有输出 → 装错了 profile（`headless` / `sdk` 没有客户端半边），或根本没装上。
- 有输出但没有 `client` 字样 → 宿主没识别到客户端半边，检查 `dsh.client.platform` 与 `exports["./client"]`。

### 第 2 步：是否重启过 `dsh web`

Web 端在**启动时**编译客户端包名单并写入 `window.__DSH_BOOT__`。只刷新浏览器，新装的插件不会出现。这是"没有入口"最常见的原因，没有之一。

```bash
# 停掉 dsh web，重新启动
dsh web
```

### 第 3 步：客户端文件是否真的被提供

浏览器 DevTools → Network，刷新页面，过滤 `client.js`：

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `/plugins/xianshou/client.js` 200 | 文件没问题 | 看第 4 步 |
| 404 | 宿主没找到文件（文件名或导出不对） | 确认文件叫 `client/client.js`，且 `exports["./client"]` 指向它 |
| 200 但 Console 报 `Cannot find module 'react'` | 半边被当成 ESM，或缺 CJS 边界 | 确认 `client/package.json` 里有 `{"type":"commonjs"}` |

命令行也可以直接验：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/plugins/xianshou/client.js
```

### 第 4 步：插件是否停在 pending

Cordis 的依赖注入规则是"服务不到、插件不加载"，而且**不报错**。Console 里看 `[xianshou]` 相关输出：

- 有 `控制台入口未注册：…` → 被 `access: "hidden"` 显式关掉了，改配置。
- 有 `cannot get property "x" without inject` → 插件在**启动期**读了没 inject 的服务属性。
  Cordis 的 Context 是 Proxy，这种读取会直接抛错并让整个 entry 不激活（连带九个工具一起消失）。
  0.2.2 已修（全部探测改为容错读 + `ctx.get()`），升级即可；自己写插件时同理：**不要猜着读 `ctx.xxx`，要读就用 `ctx.get('xxx')` 或先 inject**。
- 什么都没有 → 大概率卡在 `inject = ['slots']`：`slots` 服务没就绪。确认装的是 web profile，且宿主 ≥ 0.2.1-rc.1（更早版本没有槽位系统）。
- 有 `ReferenceError` / `TypeError` → 半边代码在真实环境里抛错，把首行错误贴进 issue。

### 第 5 步：入口是不是被折叠了

侧边栏放不下时，靠后的入口会进"更多"菜单。本插件用 `order = 1`（紧跟官方插件分组），正常不会被折叠。若你装了布局类插件（如 two-pane-sidebar），入口会出现在最左侧窄轨上，而不是主侧边栏。

### 第 6 步：宿主版本

| 宿主版本 | 结果 |
| --- | --- |
| < 0.2.1-rc.1 | 没有 `slots` / `sidebar.panellist`，插件不会加载 |
| 0.2.1-rc.1 ~ 0.2.x | 支持 |
| ≥ 0.3.0 | 未验证；需 `compat.allowUnverified`，且客户端槽位契约可能已变 |

### 一个反直觉的检查

如果入口在、点开显示"入口在，但内容被锁住了"——**这不是加载失败**。入口能出现就证明槽位注册生效了，缺的只是 `xianshou.view` 权限点。这种情况请让管理员授权，不要去重装插件。
