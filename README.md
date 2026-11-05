# dsh-plugin-xianshou · 先手协议

> 一个给 DeepSeek Harness 的插件：**不限制你用多少 AI，只规定它在什么时点介入。**
> 基于《先手协议 · 防认知债的 AI 使用方案》实现，适配 `>=0.2.1-rc.1 <0.3.0`。

---

## 它解决什么

AI 用得越顺，越容易跳过"自己想一遍"这一步，而这一步恰好是能力形成的地方。
MIT 媒体实验室的 EEG 研究把结果叫**认知债**：产出是你的，能力不是。

但同一条研究里有个少被引用的对照细节 —— **先独立构建框架、再用 AI 增强的组，未见认知损害**。
所以这套东西不禁止你用 AI，它拦的是"在你自己出过手之前就让 AI 替你决定结构"。

| 方案里的动作 | 插件里是什么 |
| --- | --- |
| 三区分流（红/黄/绿） | `xianshou_start` 三个问题定区 |
| 先手 20 分钟写丑版本 | 红区未落稿时，`tools/pre-execute` 拦下写入类工具 |
| 留痕 `[自]/[AI]/[改]` + 比例 | `xianshou_mark` 打标，`xianshou_audit` 出比例与判定 |
| 回收闸门（24h / 7d 三问） | 交付时生成闸门，到期推送；答不出打回重做 |
| 拒绝率 15%–40% | `xianshou_refusal` + 面板 |
| 四指标健康度 | `xianshou_health` |

---

## 快速开始

```bash
npm ci && npm run build

# 装进隔离 profile 试
dsh plugin --profile xs-test add file:/absolute/path/to/xianshou-plugin

# 确认真的生效，而不只是"列表里有名字"
dsh --profile xs-test --dump-config | grep -A5 xianshou
```

默认 `gate.mode = ask`：红区任务没落稿时弹审批而非直接拒绝。
想先观察两周再收紧，改成 `advisory`；想强约束（训练营），改成 `deny`。

零配置也能跑 —— 所有阈值都有默认值，省略即安全。

---

## 九个工具

| 工具 | 一句话 |
| --- | --- |
| `xianshou_start` | 建档并判区，三个判据必须由用户回答 |
| `xianshou_status` | 看单个任务或列全部 |
| `xianshou_draft` | 提交丑版本（不足 80 字且无结构会被拒） |
| `xianshou_mark` | 给段落打 `[自]/[AI]/[改]` |
| `xianshou_audit` | 算比例：`<30%` 正常 / `30–60%` 需回收 / `>60%` 打回重做 |
| `xianshou_deliver` | 交付并生成回收闸门 |
| `xianshou_recall` | 提交三问答案，`<80%` 打回黄区 |
| `xianshou_refusal` | 记录采纳 / 否决 / 部分修改 |
| `xianshou_health` | 四指标一起看，不给总分 |

卡片样例（真实渲染输出）见 [`docs/SAMPLE-OUTPUT.md`](docs/SAMPLE-OUTPUT.md)。

---

## 控制台（Web 端入口）

插件是双面包：宿主半边提供工具与闸门，客户端半边在 DSH 侧边栏挂一个「先手协议」入口，点开是一个整页面板。

- **入口**：`sidebar.panellist`，`order=1`，门框图标，随宿主主题变色；面板注册在 `main`（键控槽位，`key` 必须与入口 `id` 严格相等）
- **八个模块**：概览 / 任务台账 / 先手闸门 / 留痕账本 / 回收队列 / 拒绝率 / 健康度 / 设置
- **权限**：`xianshou.view` 决定入口是否注册，`xianshou.operate` 决定写操作是否可用；宿主没提供权限服务时按只读降级并在界面说明
- **路由**：面板内 hash 路由（`#xianshou/tasks/xs-7f21?zone=red`），刷新与前进后退都成立 —— 用 hash 是因为 DSH 前端对未知路径返回 404，不做 history fallback
- **响应式**：900 px 导航转横排、560 px 卡片两列；不使用 `:has()` / 容器查询 / `fixed` 定位

想看六种宽度下的真实渲染：

```bash
npm run preview     # 生成 docs/console-preview.html
```

