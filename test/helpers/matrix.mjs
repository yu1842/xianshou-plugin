import { FakeHarness } from './harness.mjs';

/**
 * 兼容矩阵运行器
 *
 * 一个"单元"= 某个宿主版本 × 某种接缝可用性。每个单元都跑同一条完整链路：
 * 挂载 → 建档 → 拦/放 → 落稿 → 留痕 → 交付 → 卸载。
 *
 * 为什么把矩阵单独抽成一个模块：测试与报告脚本必须跑同一份矩阵，
 * 否则"报告里的结论"和"测试证明的事实"会分叉。
 */

/** npm 上真实发布过的 0.2.1-rc.1 及以上版本，外加一个尚未发布的 0.2.2 正式版占位。 */
export const MATRIX_VERSIONS = [
  '0.2.1-rc.1',
  '0.2.1-rc.2',
  '0.2.1-rc.3',
  '0.2.1-rc.4',
  '0.2.1-rc.5',
  '0.2.2-alpha.2',
  '0.2.2-alpha.3',
  '0.2.2-rc.1',
  '0.2.2',
];

/** 接缝可用性组合。顺序即严重程度：越靠后，宿主能提供的越少。 */
export const MATRIX_PROFILES = [
  { id: 'full', label: '全部接缝可用', opts: {} },
  { id: 'no-guard', label: '缺少 tools.guard', opts: { noGuard: true } },
  { id: 'no-pre-execute', label: '缺少 tools/pre-execute', opts: { noEvents: true } },
  { id: 'no-session-state', label: '缺少会话状态读写', opts: { noState: true } },
  { id: 'no-emit', label: '缺少事件发送', opts: { noEmit: true } },
  { id: 'no-effect', label: '缺少 ctx.effect', opts: { noEffect: true } },
  { id: 'minimal', label: '最小宿主（仅工具注册）', opts: { noGuard: true, noEvents: true, noState: true, noEmit: true, noEffect: true } },
];

export function baseConfig(overrides = {}) {
  return {
    storage: { mode: 'memory' },
    gate: { mode: 'ask', tools: ['write'], requireTask: false },
    recall: { autoRemind: false, sweepMinutes: 0 },
    ...overrides,
  };
}

export async function runCell(version, profile) {
  const cell = {
    version,
    profile: profile.id,
    profileLabel: profile.label,
    ok: false,
    toolsRegistered: 0,
    gateDecision: 'n/a',
    gateAfterDraft: 'n/a',
    guardInstalled: false,
    capabilities: {},
    storage: '',
    leftovers: { tools: 0, guards: 0, preExecute: 0 },
    error: null,
  };

  const harness = new FakeHarness({ version, ...profile.opts });
  try {
    const runtime = harness.mount(baseConfig());
    await runtime.ready;
    cell.storage = runtime.repositoryKind;
    cell.capabilities = Object.fromEntries(runtime.capabilities.map((c) => [c.id, c.status]));
    cell.toolsRegistered = harness.toolNames().length;
    cell.guardInstalled = harness.guards.length > 0;

    harness.addHostTool('write');

    const start = await harness.dispatch('xianshou_start', {
      title: '兼容矩阵 · 红区任务',
      repeatable: true,
      within_competence: true,
      growth_relevant: true,
    });
    if (!start.value?.ok) throw new Error(`建档失败：${JSON.stringify(start.value)}`);
    const taskId = start.value.task_id;

    const firstWrite = await harness.dispatch('write', { path: 'x.ts' });
    cell.gateDecision = firstWrite.blocked ? firstWrite.decision.kind : 'allow';

    const draft = await harness.dispatch('xianshou_draft', {
      task_id: taskId,
      content:
        '1. 先固定契约：把订单、库存、支付三块边界写清楚，避免后面互相渗透。\n' +
        '2. 因为库存扣减是外部契约，所以先做防腐层，把契约留在适配器这一层。\n' +
        '3. 结论：迁移顺序是最大风险，先补集成测试，再动状态机。',
      minutes_spent: 23,
    });
    if (!draft.value?.ok) throw new Error(`落稿失败：${JSON.stringify(draft.value)}`);

    const secondWrite = await harness.dispatch('write', { path: 'x.ts' });
    cell.gateAfterDraft = secondWrite.blocked ? 'blocked' : 'allow';

    await harness.dispatch('xianshou_mark', { task_id: taskId, segment_id: 's1', tag: 'self', weight: 60 });
    await harness.dispatch('xianshou_mark', { task_id: taskId, segment_id: 's2', tag: 'ai', weight: 15 });
    const deliver = await harness.dispatch('xianshou_deliver', { task_id: taskId });
    if (!deliver.value?.ok) throw new Error(`交付失败：${JSON.stringify(deliver.value)}`);
    const health = await harness.dispatch('xianshou_health', {});
    if (!health.value?.ok) throw new Error('健康度报告失败');

    await harness.unload();
    cell.leftovers = harness.leftover();
    cell.ok = true;
  } catch (error) {
    cell.error = error instanceof Error ? error.message : String(error);
  }
  return cell;
}

export async function runMatrix(versions = MATRIX_VERSIONS, profiles = MATRIX_PROFILES) {
  const cells = [];
  for (const version of versions) {
    for (const profile of profiles) {
      cells.push(await runCell(version, profile));
    }
  }
  return cells;
}
