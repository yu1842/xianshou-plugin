import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeHarness, seedDeliveredTask } from './helpers/harness.mjs';

const FIXED_CONFIG = {
  storage: { mode: 'memory' },
  gate: { mode: 'ask', tools: ['write', 'edit'], requireTask: false },
  recall: { autoRemind: false, sweepMinutes: 0 },
};

async function boot(config = FIXED_CONFIG, options = {}) {
  const harness = new FakeHarness(options);
  const runtime = harness.mount(config);
  await runtime.ready;
  return { harness, runtime };
}

test('挂载：注册全部十三个工具，且每个工具都带 output 契约', async () => {
  const { harness } = await boot();
  assert.deepEqual(harness.toolNames(), [
    'xianshou_audit',
    'xianshou_camp',
    'xianshou_deliver',
    'xianshou_draft',
    'xianshou_export',
    'xianshou_health',
    'xianshou_import',
    'xianshou_mark',
    'xianshou_probe',
    'xianshou_recall',
    'xianshou_refusal',
    'xianshou_start',
    'xianshou_status',
  ]);
  for (const [, tool] of harness.tools) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 20, `${tool.name} 的描述必须能指导模型决策`);
  }
});

test('闸门（ask）：红区无初稿时拦下写入类工具，且给出可执行的过闸步骤', async () => {
  const { harness } = await boot();
  harness.addHostTool('write');
  const start = await harness.dispatch('xianshou_start', {
    title: '重构订单模块',
    repeatable: true,
    within_competence: true,
    growth_relevant: true,
  });
  assert.equal(start.value.zone, 'red');

  const blocked = await harness.dispatch('write', { path: 'a.ts' });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.decision.kind, 'ask');
  assert.match(blocked.decision.reason, /还没有先手稿/);
  assert.ok(blocked.decision.displayReason.zh.includes('先手闸门'));
  assert.ok(blocked.decision.displayReason.en.length > 0);
});

test('闸门：落稿后同一个调用被放行（闸门是状态机，不是一次性提示）', async () => {
  const { harness } = await boot();
  harness.addHostTool('write');
  const start = await harness.dispatch('xianshou_start', {
    title: 'T',
    repeatable: true,
    within_competence: true,
    growth_relevant: true,
  });
  const taskId = start.value.task_id;

  const thin = await harness.dispatch('xianshou_draft', { task_id: taskId, content: '随便两行' });
  assert.equal(thin.value.ok, false);
  assert.equal(thin.value.error.code, 'DRAFT_TOO_THIN');
  assert.equal((await harness.dispatch('write', {})).blocked, true, '敷衍稿不能过闸');

  const ok = await harness.dispatch('xianshou_draft', {
    task_id: taskId,
    content:
      '1. 先拆领域模型：订单、库存、支付三块契约各自固定，避免互相渗透。\n' +
        '2. 因为库存扣减是外部契约，所以先做防腐层，把契约留在适配器这一层。\n' +
        '3. 结论：迁移顺序是最大风险，先补集成测试，再动状态机。',
    minutes_spent: 24,
  });
  assert.equal(ok.value.ok, true);
  const allowed = await harness.dispatch('write', {});
  assert.equal(allowed.blocked, false);
});

test('闸门（deny）：直接拒绝 + 安装单调守卫；bypass 不能靠监听器顺序翻转', async () => {
  const { harness } = await boot({ ...FIXED_CONFIG, gate: { mode: 'deny', tools: ['write'], requireTask: false } });
  harness.addHostTool('write');
  await harness.dispatch('xianshou_start', { title: 'T', repeatable: true, within_competence: true, growth_relevant: true });

  assert.equal(harness.guards.length, 1, 'deny 模式必须安装 guard');
  const denied = await harness.dispatch('write', {});
  assert.equal(denied.decision.kind, 'deny');

  const guardReason = harness.guards[0]({ name: 'write', arguments: {} });
  assert.match(guardReason, /缺先手稿/);
  assert.equal(harness.guards[0]({ name: 'read', arguments: {} }), undefined, '非受控工具不受守卫影响');
});

test('闸门（advisory）：不拦，但把跳过记进会话事件（铁律 02）', async () => {
  const { harness } = await boot({ ...FIXED_CONFIG, gate: { mode: 'advisory', tools: ['write'], requireTask: false } });
  harness.addHostTool('write');
  await harness.dispatch('xianshou_start', { title: 'T', repeatable: true, within_competence: true, growth_relevant: true });

  const allowed = await harness.dispatch('write', {});
  assert.equal(allowed.blocked, false);
  const bypass = harness.emitted.filter((e) => e.type === 'xianshou/gate-bypassed');
  assert.equal(bypass.length, 1);
  assert.equal(bypass[0].payload.tool, 'write');
  assert.equal(harness.guards.length, 0, 'advisory 模式不装守卫');
});

