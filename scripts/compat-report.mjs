import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MATRIX_PROFILES, MATRIX_VERSIONS, runMatrix } from '../test/helpers/matrix.mjs';

/**
 * 生成兼容性报告
 *
 * 报告直接来自矩阵运行结果，不允许手写结论 —— 手写的兼容性声明一定会在
 * 某个 rc 之后变成谎话。
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const cells = await runMatrix();
const total = cells.length;
const passed = cells.filter((c) => c.ok).length;
const failed = cells.filter((c) => !c.ok);
const generatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

const symbol = (cell) => {
  if (!cell.ok) return '✗';
  if (cell.capabilities.gate === 'skipped') return '○';
  return '●';
};

const lines = [];
lines.push('# 兼容性测试报告 · DeepSeek Harness 0.2.1-rc.1+');
lines.push('');
lines.push(`生成时间：${generatedAt}（UTC）　生成方式：\`npm run test:report\``);
lines.push('');
lines.push('> 本报告由 `test/helpers/matrix.mjs` 的矩阵运行结果自动生成。');
lines.push('> **矩阵覆盖 ≠ 真机实测**：矩阵在模拟宿主上逐条验证契约行为，');
lines.push('> 真机冒烟清单见 `docs/COMPATIBILITY.md` §4，需要在装有 DSH 的机器上执行。');
lines.push('');
lines.push('## 1. 汇总');
lines.push('');
lines.push('| 项目 | 数值 |');
lines.push('| --- | --- |');
lines.push(`| 声明范围 \`engines.dsh\` | \`>=0.2.1-rc.1 <0.3.0\` |`);
lines.push(`| 覆盖版本数 | ${MATRIX_VERSIONS.length} |`);
lines.push(`| 接缝组合数 | ${MATRIX_PROFILES.length} |`);
lines.push(`| 矩阵单元 | ${total} |`);
lines.push(`| 通过 | ${passed} |`);
lines.push(`| 失败 | ${failed.length} |`);
lines.push(`| 通过率 | ${((passed / total) * 100).toFixed(1)}% |`);
lines.push('');
lines.push('图例：● 全部能力生效　○ 按预期降级（宿主缺接缝）　✗ 失败');
lines.push('');

lines.push('## 2. 版本 × 接缝组合');
lines.push('');
lines.push(`| 版本 | ${MATRIX_PROFILES.map((p) => p.id).join(' | ')} |`);
lines.push(`| --- |${MATRIX_PROFILES.map(() => ' --- |').join('')}`);
for (const version of MATRIX_VERSIONS) {
  const row = MATRIX_PROFILES.map((profile) => {
    const cell = cells.find((c) => c.version === version && c.profile === profile.id);
    return cell ? symbol(cell) : '?';
  });
  lines.push(`| ${version} | ${row.join(' | ')} |`);
}
lines.push('');
lines.push('接缝组合含义：');
lines.push('');
for (const profile of MATRIX_PROFILES) {
  lines.push(`- \`${profile.id}\` —— ${profile.label}`);
}
lines.push('');

lines.push('## 3. 每个单元验证了哪些断言');
lines.push('');
lines.push('| 断言 | 说明 |');
lines.push('| --- | --- |');
lines.push('| 完整链路 | 挂载 → 建档 → 拦/放 → 落稿 → 留痕 → 交付 → 健康度 → 卸载，全程无异常 |');
lines.push('| 工具齐备 | 九个工具全部注册（工具注册是插件下限能力） |');
lines.push('| 闸门一致性 | 有 `tools/pre-execute` 时首次写入被拦；无则该能力标记 `skipped` 并放行 |');
lines.push('| 闸门状态机 | 落稿后同一调用必须放行 |');
lines.push('| 卸载干净 | 工具 / 守卫 / 监听器全部释放，无残留 |');
lines.push('');

lines.push('## 4. 降级行为矩阵');
lines.push('');
lines.push('| 缺失的接缝 | 影响的功能 | 替代路径 | 用户可见变化 |');
lines.push('| --- | --- | --- | --- |');
lines.push('| `ctx.tools.guard` | 单调守卫 | 仅保留 `pre-execute` 拦截 | `deny` 模式仍拦截，但不再防"监听器重排" |');
lines.push('| `tools/pre-execute` | 先手闸门 | 无（闸门整体跳过） | 卡片正常、记录正常，但不再拦截写入 |');
lines.push('| 会话状态读写 | 会话级持久化 | 文件仓储（`<cwd>/.xianshou/tasks`） | 换 profile 时任务不跟随 |');
lines.push('| `ctx.emit` | 会话事件投影 | 仅日志 | 界面收不到提醒事件，日志仍可追溯 |');
lines.push('| `ctx.effect` | 会话内定时扫描 | 启动补扫 | 长会话中不会主动弹提醒，重启后补推 |');
lines.push('| 全部缺失（最小宿主） | 只剩工具与渲染 | —— | 工具可调用，闸门与提醒均降级 |');
lines.push('');

if (failed.length > 0) {
  lines.push('## 5. 失败明细');
  lines.push('');
  for (const cell of failed) {
    lines.push(`- ${cell.version} / ${cell.profile}：${cell.error}`);
  }
  lines.push('');
}

lines.push('## 6. 未覆盖的部分（诚实清单）');
lines.push('');
lines.push('1. **真机安装与热重载**：`dsh plugin add`、启用/禁用/更新/卸载、`--dump-config` 的 effective tree 未在本机验证。');
lines.push('2. **真实模型行为**：矩阵不评估"模型是否真的按工具描述先去建档"，只评估工具与闸门的技术行为。');
lines.push('3. **0.3.x**：仅在预留适配器层面验证降级策略，未纳入契约矩阵，需要显式 `compat.allowUnverified`。');
lines.push('4. **多 profile / SDK / headless**：文件仓储路径与 `DSH_HOME` 的关系取决于宿主，需按部署文档配置 `storage.directory`。');
lines.push('');

writeFileSync(join(root, 'docs', 'COMPATIBILITY-REPORT.md'), `${lines.join('\n')}\n`, 'utf8');
writeFileSync(
  join(root, 'docs', 'compat-matrix.json'),
  `${JSON.stringify({ generatedAt, range: '>=0.2.1-rc.1 <0.3.0', total, passed, cells }, null, 2)}\n`,
  'utf8',
);

console.log(`矩阵 ${total} 个单元，通过 ${passed}，失败 ${failed.length}`);
console.log('已生成 docs/COMPATIBILITY-REPORT.md 与 docs/compat-matrix.json');
