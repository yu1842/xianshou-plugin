# 架构设计 · dsh-plugin-xianshou

> 目标版本：DeepSeek Harness `>=0.2.1-rc.1 <0.3.0`
> 本文回答四个问题：分成哪些层、层之间谁能依赖谁、为什么这么切、加东西时该动哪里。

---

## 1. 一句话架构

**把"防认知债方案"切成三层：不依赖任何东西的规则层、只依赖接口的编排层、唯一知道宿主长什么样的适配层。**

```
┌──────────────────────────────────────────────────────────────┐
│  plugin.ts  ·  组合根（唯一 new 具体实现的地方）              │
└───────────────┬──────────────────────────────────────────────┘
                │ 装配
      ┌─────────┴──────────┬──────────────────┐
      ▼                    ▼                  ▼
┌──────────────┐   ┌────────────────┐  ┌─────────────────────┐
│ capabilities │   │  application   │  │  adapters           │
│ 能力单元      │──▶│ 用例与工具      │─▶│ 宿主 / 存储 / 通知   │
└──────┬───────┘   └───────┬────────┘  └──────────┬──────────┘
       │                   │                      │
       │                   ▼                      │
       │            ┌──────────────┐              │
       └───────────▶│    domain    │◀─────────────┘
                    │ 纯规则与实体  │  （只被依赖，不依赖别人）
                    └──────────────┘
                             ▲
                    ┌────────┴────────┐
                    │   ports 端口     │  接口在这里，实现在上面
                    └─────────────────┘
```

依赖方向只有一条：**capabilities → application → domain**，以及 **adapters → ports ← application**。
`domain/` 目录下没有任何 `import` 指向本仓库其他层，也没有 `node:` 内置模块。

---

## 2. 模块划分与职责边界

| 目录 | 职责 | 不允许做的事 |
| --- | --- | --- |
| `domain/` | 三区分级、丑版本校验、来源账本、回收判定、拒绝率、健康度 | 读写文件、发射事件、认识 `ctx`、认识 Markdown |
| `ports/` | 时钟、仓储、宿主接缝、通知、日志的**接口** | 出现任何 `new` 具体实现 |
| `application/` | 用例编排（建档/落稿/标记/审计/交付/回收），工具基类 | 直接拼卡片文本、直接调宿主 API |
| `capabilities/` | 把用例接到宿主接缝上（闸门、工具集、提醒） | 实现业务规则 |
| `adapters/` | 宿主版本适配、仓储实现、通知实现、日志实现、工具定义编码 | 实现业务规则 |
| `ui/` | 卡片 IR、设计令牌、主题、渲染器、视图 | 访问仓储、判断阈值 |
| `plugin.ts` | 组合根：读配置 → 版本闸门 → 选适配器 → 装能力 | 写业务逻辑 |

### 2.1 分层内的文件清单