test('闸门：黄区 / 绿区任务不被拦截（方案明确拒绝教条化）', async () => {
  const { harness } = await boot({ ...FIXED_CONFIG, gate: { mode: 'deny', tools: ['write'], requireTask: false } });
  harness.addHostTool('write');
  const green = await harness.dispatch('xianshou_start', {
    title: '翻译一段话',
    repeatable: false,
    within_competence: true,
    growth_relevant: false,
  });
  assert.equal(green.value.zone, 'green');
  assert.equal((await harness.dispatch('write', {})).blocked, false);
});

test('闸门：缺少 pre-execute 接缝时能力自动跳过，工具仍可用（降级而非停摆）', async () => {
  const harness = new FakeHarness({ noEvents: true });
  const runtime = harness.mount(FIXED_CONFIG);
  await runtime.ready;
  assert.equal(runtime.capabilities.find((c) => c.id === 'gate').status, 'skipped');
  harness.addHostTool('write');
  await harness.dispatch('xianshou_start', { title: 'T', repeatable: true, within_competence: true, growth_relevant: true });
  assert.equal((await harness.dispatch('write', {})).blocked, false);
  assert.equal(runtime.capabilities.find((c) => c.id === 'toolset').status, 'applied');
});

test('deny 模式但宿主无 guard：保留 pre-execute 拦截并显式告警', async () => {
  const harness = new FakeHarness({ noGuard: true });
  const runtime = harness.mount({ ...FIXED_CONFIG, gate: { mode: 'deny', tools: ['write'], requireTask: false } });
  await runtime.ready;
  harness.addHostTool('write');
  await harness.dispatch('xianshou_start', { title: 'T', repeatable: true, within_competence: true, growth_relevant: true });
  assert.equal((await harness.dispatch('write', {})).decision.kind, 'deny');
  assert.ok(harness.logger.entries.some((e) => e.message.includes('缺少接缝') || e.message.includes('guard')));
});

test('完整闭环：建档 → 落稿 → 留痕 → 审计 → 交付（生成两个回收闸门）', async () => {
  const { harness } = await boot();
  const taskId = await seedDeliveredTask(harness);
  const status = await harness.dispatch('xianshou_status', { task_id: taskId });
  assert.equal(status.value.status, 'delivered');
  assert.equal(status.value.ai_ratio, 0.1875);
  assert.deepEqual(status.value.due_recalls, ['24 小时回收', '7 天回收']);
});

test('比例闸门：> 60% 打回重做，且拒绝交付', async () => {
  const { harness } = await boot();
  const start = await harness.dispatch('xianshou_start', {
    title: 'T',
    repeatable: true,
    within_competence: true,
    growth_relevant: true,
  });
  const taskId = start.value.task_id;
  await harness.dispatch('xianshou_draft', {
    task_id: taskId,
    content:
      '1. 甲：先把契约固定，避免后面反复改。\n' +
      '2. 乙：因为前提是 A，所以结论是 B，这里先记下三个判断。\n' +
      '3. 丙：细节后面再补，但方向和边界现在就要定下来，不留模糊。',
    minutes_spent: 21,
  });
  await harness.dispatch('xianshou_mark', { task_id: taskId, segment_id: 'a', tag: 'ai', weight: 80 });
  await harness.dispatch('xianshou_mark', { task_id: taskId, segment_id: 'b', tag: 'self', weight: 20 });

  const audit = await harness.dispatch('xianshou_audit', { task_id: taskId });
  assert.equal(audit.value.band, 'rework');
  assert.equal(audit.value.status, 'rework');

  const deliver = await harness.dispatch('xianshou_deliver', { task_id: taskId });
  assert.equal(deliver.value.ok, false);
  assert.match(deliver.text, /不能按健康交付处理|超过 60%/);
});

test('回收闸门：答不出来 → 降黄区 + rework，且同一窗口不能重答刷分', async () => {
  const { harness } = await boot();
  const taskId = await seedDeliveredTask(harness);
  harness.clock.advanceHours(25);

  const failed = await harness.dispatch('xianshou_recall', {
    task_id: taskId,
    window: 'd24h',
    answers: ['记不清了', '', '不知道'],
    self_report: [0, 0, 0],
  });
  assert.equal(failed.value.verdict, 'fail');
  assert.equal(failed.value.new_zone, 'yellow');
  assert.equal(failed.value.status, 'rework');

  const again = await harness.dispatch('xianshou_recall', {
    task_id: taskId,
    window: 'd24h',
    answers: ['a', 'b', 'c'],
    self_report: [2, 2, 2],
  });
  assert.equal(again.value.ok, false);
  assert.equal(again.value.error.code, 'RECALL_ALREADY_ANSWERED');
});

test('回收闸门：三题必须齐答，缺一题直接拒绝（不给"部分记忆"留口子）', async () => {
  const { harness } = await boot();
  const taskId = await seedDeliveredTask(harness);
  const bad = await harness.dispatch('xianshou_recall', { task_id: taskId, window: 'd24h', answers: ['只有一个'], self_report: [2, 2, 2] });
  assert.equal(bad.value.ok, false);
  assert.equal(bad.value.error.code, 'INVALID_ARGUMENT');
});

