# 使用说明 · dsh-plugin-xianshou

> 适用 DeepSeek Harness `>=0.2.1-rc.1 <0.3.0`
> 这个插件不限制你用多少 AI，只规定**它在什么时点介入**。

---

## 1. 它到底做什么

四件事，对应方案的四个动作：

1. **建档分流**：任务一进来就判红/黄/绿，判据只有三个问题（是否重复做、是否在能力圈内、是否与成长有关）。
2. **先手闸门**：红区任务没有"丑版本"时，拦下写入类工具调用。落稿才放行。
3. **来源留痕**：给段落打 `[自]/[AI]/[改]`，交付前算出比例，>60% 打回重做。
4. **回收闸门**：交付后 24 小时与 7 天各一次 3 分钟复述；答不出来，任务打回。

附带两个探针：**拒绝率面板**（你是在读，还是在点同意）与**健康度报告**（四个指标一起看）。

---

## 2. 安装

### 2.1 从本地目录安装（开发 / 内部分发）

```bash
# 先构建出 dist/
cd xianshou-plugin && npm ci && npm run build

# 装进某个 profile（建议先用隔离 profile 试）
dsh plugin --profile web add file:/absolute/path/to/xianshou-plugin
```

启用后检查是否真的生效，而不是只看"插件列表里有名字"：

```bash
dsh --profile web --dump-config | grep -A3 xianshou
```

### 2.2 从 npm 安装（发布后）

```bash
dsh plugin --profile web add dsh-plugin-xianshou
```

### 2.3 临时开发加载（不动 profile）

适合改代码时用。在仓库的 `cordis.yml` 里加：

```yaml
- insert:
    - id: xianshou
      name: '/absolute/path/to/xianshou-plugin/dist/plugin.js'
      config:
        gate:
          mode: advisory
```

```bash
dsh web --patch ./cordis.yml
```

> 路径必须是绝对路径。patch 只贡献配置，不改变 loader 的模块解析目录。

### 2.4 包内自带的 bundle patch

`dsh.patch.yml` 是给 `dsh.bundle.patch` 用的默认层，`dsh plugin add` 时会读取它。它只做一件事：把插件插进树。业务配置应写在**你自己的 profile patch** 里，不要改仓库里的这份。

---

## 3. 配置

配置全部可省略，省略即用安全默认值。非法值只会被忽略并记一条警告，不会导致插件不加载。

```yaml
- insert:
    - id: xianshou
      name: 'dsh-plugin-xianshou'
      config:
        gate:
          mode: ask              # advisory | ask | deny
          tools: [write, edit]   # 受约束的工具名
          requireTask: false     # true = 没有任务也拦（训练营场景）
        storage:
          mode: auto             # auto | session | file | memory
          directory: /data/xianshou   # 仅 file / auto 降级时使用
        compat:
          allowUnverified: false # 超出 engines.dsh 时是否放行
        ui:
          theme: auto            # auto | light | dark
          verbose: false         # 卡片附带判据 ID、调试信息
        recall:
          autoRemind: true
          sweepMinutes: 0        # 0 = 只在挂载时补扫
        thresholds:
          draftMinutes: 20
          aiRatioRecall: 0.3
          aiRatioRework: 0.6
```

### 3.1 闸门三种模式怎么选

| 模式 | 行为 | 适合谁 |
| --- | --- | --- |
| `advisory` | 不拦，但把"跳过"记进会话事件与日志 | 先观察两周，看看自己会被拦多少次再决定 |
| `ask`（默认） | 走宿主审批，用户可以临时放行 | 绝大多数人 |
| `deny` | 直接拒绝 + 单调守卫（不能被其他监听器改回） | 训练营、有明确承诺期的场景 |

选 `advisory` 是安全的起点：它对应方案的铁律 02「让跳过变得可见，而不是禁止跳过」。