```
src/
├── plugin.ts                 组合根：apply() / mount() / detectHostVersion()
├── config.ts                 配置解析与容错
├── index.ts                  公共 API 表面
├── domain/
│   ├── model.ts              值对象、品牌类型、DomainError
│   ├── policy.ts             ThresholdPolicy + 默认值 + 自洽校验
│   ├── zone.ts               四条分区规则 + 兜底规则 + 分类器
│   ├── draft.ts              丑版本规则链
│   ├── ledger.ts             SourceLedger 值对象 + LedgerPolicy
│   ├── recall.ts             回收问题、评分策略、闸门构造
│   ├── refusal.ts            RefusalPanel
│   ├── health.ts             四指标报告
│   └── task.ts               TaskRecord 聚合根 + 快照
├── ports/
│   ├── time.ts               Clock / IdGenerator（含测试替身）
│   ├── repository.ts         TaskRepository / StateStore / Migration
│   ├── host.ts               HostBridge 与各接缝接口
│   └── observability.ts      Logger / Notifier
├── application/
│   ├── TaskService.ts        加载→变更→保存 + 领域事件
│   ├── TaskCache.ts          同步镜像（给同步守卫用）
│   ├── tool-base.ts          工具模板方法 + 统一失败形状
│   ├── args.ts               入参校验与 JSON Schema 片段生成
│   ├── views.ts              视图容器
│   └── tools/
│       ├── task-tools.ts     start / status / draft
│       ├── ledger-tools.ts   mark / audit / deliver
│       └── review-tools.ts   recall / refusal / health
├── capabilities/
│   ├── Capability.ts         能力基类（依赖声明 + 降级）
│   ├── GateCapability.ts     先手闸门
│   ├── ToolsetCapability.ts  十四个工具
│   └── ReminderCapability.ts 到期提醒
├── adapters/
│   ├── harness/
│   │   ├── version.ts        semver 解析 / 比较 / 范围（含预发布排序）
│   │   ├── support-matrix.ts 版本 → 支持层级
│   │   ├── version-gate.ts   加载闸门
│   │   ├── probe.ts          能力探测 + ctx 结构化视图
│   │   ├── adapter.ts        适配器抽象 + 0.2.x / 0.3.x
│   │   ├── registry.ts       适配器选择
│   │   └── tool-encoder.ts   唯一翻译 ToolDefinition 的地方
│   ├── storage/              memory / file / session-state / resilient / migrating / artifacts / documents
│   ├── hash/                 SHA-256（导出盖章）
│   ├── notify/               会话通知器
│   └── observability/        控制台日志器
└── ui/
    ├── card.ts               CardModel / CardNode IR
    ├── tokens.ts             设计令牌（唯一真源）+ CSS 导出
    ├── theme.ts              主题解析
    ├── renderer.ts           Markdown / Plain 渲染器
    ├── format.ts             时间格式化
    └── views/                六类卡片
```

---

## 3. 核心数据流

### 3.1 一次工具调用

```
模型发起 xianshou_mark
  → ToolDefinitionEncoder.execute(args, exec)
  → XianshouTool.invoke()           校验形状 / 检查取消信号
  → MarkSegmentTool.run()           取参数
  → TaskService.load(id)            仓储 → TaskRecord.restore()
  → task.markSegment()              领域规则（红区必须已有初稿）
  → TaskService.save(task)          快照落盘 + 发布 task.saved
  → LedgerPolicy.judge(tally)       阈值判定
  → LedgerCard.marked(...)          生成 CardModel
  → 返回 { ok, ...payload, card }
  → output.render(args, value)      CardModel → ContentBlock[]
```

关键点：**`execute` 只返回 value，`render` 只吃 `(args, value)`**。宿主的 `render` 是同步纯函数，因此卡片模型必须随 value 一起返回（`value.card`）。这不是冗余，是为了满足"可重放"契约 —— 回放会话时不需要重新执行业务逻辑。

### 3.2 闸门拦截

```
宿主 dispatch 一个写入类工具
  → tools/pre-execute 瀑布（我们的 handler）
      → TaskCache.pendingDraft()      同步镜像快速判断
      → TaskService.load()            权威数据
      → ask / deny / allow
  → （deny 模式）单调守卫再检查一次   同步，读镜像
  → 工具体执行
```

为什么要有 `TaskCache`：`ctx.tools.guard()` 的守卫签名是**同步**的，仓储是异步的。守卫不能 await，所以必须有一份同步可读的镜像。误差窗口被限制在一次写库往返内；守卫只做最后一道单调防线，权威判断仍在异步的 pre-execute 里。这个取舍写进了 `TaskCache` 的注释，不要"优化"掉。

### 3.3 回收提醒

```
任务交付 → buildRecallGates() → gates[].scheduledFor 随任务落盘
插件挂载 → ReminderCapability.#sweep()   ← 补推重启期间到期的
会话内   → ctx.effect(setInterval(sweep)) ← 仅加速，卸载即释放
```

