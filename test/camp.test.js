import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DefaultThresholdPolicy,
  createCamp,
  evaluateCamp,
  recordProbe,
  dayOf,
  MemoryDocumentStore,
  FileDocumentStore,
  MemoryLogger,
} from '../dist/index.js';
import { FakeHarness } from './helpers/harness.mjs';

const policy = new DefaultThresholdPolicy();
const DAY = 86_400_000;
const start = new Date('2026-11-01T09:00:00Z');
const at = (days) => new Date(start.getTime() + days * DAY);

function camp() {
  return createCamp({ id: 'camp-1', label: '测试营', now: start });
}

function baseline(c = camp(), overrides = {}) {
  return recordProbe(
    c,
    { kind: 'baseline', title: '写一份需求说明', minutes: 100, quality: 80, aiUsed: false, at: at(1), ...overrides },
    policy,
  ).camp;
}

// ── 阶段判定 ──────────────────────────────────────────

test('训练营：四个阶段的判定与"该做什么"按天数推进', () => {
  const c = camp();
  assert.equal(dayOf(c, at(0)), 1);
  assert.equal(evaluateCamp(c, at(0), policy).phase, 'awaiting-baseline');

  const withBaseline = baseline();
  assert.equal(evaluateCamp(withBaseline, at(2), policy).phase, 'drill');
  assert.equal(evaluateCamp(withBaseline, at(9), policy).phase, 'recall');
  const late = evaluateCamp(withBaseline, at(22), policy);
  assert.equal(late.phase, 'awaiting-exit');
  assert.equal(late.readyForExit, true);
  assert.match(late.nextStep, /xianshou_probe kind=exit/);
});

test('训练营：还没到第 21 天时不宣布"可以脱离测试"', () => {
  const withBaseline = baseline();
  const early = evaluateCamp(withBaseline, at(15), policy);
  assert.equal(early.readyForExit, false);
  assert.match(early.nextStep, /还差/);
});

// ── 裸考的硬约束 ──────────────────────────────────────

test('训练营：用了 AI 的"裸考"被拒绝，理由说清为什么', () => {
  assert.throws(
    () => recordProbe(camp(), { kind: 'baseline', title: 'T', minutes: 60, quality: 70, aiUsed: true, at: at(1) }, policy),
    (error) => error.code === 'INVALID_ARGUMENT' && /不能使用 AI/.test(error.message),
  );
});

test('训练营：基线只能记一次（允许重来就没有脱离测试了）', () => {
  const withBaseline = baseline();
  assert.throws(
    () => recordProbe(withBaseline, { kind: 'baseline', title: 'T2', minutes: 50, quality: 90, aiUsed: false, at: at(3) }, policy),
    /基线已经记录过/,
  );
});

test('训练营：没有基线不能做脱离测试', () => {
  assert.throws(
    () => recordProbe(camp(), { kind: 'exit', title: 'T', minutes: 60, quality: 80, aiUsed: false, at: at(22) }, policy),
    /没有基线就没有对照/,
  );
});

test('训练营：第 21 天前做脱离测试被拒绝，force 可补录但会带警示', () => {
  const withBaseline = baseline();
  assert.throws(
    () => recordProbe(withBaseline, { kind: 'exit', title: 'T', minutes: 80, quality: 80, aiUsed: false, at: at(10) }, policy),
    /要等到第 21 天/,
  );
  const forced = recordProbe(
    withBaseline,
    { kind: 'exit', title: 'T', minutes: 80, quality: 80, aiUsed: false, at: at(10), force: true },
    policy,
  );
  assert.equal(forced.warnings.length, 1);
  assert.match(forced.warnings[0], /不可与他人横向比较/);
});

test('训练营：脱离测试只能记一次', () => {
  const withBaseline = baseline();
  const exited = recordProbe(
    withBaseline,
    { kind: 'exit', title: 'T', minutes: 80, quality: 80, aiUsed: false, at: at(22) },
    policy,
  ).camp;
  assert.throws(
    () => recordProbe(exited, { kind: 'exit', title: 'T2', minutes: 70, quality: 85, aiUsed: false, at: at(24) }, policy),
    /已经记录过/,
  );
});

test('训练营：耗时与质量分会被校验，不接受离谱值', () => {
  assert.throws(
    () => recordProbe(camp(), { kind: 'baseline', title: 'T', minutes: 0, quality: 80, aiUsed: false, at: at(1) }, policy),
    /耗时必须是/,
  );
  assert.throws(
    () => recordProbe(camp(), { kind: 'baseline', title: 'T', minutes: 60, quality: 120, aiUsed: false, at: at(1) }, policy),
    /质量评分必须是 0–100/,
  );
});

// ── 验收 ──────────────────────────────────────────────

function graduated(exit) {
  const base = baseline();
  return recordProbe(
    base,
    { kind: 'exit', title: '同难度任务', minutes: exit.minutes, quality: exit.quality, aiUsed: false, at: at(22) },
    policy,
  ).camp;
}

test('验收：质量 ≥ 90% 且耗时 ≤ +20% 判通过', () => {
  const evaluation = evaluateCamp(graduated({ minutes: 110, quality: 75 }), at(23), policy);
  assert.equal(evaluation.verdict, 'pass');
  assert.equal(evaluation.qualityRatio, 0.9375);
  assert.equal(evaluation.timeRatio, 1.1);
  assert.match(evaluation.detail, /质量 94%/);
  assert.match(evaluation.detail, /耗时 \+10%/);
});

