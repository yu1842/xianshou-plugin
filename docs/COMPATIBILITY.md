# 兼容性说明 · DeepSeek Harness 0.2.1-rc.1 及以上

> 结论先说：**声明范围内 9 个版本 × 7 种接缝组合 = 63 个矩阵单元，全部通过。**
> 但"矩阵覆盖"不等于"真机实测"，两者的差别写在 §5，请连着一起读。

---

## 1. 声明范围

```json
"engines": { "dsh": ">=0.2.1-rc.1 <0.3.0" }
```

- **下界含预发布**：`0.2.1-rc.1` 本身可用。它引入了本插件依赖的四类接缝（`ctx.tools.register`、`ctx.tools.guard`、`tools/pre-execute`、会话状态读写）。
- **上界不含 0.3.0**：跨 minor 的破坏性变更不可预测。0.3.x 走"显式放行 + 主动降级"路径，见 §3。
- 为什么不用 `>=0.2.1-rc.1`（无上界）：无上界等于承诺一个没验证过的未来。宁可在 0.3.0 上明确拒绝加载，也不要"加载成功但闸门静默失效"——后者会让用户以为机制在工作。

---

## 2. 三层判定

| 层 | 位置 | 作用 | 失效时的行为 |
| --- | --- | --- | --- |
| 安装层 | `package.json engines.dsh` | 宿主拒绝安装不兼容版本 | 装不上，错误信息来自 plugin manager |
| 加载层 | `VersionGate` | 判定 `allow` / `allow-degraded` / `blocked` | `blocked` 抛错并写日志；`allow-degraded` 警告后继续 |
| 运行层 | `CapabilityProbe` + `Capability.install()` | 逐个接缝探测，缺则只降级对应能力 | 该能力标 `skipped`，其余照常 |

三层缺一不可：

- 只有 engines → 漏掉同 minor 内的行为漂移（例如某个 rc 改了 `pre-execute` 的决策语义）。
- 只有探测 → 会被"方法还在但签名变了"骗到。所以 `HarnessAdapter.resolve()` 会在能力安装抛错时把该能力降级，而不是让整个插件崩。
- 只有运行层 → 用户会在 0.3.0 上"看起来装好了"，但闸门可能从没生效。

---

## 3. 支持层级

| 层级 | 含义 | 加载行为 |
| --- | --- | --- |
| `contract-verified` | 已纳入契约测试矩阵，全链路逐条验证 | 正常加载 |
| `declared` | 在 `engines.dsh` 内，但未纳入矩阵（多为 alpha / 尚未发布的正式版） | 加载并告警，跑最小冒烟 |
| `provisional` | 超出声明范围 | 默认拒绝；`compat.allowUnverified: true` 后降级加载 |

### 3.1 版本清单

数据源：`src/adapters/harness/support-matrix.ts`（单一真源，测试会校验没有"默认可信"的版本）。

| 版本 | 层级 | 说明 |
| --- | --- | --- |
| `0.2.1-rc.1` | contract-verified | 基线；下界 |
| `0.2.1-rc.2` ~ `rc.5` | contract-verified | 同产品线，接缝一致 |
| `0.2.2-alpha.2` / `alpha.3` | declared | 预发布不承诺稳定 |
| `0.2.2-rc.1` | contract-verified | 接缝与 0.2.1 一致 |
| `0.2.2`（正式版） | declared | 发布后按 rc 结论外推，需补一次真机冒烟 |
| `0.2.x` 后续补丁 | declared | 保持 engines 范围 |
| `0.3.x` | provisional | 需显式放行，且关闭危险接缝 |

### 3.2 0.2.1 → 0.2.2 之间与本插件相关的变更

| 变更 | 对本插件的影响 |
| --- | --- |
| 插件自定义源、Agent 辅助创建插件 | 无（只影响分发渠道） |
| 启用/禁用/更新时同步依赖、热重载 | 有（卸载必须干净，见矩阵断言"卸载无残留"） |
| 实验性会话状态记录接口 | 有（`SessionStateRepository` 依赖它；缺失时降级到文件） |
| 自定义模型推理档位 | 无 |
| 工具展示模式移除 `both`，只留 `native` / `ptc` | 无（本插件只用 `output.render`，不依赖展示模式） |
| 子代理工具立即返回子 ID | 无（不涉及子代理） |

---

## 4. 降级矩阵

| 缺失的接缝 | 受影响功能 | 替代路径 | 用户可见变化 |
| --- | --- | --- | --- |
| `ctx.tools.register` | 全部工具 | 无 | 插件只做提醒，实际不可用（此情况引擎层已拒绝） |
| `ctx.tools.guard` | 单调守卫 | 仅 `pre-execute` | `deny` 模式仍拦截，但不再防"监听器重排" |
| `tools/pre-execute` | 先手闸门 | 无 | 卡片与记录正常，但不再拦截写入 |
| 会话状态读写 | 会话级持久化 | 文件仓储 `<cwd>/.xianshou/tasks` | 换 profile 时任务不跟随 |
| `ctx.emit` | 会话事件投影 | 仅日志 | 界面收不到提醒事件，日志可追溯 |
| `ctx.effect` | 会话内定时扫描 | 启动补扫 | 长会话不主动弹提醒，重启补推 |