### 3.2 阈值

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `draftMinutes` | 20 | 先手时长（工程取值，非实验结果） |
| `draftMinChars` | 80 | 丑版本最小字符数（三条判断形态可放宽到 40） |
| `aiRatioRecall` | 0.3 | 进入"需回收"的下界 |
| `aiRatioRework` | 0.6 | 打回重做的下界 |
| `selfRatioTarget` | 0.5 | 首版自主率目标 |
| `recallPassScore` | 0.8 | 回收及格线 |
| `recallWindowsHours` | `[24, 168]` | 回收窗口（小时） |
| `recallGraceHours` | 48 | 逾期宽限 |
| `refusalHealthyMin/Max` | 0.15 / 0.4 | 拒绝率健康区间 |
| `refusalBlindBelow` | 0.1 | 低于此值判"盲从" |
| `minSamples` | 5 | 判定所需最少样本 |

阈值自相矛盾（例如 `aiRatioRecall >= aiRatioRework`）时，插件会**回落默认值并报错到日志**，而不是带着坏规则运行。

---

## 4. 十三个工具

调用顺序即方案的动作顺序。模型通常会自动调用；你也可以直接要求它调。

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `xianshou_start` | 建档 + 判区 | `title`、`repeatable`、`within_competence`、`growth_relevant`、`reused_framework` |
| `xianshou_status` | 看状态 / 列全部 | `task_id`（可省） |
| `xianshou_draft` | 提交丑版本 | `task_id`、`content`、`minutes_spent`、`key_judgements[]` |
| `xianshou_mark` | 打来源标记 | `task_id`、`segment_id`、`tag`（self/ai/revised）、`label`、`weight` |
| `xianshou_audit` | 算比例并判定 | `task_id` |
| `xianshou_deliver` | 交付 + 生成回收闸门 | `task_id` |
| `xianshou_recall` | 提交回收答案 | `task_id`、`window`（d24h/d7d）、`answers[3]`、`self_report[3]` |
| `xianshou_refusal` | 记录采纳/否决 | `task_id`、`suggestion_id`、`decision`（accepted/rejected/partial） |
| `xianshou_health` | 四指标健康度 | 无 |
| `xianshou_export` | 导出周报 / 备份 | `format`（markdown/json/both）、`name`、`redact`、`overwrite` |
| `xianshou_import` | 从备份恢复 | `file`、`mode`（dry-run/merge/overwrite） |
| `xianshou_camp` | 四周训练营：开营 / 看进度 | `action`（start/status）、`label`、`weeks` |
| `xianshou_probe` | 记录一次裸考 | `kind`（baseline/exit）、`title`、`minutes`、`quality`、`ai_used` |

### 4.1 一次完整对话长什么样

```text
你：帮我重构订单模块，先搭个架子。

模型：这件事你以后还要重复做吗？现在能独立做出来吗？跟你的能力成长有关吗？
你：要重复做、能独立做、算成长。

模型 → xianshou_start(...)            → 判成红区，提示先花 20 分钟写丑版本
模型：（尝试调用 write）              → 被闸门拦下，弹出审批
你：我自己先写个提纲：
    1. 拆领域模型
    2. 因为库存扣减是外部契约，所以先做防腐层
    3. 结论：先补集成测试再迁状态机

模型 → xianshou_draft(content=...)    → 落稿通过，闸门放行
模型：（继续写代码 / 补文档）
模型 → xianshou_mark(sec-1, self)
     → xianshou_mark(sec-2, ai, weight=420)
模型 → xianshou_audit()               → [AI] 58%，建议先做回收再交付
模型 → xianshou_deliver()             → 生成 24h / 7d 两个回收闸门
```

24 小时后，插件会推送三个具体问题：核心逻辑是什么、最不确定哪一点、被反问靠什么答。

---

### 4.2 导出与恢复

**导出**（默认写到 `<cwd>/xianshou-export`）：

```text
xianshou_export(format="both", name="weekly-1106")
  → weekly-1106.md   可外发的周报（四指标 + 任务明细 + 校验值）
  → weekly-1106.json 可恢复的完整备份
```