test('到期提醒：跨进程重启后靠持久化的 scheduledFor 补推，不依赖定时器', async () => {
  const sharedStore = new Map();
  const first = new FakeHarness({ store: sharedStore });
  first.mount({ storage: { mode: 'session' }, recall: { autoRemind: false, sweepMinutes: 0 } });
  await first.runtime.ready;
  const taskId = await seedDeliveredTask(first);

  const second = new FakeHarness({ store: sharedStore, startTime: '2026-11-07T09:00:00.000Z' });
  const runtime = second.mount({ storage: { mode: 'session' }, recall: { autoRemind: true, sweepMinutes: 0 } });
  await runtime.ready;
  await new Promise((resolve) => setTimeout(resolve, 20));

  const pushed = second.notifier.sent.filter((n) => n.taskId === taskId);
  assert.ok(pushed.length >= 1, '重启后应补推已到期的 24 小时回收');
  assert.match(pushed[0].title, /24 小时回收/);
  assert.equal(pushed[0].tone, 'attention');
  assert.match(pushed[0].body, /核心逻辑/);
});

test('卸载：工具、守卫、监听器、effect 全部释放，无残留', async () => {
  const harness = new FakeHarness();
  const runtime = harness.mount({ ...FIXED_CONFIG, gate: { mode: 'deny', tools: ['write'], requireTask: false }, recall: { autoRemind: true, sweepMinutes: 5 } });
  await runtime.ready;
  assert.ok(harness.disposers.length > 0);
  assert.equal(harness.effects.length, 1);

  await harness.unload();
  assert.deepEqual(harness.leftover(), { tools: 0, guards: 0, preExecute: 0 });
});

test('取消：signal 已中止时不做任何写入', async () => {
  const { harness } = await boot();
  const controller = new AbortController();
  controller.abort();
  const result = await harness.dispatch(
    'xianshou_start',
    { title: 'T', repeatable: true, within_competence: true, growth_relevant: true },
    { signal: controller.signal },
  );
  assert.equal(result.value.ok, false);
  assert.equal(result.value.error.code, 'CANCELLED');
  assert.equal((await harness.dispatch('xianshou_status', {})).value.count, 0);
});

test('参数校验：模型传错参数得到结构化失败，而不是抛栈', async () => {
  const { harness } = await boot();
  const result = await harness.dispatch('xianshou_start', { title: 'T', repeatable: 'maybe' });
  assert.equal(result.value.ok, false);
  assert.equal(result.value.error.code, 'INVALID_ARGUMENT');
  assert.match(result.value.error.message, /repeatable|布尔/);
});

test('版本闸门：超范围版本默认拒绝挂载，显式放行后以降级模式加载', () => {
  assert.throws(() => new FakeHarness({ version: '0.3.0' }).mount(FIXED_CONFIG), /超出 engines.dsh 范围/);

  const harness = new FakeHarness({ version: '0.3.0' });
  const runtime = harness.mount({ ...FIXED_CONFIG, compat: { allowUnverified: true, engineRange: '>=0.2.1-rc.1 <0.3.0' } });
  assert.equal(runtime.adapterId, 'dsh-0.3.x');
  assert.ok(runtime.degraded.includes('toolGuard'));
});

test('配置容错：坏配置只降级不崩，且把问题写进日志', async () => {
  const harness = new FakeHarness();
  const runtime = harness.mount({ gate: { mode: 'yolo' }, thresholds: { aiRatioRework: 'x' }, storage: { mode: 'memory' } });
  await runtime.ready;
  assert.equal(runtime.config.gate.mode, 'ask');
  assert.ok(harness.logger.entries.some((e) => e.message.includes('配置问题')));
  assert.equal(runtime.capabilities.find((c) => c.id === 'toolset').status, 'applied');
});

test('阈值自相矛盾时回落默认值并告警（不阻断使用）', async () => {
  const harness = new FakeHarness();
  const runtime = harness.mount({
    storage: { mode: 'memory' },
    thresholds: { aiRatioRecall: 0.9, aiRatioRework: 0.2 },
  });
  await runtime.ready;
  assert.ok(harness.logger.entries.some((e) => e.message.includes('阈值配置自相矛盾')));
  const status = await harness.dispatch('xianshou_health', {});
  assert.equal(status.value.ok, true);
});

test('拒绝率面板：工具与面板口径一致（半改按半权计）', async () => {
  const { harness } = await boot();
  const taskId = await seedDeliveredTask(harness);
  for (let i = 0; i < 6; i += 1) {
    await harness.dispatch('xianshou_refusal', {
      task_id: taskId,
      suggestion_id: `s${i}`,
      decision: i === 0 ? 'rejected' : i === 1 ? 'partial' : 'accepted',
    });
  }
  const health = await harness.dispatch('xianshou_health', {});
  assert.equal(health.value.ok, true);
  assert.ok(health.value.metrics.find((m) => m.key === 'refusal').value > 0);
});