**定时器不是调度器。** 权威到期时间是持久化的 `scheduledFor`，最坏后果从"提醒永久丢失"降级为"下次启动补上"。

---

## 4. 面向对象原则的落点

原则不是写在文档里的口号，每一项都指到具体代码。评估一个新改动是否符合架构，就看它是否破坏了这张表。

| 原则 | 落点 | 反例（会被评审挡下） |
| --- | --- | --- |
| 封装 | `TaskRecord` 的 `#draft` / `#ledger` 全部私有，只能通过 `submitDraft()` / `markSegment()` / `deliver()` 改状态 | 在工具里直接改 `task.snapshot.draft = ...` |
| 继承 | `HarnessAdapter`、`XianshouTool`、`Capability`、`DraftRule`、`ZoneRule` | 复制粘贴一个 `StartTaskTool2` |
| 多态 | `TaskRepository` 四种实现、`RecallScorer` 两种策略、`CardRenderer` 两种渲染器、`ZoneRule` 五条规则 | 在调用处写 `if (repo.kind === 'file')` |
| 单一职责 | `SourceLedger` 只记账，`LedgerPolicy` 只判阈值；`GateCard` 只排版，`GateCapability` 只决策 | 让账本自己决定"要不要重做" |
| 开闭 | 新增分区判据 = 新增 `ZoneRule`；新增能力 = 新增 `Capability` 子类并加入 `CAPABILITIES` | 在 `classify()` 里加 `if (newCase)` |
| 里氏替换 | 四种仓储跑同一套契约测试；`AdapterV0300` 只降级不减契约 | 让 `MemoryTaskRepository.list()` 返回 `null` |
| 接口隔离 | `Clock` / `Notifier` / `Logger` / `TaskRepository` / `StateStore` 各自独立；`HostBridge` 的每个接缝都是可选 | 造一个 20 方法的 `Context` 大接口 |
| 依赖倒置 | `application/` 只 import `ports/`；`plugin.ts` 是唯一 `new` 具体实现的地方 | 工具里 `new JsonFileRepository()` |

### 4.1 依赖倒置的边界在哪

`plugin.ts` 必须知道具体类型，否则没法装配 —— 这是组合根的职责，不是违规。判断标准：**除 `plugin.ts` 外，任何文件出现 `new JsonFileRepository(...)` / `new AdapterV0201(...)` 都算破坏架构。**

---

## 5. 关键设计决策与权衡

| 决策 | 选择 | 放弃的方案 | 理由 |
| --- | --- | --- | --- |
| 卡片渲染挂点 | `output.render` | `presentCall` / `presentResult` | 后两者的返回结构（`ToolCallView` / `ToolResultView`）在 0.2.x 仍是 pre-stable；`render` 的 `(args, value) → ContentBlock[]` 更稳。少一个炫技挂点，换跨版本存活率 |
| 拦截落点 | `tools/pre-execute` + 可选 `guard` | 只在 pre-execute 拦 | pre-execute 是可重排瀑布，不是最终安全边界。`deny` 模式必须再挂单调守卫 |
| 卡片形态 | 会话内 Markdown | 自定义结构化块 | 所有宿主都渲染 Markdown；自定义块形状会随版本漂移 |
| 阈值 | 可注入的 `ThresholdPolicy` | 常量 | 方案原文说阈值"需在真实场景中校准"，写死等于拒绝校准 |
| 回收判分 | 自评优先 + 结构兜底 | 让模型自动判"你懂没懂" | 模型判分不可审计、且把 AI 又塞回了回收环节 |
| 存储 | 会话状态 → 文件 → 内存 三级 | 只用文件 | SDK / headless 下会话状态未必可用；只读 profile 下文件也未必可写 |
| 版本兼容 | `engines.dsh` 硬范围 + 分层矩阵 | 声明"支持所有版本" | 见 §7 |

---

## 6. 扩展指南

### 6.1 加一个工具（最常见）