- 默认**不覆盖**同名文件；要覆盖显式传 `overwrite: true`。
  这条不是洁癖：备份最常出的事故就是"第二次导出把第一次冲掉"。
- 要外发时先 `redact: true`：去掉先手稿正文与回收答案原文，**保留结构与全部指标**。
- 只导 `markdown` 时会明确提示"这不是可恢复的备份"。

**恢复**（默认 dry-run）：

```text
xianshou_import(file="weekly-1106.json")                  → 只报告会新增/覆盖/跳过几条
xianshou_import(file="weekly-1106.json", mode="merge")     → 只补缺失，同名跳过
xianshou_import(file="weekly-1106.json", mode="overwrite") → 备份优先，同名覆盖
```

- **只增不删**：恢复不会删除当前账本里的任何任务，所以"导错文件"不会毁掉现有的账。
- 备份文件按字段校验：版本高于插件 → 明确拒绝，不猜着读；JSON 坏了 → 报"不是合法的 JSON"并**不写入任何东西**。
- `file` 可以写归档目录里的文件名，也可以写绝对路径（恢复旧机器上的备份用）。

**可验证凭据**：报表末尾会写 `sha256(archive.json) = …`。对同名 `.json` 算一次 SHA-256，值一致说明这份备份没被改过。归档文件是可以被编辑的，凭据让"没被改过"可验证 —— 这不是防篡改，是防"你以为是原版"。

### 4.3 四周训练营

```text
xianshou_camp(action="start", label="2026 秋 · 第 1 期")
xianshou_camp(action="status")          → 第几天、哪一周、该做什么
xianshou_probe(kind="baseline", title="写一份需求说明", minutes=100, quality=80, ai_used=false)
xianshou_probe(kind="exit",     title="同难度任务",     minutes=110, quality=76, ai_used=false)
```

四周安排（`status` 会按天数自动告诉你现在该做哪一段）：

| 周 | 做什么 | 插件侧动作 |
| --- | --- | --- |
| W1 | 不用 AI，独立完成一个真实小任务，记耗时与质量 | `xianshou_probe kind=baseline` |
| W2 | 每天一个红区任务，严格 20 分钟先手 | 正常 `xianshou_start` → `xianshou_draft` |
| W3 | 强制 24h / 7d 双回收，记录通过率 | `xianshou_recall` |
| W4 | 撤掉 AI 做同难度任务，与基线对比 | `xianshou_probe kind=exit` |

**验收不给感觉分，只给两个比值**：质量 ≥ 基线的 90%、耗时增幅 ≤ 20%。
三档结论：`通过` / `部分达标`（一个达标一个不达标，会指明是哪边）/ `未通过`。

四条硬规则，都是为了让验收还能算数：

- `ai_used: true` 直接拒绝 —— 用了 AI 的产出是"AI 的基线"，不是你的。
- **基线只能记一次**。能重来就没有"脱离测试"了。
- 脱离测试要等到**第 21 天**；提前测的是"学习中的你"，两次数据不可比。确有补录需求可传 `force: true`，结果会被标注为不可横向比较。
- 训练营是单例：一轮没走完不能开新的，否则等于悄悄重置基线。

质量分怎么打？前后两次必须用**同一把尺子**（例如：能直接用 60，同事能看懂 80，不用返工 90）。这件事插件替不了你 —— 它只能保证两个数字被如实记录、并按公式判定。

---

## 5. 常见问题

**Q：它会不会限制我用 AI 的次数？**
不会。方案里没有"时长上限"，因为证据不支持剂量假说，而且限时只会催生绕过（换设备、换账号），把可观测的问题变成不可观测的问题。

**Q：为什么绿区任务完全不拦？**
判据是"是否重复做"，不是"是否重要"。一件重要但只做一次的事，快速用 AI 完成没有代价 —— 它不构成你的能力资产。强制先手只会让这套东西退化成道德要求。