细节（槽位契约、权限判定顺序、路由表、浏览器清单、限制）见 [`docs/UI-INTEGRATION.md`](docs/UI-INTEGRATION.md)。

## 架构一图

```
capabilities ──▶ application ──▶ domain        （规则层，零依赖）
      │               │
      └──────────▶ ports ◀────────── adapters   （接口在这里，实现也在，但方向相反）
                        ▲
                   plugin.ts 组合根
```

- `domain/` 不 import 本仓库其他层，也不 import `node:` 内置模块 —— 所以它能脱离宿主单测，也能被课程化定制复用。
- `plugin.ts` 是全仓库唯一 `new` 具体实现的地方（组合根的职责，不是违规）。
- 加一个工具 = 写一个 `XianshouTool` 子类 + 加进数组；加一条分区判据 = 加一个 `ZoneRule`；加一条宿主产品线 = 加一个 `HarnessAdapter` 子类。三件事都不需要改已有代码。

完整模块职责、SOLID 落点表、关键取舍见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 兼容性

声明范围 `>=0.2.1-rc.1 <0.3.0`，覆盖 npm 上真实发布过的 9 个版本 × 7 种接缝组合 = **63 个矩阵单元，全部通过**。

```bash
npm run test:compat    # 只跑矩阵（约 0.5 秒）
npm run test:report    # 重新生成 docs/COMPATIBILITY-REPORT.md
```

三层判定：`engines.dsh`（安装）→ `VersionGate`（加载）→ `CapabilityProbe`（运行期逐接缝降级）。
任何一层单独存在都不够，理由写在 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) §2。

> 矩阵覆盖 ≠ 真机实测。真机冒烟清单（含每条的通过判据）见同文档 §6。

---

## UI 规范

纸色底 + 墨色正文 + 赭石强调，与方案文档同一套版式语言；浅/深两套令牌；五种语义色各带独立符号，终端与色弱环境仍可区分。

令牌唯一真源 `src/ui/tokens.ts`，CSS 导出 `docs/ui-tokens.css` 由 `npm run tokens` 生成，**测试会断言两者不漂移**。

规范全文（组件、布局、交互、文案禁令、可访问性）见 [`docs/UI-SPEC.md`](docs/UI-SPEC.md)。

---

## 开发

```bash
npm run build        # tsc → dist/
npm test             # 构建 + 生成令牌 + 全量测试（115 个用例）
npm run test:compat  # 兼容矩阵
npm run test:report  # 生成兼容性报告
npm run tokens       # 重新导出设计令牌 CSS
npm run sample       # 重新生成卡片样例
npm run preview      # 重新生成控制台响应式对照页
```

```
src/
├── plugin.ts          组合根
├── config.ts          配置解析与容错
├── domain/            规则层（分区 / 丑版本 / 账本 / 回收 / 拒绝率 / 健康度 / 聚合根）
├── ports/             接口：时钟、仓储、宿主接缝、通知、日志
├── application/       用例编排 + 工具基类 + 九个工具
├── capabilities/      闸门 / 工具集 / 提醒
├── adapters/          宿主版本适配、存储四实现、通知、日志、工具定义编码
└── ui/                卡片 IR、令牌、主题、渲染器、六类视图
client/                客户端半边：侧边栏入口 + 整页面板（单文件 CJS）
test/                  领域 / 版本 / 集成 / 存储 / UI / 兼容矩阵 / 客户端
docs/                  架构、UI 规范、使用说明、兼容性、报告、样例
```

---

## 明确不做的事

对应方案原文的"三个不做"，这些是设计约束，不是暂未实现：

1. **不做时长限制**：证据不支持剂量假说，限时只会催生绕过，把可观测问题变成不可观测问题。
2. **不做全面禁用**：禁令换来的不是自控，是隐瞒。
3. **不用满意度/打卡率验收**：它们在这个议题上与真实能力负相关。

同样地，插件**不假装能测量你是否真的懂了**：回收判分默认走用户自评（0–2 分），因为"你没法假装自己记得"这一点只有本人能诚实回答。要更硬的判分，就换 `RecallScorer` 实现，而不是让模型给你打分。

---

## 许可

MIT