1. 在 `application/tools/*.ts` 写一个继承 `XianshouTool` 的类，实现 `name` / `description` / `parameters` / `run()`。
2. 在 `ToolsetCapability.#tools()` 的数组里加进去。
3. 在 `test/plugin.test.js` 的工具清单断言里加名字。

不需要改：适配器、编码器、任何 `if`。工具数从 9 变 10，闸门与提醒照常工作。

### 6.2 加一条分区判据

写一个 `ZoneRule` 实现（`priority` 决定插在哪），在构造 `ZoneClassifier` 时传入。已有的四条规则不动。`test/domain.test.js` 里已有一例演示这种做法。

### 6.3 加一条宿主产品线（例如 0.4.x）

1. `adapters/harness/adapter.ts` 里继承 `AdapterV0201`，覆写 `id` / `productLine` / `range` / `degrade()`。
2. `registry.ts` 的默认数组里加进去。
3. `support-matrix.ts` 加条目，`test/version.test.js` 的 `MATRIX_VERSIONS` 加版本。
4. 跑 `npm run test:report`，把新列补进报告。

### 6.4 改阈值默认值

只改 `domain/policy.ts` 的 `DEFAULTS`。所有视图、判定、报告自动跟随 —— 因为阈值只有一份。

---

## 7. 版本兼容策略

三层判定，缺一不可：

```
package.json  engines.dsh   →  宿主拒绝安装（硬边界）
version-gate  VersionGate   →  加载时判定 allow / allow-degraded / blocked
capability    CapabilityProbe → 运行期逐个接缝探测，缺则降级对应能力
```

任何一层单独存在都不够：只有 engines 会漏掉同 minor 内的行为漂移；只有探测会在语义变了但方法还在时被骗（"存在但签名变了"比"不存在"更危险，所以 `HarnessAdapter.resolve()` 会兜住首次调用异常并把能力降级）。

支持层级与降级矩阵的完整说明见 `docs/COMPATIBILITY.md`，矩阵结果见 `docs/COMPATIBILITY-REPORT.md`。

---

## 8. 已知限制（必须承认的）

1. **闸门依赖缓存镜像**：`guard` 是同步的，缓存更新有一次写库往返的误差窗口。极端并发下可能漏拦一次，随后由 pre-execute 补齐。
2. **丑版本校验只是近似**：字符数 + 结构/判断数无法真正判断"别人看了能不能看懂"。这只能提高敷衍成本，不能消灭敷衍。方案本身也承认这一点（"闸门必须放在输出端"）。
3. **回收自评可自欺**：默认判分依赖用户自评的 0–2 分。这是有意为之 —— 插件不假装能测量你是否真的懂了。要更硬，就换 `RecallScorer` 实现（例如接入一次客观小测），而不是让模型打分。
4. **表现层是渐进增强**：`output.render` 在所有版本可用，但卡片在不同 UI 下的排版由宿主决定。
5. **多任务并发语义简单**：闸门只认"最近一个欠稿的红区任务"，不支持父子任务树。

---

## 9. 测试策略

| 层 | 测试文件 | 断言重点 |
| --- | --- | --- |
| 领域 | `test/domain.test.js` | 阈值边界、状态迁移、错误码、方案文档与常量一致性 |
| 版本 | `test/version.test.js` | 预发布排序、范围判定、闸门三分支、适配器选择 |
| 集成 | `test/plugin.test.js` | 挂载/卸载、闸门三模式、完整闭环、取消、降级、配置容错 |
| 存储 | `test/storage.test.js` | 四仓储同契约、原子写、路径穿越、迁移、fail-closed |
| UI | `test/ui.test.js` | 渲染确定性、令牌与 CSS 同步、文案禁令、空数据不编数字 |
| 兼容矩阵 | `test/compat.matrix.test.js` | 9 版本 × 7 接缝组合 = 63 单元的全链路 |

新增能力的验收标准：**至少能被这六类测试中的一类覆盖**，并且不破坏其余五类。