**Q：答不出回收问题会怎样？**
任务打回黄区、状态置 `rework`，需要重做一次先手，且同一窗口不能重答。没有例外 —— 这是整套方案里唯一无法伪造的动作。

**Q：我的数据存在哪？**
默认 `storage.mode=auto`：宿主有会话状态接口就写会话状态，否则写 `<cwd>/.xianshou/tasks/*.json`（每个任务一个文件，原子写入）。设为 `memory` 则只在内存中，退出即失。

**Q：它会不会读到我的代码内容？**
不会扫描仓库。它只处理你显式提交的丑版本、段落标记与回收答案。`xianshou_mark` 的 `weight` 建议用字符数，但插件不读取文档本身。

**Q：能不装 UI 只用机制吗？**
可以。所有卡片都是 `output.render` 的产物，工具返回值里同时带结构化字段（`zone`、`ai_ratio`、`band`、`verdict`），你可以自行消费。

**Q：怎么临时放行一次闸门？**
`ask` 模式下批准审批即可。想长期不被打断，把 `gate.mode` 改成 `advisory` —— 但请先跑两周看看跳过频率，那个数字通常比预期高。

---

## 6. 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 插件加载失败，提示"超出 engines.dsh 范围" | 宿主版本不在 `>=0.2.1-rc.1 <0.3.0` | 升级宿主，或临时 `compat.allowUnverified: true` |
| 工具注册了但闸门不拦 | 宿主缺 `tools/pre-execute`，闸门能力被跳过 | 看启动日志里的 `capabilities: gate:skipped` |
| `deny` 模式仍能被放行 | 宿主缺 `ctx.tools.guard`，只剩 pre-execute 拦截 | 日志会明确警告；这是宿主能力限制，不是配置问题 |
| 提醒不出现 | 会话内 `sweepMinutes=0` 且未重启 | 重启会补扫；或设 `sweepMinutes: 5` |
| 任务列表为空但文件里有 json | `storage.mode=session` 与文件不通用 | 统一存储模式 |
| 日志出现"存储降级" | 目录不可写 | 修权限，或改 `storage.mode: memory` 接受不持久化 |
| 配置写了没生效 | 写在了错误层（home patch / bundle patch） | 配置写在 profile patch；`bundle` 只负责插入 |

启动日志里会有一行能力摘要，排障先看它：

```
[xianshou] 已挂载 { version: '0.2.1-rc.1', adapter: 'dsh-0.2.x', verdict: 'allow',
  repository: 'session-state+migrating+resilient',
  capabilities: 'gate:applied toolset:applied reminder:applied' }
```

---

## 7. 卸载与回滚

```bash
dsh plugin --profile web remove dsh-plugin-xianshou
```

- 卸载不会删除已写入的任务数据（会话状态随会话保留；文件在 `storage.directory`）。
- 想彻底清空：删掉 `<cwd>/.xianshou/` 或对应的会话状态键（`xianshou.*`）。
- 回滚到旧版本：`dsh plugin --profile web add dsh-plugin-xianshou@0.1.0`，数据版本是向后兼容读的（`schemaVersion` 只升不降，未来版本数据会 fail closed 而不是被猜着读）。

---

## 8. 给二次开发的接口

```ts
import { mount, DefaultThresholdPolicy, MemoryTaskRepository, ManualClock } from 'dsh-plugin-xianshou';

// 在测试或 SDK 里用你自己的仓储/时钟装配
const runtime = mount({
  ctx: fakeCtx,
  config: { storage: { mode: 'memory' } },
  clock: new ManualClock('2026-11-05T09:00:00Z'),
});
await runtime.ready;   // 等缓存水合完成
```

- `mount()` 返回 `{ version, adapterId, capabilities, repositoryKind, degraded, ready }`，便于断言降级结果。
- 领域层（`ZoneClassifier`、`SourceLedger`、`LedgerPolicy`、`RecallPolicy`）可脱离宿主单独使用，做课程化定制时不必启动 Harness。

完整模块职责见 `docs/ARCHITECTURE.md`。
