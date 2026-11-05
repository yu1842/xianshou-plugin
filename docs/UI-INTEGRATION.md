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
| `xianshou.view` | 能否看到入口与面板 | **不注册任何槽位**（入口不存在，而不是点进去 403） |
| `xianshou.operate` | 能否执行写操作 | 入口可见、面板可读、写按钮禁用并给出原因 |

### 4.2 判定顺序

```
1. 宿主权限服务（ctx.permissions / ctx.get('permissions'|'access'|'auth')，要求有 has()）
     → 有：以 has() 结果为准；has 抛错则按拒绝处理（fail closed）
2. 部署覆盖（apply 的 config.access = 'deny' | 'view' | 'operate'）
3. 都没有：按只读开放，并在页头与页脚明示"未检测到平台权限服务"
```

三条设计取舍：

- **只认 `has()`，不猜角色名**。不同部署的 role 命名不统一（owner / admin / operator / member），按名字猜一定会猜错。认不出就当没有权限服务。
- **`has()` 抛错按拒绝**。权限服务异常时放行，等于把"服务挂了"变成"人人可写"。
- **宿主判定优先于部署覆盖**。配置不能把被宿主拒绝的人放进来；只能收紧，不能放宽。

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
| 4. 权限控制 | `xianshou.view` / `xianshou.operate`；拒绝时不注册入口；写操作禁用并说明 | `test/client.logic.test.mjs`「权限」五条 |
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