test('验收：一个达标一个不达标判 partial，且指出是哪一边', () => {
  const slow = evaluateCamp(graduated({ minutes: 150, quality: 80 }), at(23), policy);
  assert.equal(slow.verdict, 'partial');
  assert.match(slow.headline, /变慢/);

  const worse = evaluateCamp(graduated({ minutes: 100, quality: 60 }), at(23), policy);
  assert.equal(worse.verdict, 'partial');
  assert.match(worse.headline, /质量掉了/);
});

test('验收：两项都不达标判未通过，并给出"别急着重开"的下一步', () => {
  const evaluation = evaluateCamp(graduated({ minutes: 160, quality: 55 }), at(23), policy);
  assert.equal(evaluation.verdict, 'fail');
  assert.match(evaluation.headline, /未通过/);
  assert.match(evaluation.nextStep, /表演学习/);
});

// ── 文档存储 ──────────────────────────────────────────

test('存储：内存文档存储的读未写键返回 null 而不是抛错', async () => {
  const store = new MemoryDocumentStore();
  assert.equal(await store.read('nope'), null);
  await store.write('a', { x: 1 });
  assert.deepEqual(await store.read('a'), { x: 1 });
  await store.remove('a');
  assert.equal(await store.read('a'), null);
});

test('存储：文件文档存储可往返，损坏文件按不存在处理', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'xs-docs-'));
  try {
    const logger = new MemoryLogger();
    const store = new FileDocumentStore(dir, logger);
    assert.equal(await store.read('xianshou.camp.default'), null);
    await store.write('xianshou.camp.default', { id: 'c1' });
    assert.deepEqual(await store.read('xianshou.camp.default'), { id: 'c1' });

    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8');
    assert.equal(await store.read('broken'), null, '坏文件不能让插件起不来');
    assert.ok(logger.entries.some((e) => e.message.includes('文档读取失败')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 工具链路 ──────────────────────────────────────────

async function boot() {
  const harness = new FakeHarness();
  harness.mount({ storage: { mode: 'memory' }, recall: { autoRemind: false, sweepMinutes: 0 } });
  await harness.runtime.ready;
  return harness;
}

test('工具：没开营时 status 给出可执行的下一步', async () => {
  const harness = await boot();
  const result = await harness.dispatch('xianshou_camp', { action: 'status' });
  assert.equal(result.value.ok, false);
  assert.match(result.value.error.hint, /action=start/);
});

test('工具：开营 → 记基线 → 记脱离测试，全链路走通', async () => {
  const harness = await boot();
  const started = await harness.dispatch('xianshou_camp', { action: 'start', label: '第 1 期' });
  assert.equal(started.value.ok, true);
  assert.equal(started.value.weeks, 4);

  const base = await harness.dispatch('xianshou_probe', {
    kind: 'baseline',
    title: '写需求说明',
    minutes: 100,
    quality: 80,
    ai_used: false,
  });
  assert.equal(base.value.ok, true);
  assert.equal(base.value.phase, 'drill');

  harness.clock.advanceHours(22 * 24);
  const exit = await harness.dispatch('xianshou_probe', {
    kind: 'exit',
    title: '同难度任务',
    minutes: 110,
    quality: 76,
    ai_used: false,
  });
  assert.equal(exit.value.ok, true);
  assert.equal(exit.value.verdict, 'pass');

  const status = await harness.dispatch('xianshou_camp', { action: 'status' });
  assert.equal(status.value.verdict, 'pass');
  assert.match(status.text, /脱离测试通过/);
});

test('工具：重复开营被拒绝，避免中途重置基线', async () => {
  const harness = await boot();
  await harness.dispatch('xianshou_camp', { action: 'start' });
  const again = await harness.dispatch('xianshou_camp', { action: 'start' });
  assert.equal(again.value.ok, false);
  assert.match(again.value.error.message, /已经有一轮进行中/);
});

test('工具：ai_used=true 直接失败，不写入任何进度', async () => {
  const harness = await boot();
  await harness.dispatch('xianshou_camp', { action: 'start' });
  const result = await harness.dispatch('xianshou_probe', {
    kind: 'baseline',
    title: 'T',
    minutes: 60,
    quality: 80,
    ai_used: true,
  });
  assert.equal(result.value.ok, false);
  assert.match(result.value.error.message, /不能使用 AI/);

  const status = await harness.dispatch('xianshou_camp', { action: 'status' });
  assert.equal(status.value.phase, 'awaiting-baseline', '被拒的裸考不能留下痕迹');
});

test('工具：未开营就做裸考会引导先开营', async () => {
  const harness = await boot();
  const result = await harness.dispatch('xianshou_probe', {
    kind: 'baseline',
    title: 'T',
    minutes: 60,
    quality: 80,
    ai_used: false,
  });
  assert.equal(result.value.ok, false);
  assert.match(result.value.error.hint, /xianshou_camp/);
});

test('工具：一个月后 status 提示该做脱离测试，并复述基线数字', async () => {
  const harness = await boot();
  await harness.dispatch('xianshou_camp', { action: 'start' });
  await harness.dispatch('xianshou_probe', { kind: 'baseline', title: 'T', minutes: 90, quality: 70, ai_used: false });
  harness.clock.advanceHours(22 * 24);

  const status = await harness.dispatch('xianshou_camp', { action: 'status' });
  assert.equal(status.value.phase, 'awaiting-exit');
  assert.equal(status.value.readyForExit, true);
  assert.match(status.text, /90 分钟 \/ 70 分/);
});