**降级不是静默的**：每次降级都会写一条 `warn`，并在启动摘要里体现为 `gate:skipped` 这类标记。

---

## 5. 已覆盖 vs 未覆盖（诚实清单）

### 5.1 已覆盖（自动化，可重复跑）

`npm test` / `npm run test:report` 自动验证：

1. 9 个版本 × 7 种接缝组合的完整链路（挂载 → 建档 → 拦/放 → 落稿 → 留痕 → 交付 → 健康度 → 卸载）。
2. 闸门行为与 `pre-execute` 可用性严格一致（有则拦、无则 `skipped` 且放行）。
3. 落稿后必须放行（闸门是状态机，不是常闭门）。
4. 卸载后工具 / 守卫 / 监听器零残留。
5. semver 预发布排序（`rc.1 < rc.2 < rc.10 < 0.2.1`）、范围判定、`^0.2.1` 上界为 `0.3.0`。
6. 存储四实现同契约、原子写、路径穿越、`v1 → v2` 迁移、未来版本 fail-closed。

结果见 `docs/COMPATIBILITY-REPORT.md`（自动生成）与 `docs/compat-matrix.json`（原始数据）。

### 5.2 未覆盖（必须真机做）

1. **安装 / 启用 / 禁用 / 更新 / 卸载的真实行为**与 `--dump-config` 的 effective tree。
2. **热重载**：插件更新后是否真的替换成功，还是提示重启。
3. **真实模型的遵从度**：模型是否真的按工具描述"先建档再动手"。矩阵只验技术行为，不验模型行为。
4. **0.3.x**：只验证了降级策略，未纳入矩阵。
5. **多 profile / SDK / headless** 下 `storage.directory` 的实际可写位置。
6. **0.2.2 正式版**（本文写作时尚未发布）。

---

## 6. 真机冒烟清单（在装有 DSH 的机器上执行）

每条都给了"通过判据"，避免"看起来没报错"被当成通过。

### 6.1 安装与加载

```bash
dsh plugin --profile xs-test add file:/abs/path/to/xianshou-plugin
dsh --profile xs-test --dump-config | grep -A5 xianshou
```

- [ ] 输出里出现 `id: xianshou`，且 `name` 指向本包
- [ ] 启动日志出现 `[xianshou] 已挂载`，`version` 与宿主一致
- [ ] 摘要里 `capabilities` 至少包含 `toolset:applied`

### 6.2 工具可见性

- [ ] 在会话里问"你有哪些 xianshou 工具"，应能列出 9 个
- [ ] 直接调用 `xianshou_health`，应返回一张"认知债健康度"卡片（全是"样本不足"，不出现 0%）

### 6.3 闸门

```text
1. 让模型检查：xianshou_start(title="冒烟测试", repeatable=true, within_competence=true, growth_relevant=true)
2. 让模型写一个文件
```

- [ ] 第一次写入被拦：`ask` 模式应弹审批，拒绝后不产生文件
- [ ] `xianshou_draft` 提交一段 100 字以上带 1./2./3. 的内容后再写，应直接放行
- [ ] 把 `gate.mode` 改成 `deny` 重启后，同一路径应直接拒绝而不是弹窗

### 6.4 持久化与重启

- [ ] `xianshou_deliver` 后重启宿主，`xianshou_status` 仍能看到两个待回收窗口
- [ ] 把系统时间（或 `startTime`）推进 25 小时再启动，应收到 24 小时回收提醒
- [ ] 若日志出现 `存储降级`，检查 `storage.directory` 是否可写

### 6.5 卸载

```bash
dsh plugin --profile xs-test remove dsh-plugin-xianshou
```

- [ ] 工具从会话中消失
- [ ] 无残留监听器报错（宿主日志无 `pre-execute` 相关异常）

---

## 7. 升级与回归流程

升级宿主版本时按此顺序走，不要跳步：

1. 在 `support-matrix.ts` 加新版本条目，选好层级。
2. 在 `test/helpers/matrix.mjs` 的 `MATRIX_VERSIONS` 加同一版本 —— **两处必须同步**，`compat.matrix.test.js` 会校验 engines 范围与矩阵一致。
3. `npm test`，确认 63 → 70 个单元全绿。
4. `npm run test:report` 重新生成报告，diff 里应该只多出新列。
5. 在隔离 profile 上跑 §6 的真机清单。
6. 真机通过后，才把层级从 `declared` 提升为 `contract-verified`。

回滚：

- 插件回滚：`dsh plugin add dsh-plugin-xianshou@<旧版本>`。
- 数据回滚：**不需要**。`TaskSnapshot.schemaVersion` 只升不降；新版写入的数据被旧版读到会 fail closed（明确报错），而不是被猜着解析 —— 这比"静默丢字段"安全。

---

## 8. 兼容性相关的测试入口

```bash
npm test              # 全量：领域 + 版本 + 集成 + 存储 + UI + 矩阵
npm run test:compat   # 只跑矩阵
npm run test:report   # 生成 docs/COMPATIBILITY-REPORT.md 与 compat-matrix.json
```

矩阵单次全跑约 0.5 秒，足够放进每次提交。
