import test from 'node:test';
import assert from 'node:assert/strict';

import { MATRIX_PROFILES, MATRIX_VERSIONS, runCell } from './helpers/matrix.mjs';

/**
 * 全量兼容性矩阵
 *
 * 判定口径（写在这里，避免"跑绿了"被当成"全都支持"）：
 *   1. 每个单元的完整链路都必须跑通，不许抛错
 *   2. 九个工具必须全部注册（工具注册是插件的下限能力）
 *   3. 闸门行为必须与 pre-execute 接缝的可用性严格一致：
 *      有 pre-execute → 首次写入被拦；没有 → 放行且能力标记为 skipped
 *   4. 落稿之后必须放行（闸门是状态机，不是常闭门）
 *   5. 卸载后不得残留任何工具 / 守卫 / 监听器
 */

test('兼容矩阵：所有版本 × 所有接缝组合都能完成完整链路，且行为可预测', async () => {
  const failures = [];
  for (const version of MATRIX_VERSIONS) {
    for (const profile of MATRIX_PROFILES) {
      const cell = await runCell(version, profile);
      const tag = `${version} / ${profile.id}`;
      if (!cell.ok) {
        failures.push(`${tag} 抛错：${cell.error}`);
        continue;
      }
      if (cell.toolsRegistered !== 14) failures.push(`${tag} 只注册了 ${cell.toolsRegistered} 个工具`);
      if (cell.gateAfterDraft !== 'allow') failures.push(`${tag} 落稿后仍被拦（${cell.gateAfterDraft}）`);
      if (cell.leftovers.tools !== 0 || cell.leftovers.guards !== 0 || cell.leftovers.preExecute !== 0) {
        failures.push(`${tag} 卸载后残留 ${JSON.stringify(cell.leftovers)}`);
      }
      const hasPreExecute = profile.opts.noEvents !== true;
      if (hasPreExecute) {
        if (cell.gateDecision === 'allow') failures.push(`${tag} 红区无初稿却放行`);
        if (cell.capabilities.gate !== 'applied') failures.push(`${tag} 闸门能力未生效：${cell.capabilities.gate}`);
      } else {
        if (cell.gateDecision !== 'allow') failures.push(`${tag} 无 pre-execute 却拦截了调用`);
        if (cell.capabilities.gate !== 'skipped') failures.push(`${tag} 闸门并未降级：${cell.capabilities.gate}`);
      }
      if (cell.capabilities.toolset !== 'applied') failures.push(`${tag} 工具集未生效`);
      if (cell.capabilities.reminder === undefined) failures.push(`${tag} 提醒能力未上报`);
    }
  }
  assert.deepEqual(failures, []);
});

test('兼容矩阵：0.2.1-rc.1 与最新的 0.2.2 线在同一接缝组合下行为完全一致', async () => {
  const baseline = '0.2.1-rc.1';
  const latest = MATRIX_VERSIONS[MATRIX_VERSIONS.length - 1];
  for (const profile of MATRIX_PROFILES) {
    const a = await runCell(baseline, profile);
    const b = await runCell(latest, profile);
    assert.equal(a.ok, b.ok);
    assert.equal(a.gateDecision, b.gateDecision, `${profile.id} 的闸门行为在 ${baseline} 与 ${latest} 之间发生了漂移`);
    assert.equal(a.gateAfterDraft, b.gateAfterDraft);
    assert.equal(a.guardInstalled, b.guardInstalled);
    assert.deepEqual(a.capabilities, b.capabilities);
  }
});

test('兼容矩阵：单一矩阵单元耗时在 1 秒内（回归成本足够低，能进每次提交）', async () => {
  const started = process.hrtime.bigint();
  await runCell('0.2.1-rc.1', MATRIX_PROFILES[0]);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 1000, `单个单元耗时 ${ms.toFixed(0)}ms，超过 1 秒`);
});

test('兼容矩阵：版本声明与实际覆盖的版本集合一致（engines 不能比矩阵宽）', async () => {
  const { AdapterRegistry, MemoryLogger, satisfies } = await import('../dist/index.js');
  const registry = new AdapterRegistry();
  const logger = new MemoryLogger();
  for (const version of MATRIX_VERSIONS) {
    const adapter = registry.select(version, logger);
    assert.ok(adapter.supports(version), `${version} 被矩阵覆盖却没有适配器认领`);
    assert.ok(satisfies(version, '>=0.2.1-rc.1 <0.3.0'), `${version} 超出 engines.dsh 声明`);
  }
});
