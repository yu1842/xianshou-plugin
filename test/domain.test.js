import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DefaultThresholdPolicy,
  ZoneClassifier,
  SourceLedger,
  LedgerPolicy,
  DraftValidator,
  RefusalPanel,
  HealthReportBuilder,
  TaskRecord,
  TaskService,
  MemoryTaskRepository,
  ManualClock,
  SequentialIdGenerator,
  MemoryLogger,
  NoopEventSink,
  asTaskId,
  DomainError,
} from '../dist/index.js';
import { RECALL_QUESTIONS, RecallPolicy } from '../dist/domain/recall.js';

const policy = new DefaultThresholdPolicy();

test('三区分级：四条规则覆盖全部信号组合，且命中优先级正确', () => {
  const classifier = new ZoneClassifier();
  const cases = [
    [{ repeatable: true, withinCompetence: true, growthRelevant: true }, 'red'],
    [{ repeatable: true, withinCompetence: false, growthRelevant: true }, 'yellow'],
    [{ repeatable: false, withinCompetence: true, growthRelevant: true }, 'yellow'],
    [{ repeatable: false, withinCompetence: true, growthRelevant: false }, 'green'],
    [{ repeatable: true, withinCompetence: true, growthRelevant: false }, 'red'],
  ];
  for (const [signals, expected] of cases) {
    assert.equal(classifier.classify(signals).zone, expected, JSON.stringify(signals));
  }
});

test('三区分级：新增规则不改分类器（开闭原则的可执行证据）', () => {
  const custom = {
    id: 'custom-boss-task',
    priority: 1,
    decide: (s) => (s.repeatable && s.growthRelevant ? { zone: 'red', ruleId: 'custom-boss-task', rationale: '自定义规则' } : undefined),
  };
  const classifier = new ZoneClassifier([custom]);
  assert.equal(classifier.classify({ repeatable: true, withinCompetence: false, growthRelevant: true }).ruleId, 'custom-boss-task');
});

test('来源账本：比例按权重而非段数计算，避免"写很长但全标自"虚增自主率', () => {
  const ledger = new SourceLedger();
  ledger.add({ id: 'a', label: 'A', tag: 'self', weight: 10 });
  ledger.add({ id: 'b', label: 'B', tag: 'ai', weight: 90 });
  const tally = ledger.tally();
  assert.equal(tally.aiRatio, 0.9);
  assert.equal(tally.selfRatio, 0.1);
});

test('来源账本：同一 id 重复标记视为改判而非追加', () => {
  const ledger = new SourceLedger();
  ledger.add({ id: 'a', label: 'A', tag: 'ai', weight: 50 });
  ledger.add({ id: 'a', label: 'A', tag: 'self', weight: 50 });
  assert.equal(ledger.size, 1);
  assert.equal(ledger.tally().self, 50);
});

test('来源账本：删除不存在的段落抛领域错误', () => {
  assert.throws(() => new SourceLedger().remove('nope'), (e) => e instanceof DomainError && e.code === 'SEGMENT_NOT_FOUND');
});

test('比例判定：三档阈值边界（<30% 正常 / 30–60% 需回收 / >60% 重做）', () => {
  const judge = new LedgerPolicy(policy);
  const build = (ai, total) => {
    const ledger = new SourceLedger();
    if (ai > 0) ledger.add({ id: 'ai', label: 'AI', tag: 'ai', weight: ai });
    if (total - ai > 0) ledger.add({ id: 'self', label: 'SELF', tag: 'self', weight: total - ai });
    return ledger.tally();
  };
  assert.equal(judge.judge(build(29, 100)).band, 'healthy');
  assert.equal(judge.judge(build(30, 100)).band, 'recall');
  assert.equal(judge.judge(build(60, 100)).band, 'recall');
  assert.equal(judge.judge(build(61, 100)).band, 'rework');
  assert.equal(judge.judge(build(0, 0)).band, 'recall');
});

test('丑版本校验：敷衍内容被拒，结构 / 三条判断任一命中即通过', () => {
  const validator = DraftValidator.withDefaults(80, 20);
  const thin = validator.inspect({ content: '随便写两行' });
  assert.equal(thin.ok, false);
  assert.ok(thin.reasons.length > 0);

  const structured = validator.inspect({
    content:
      '一、问题：订单与库存强耦合，任何改动都要同时改三处，回归面太大。\n' +
      '二、判断：因为库存扣减是外部契约，所以先做防腐层，把契约固定在适配器里。\n' +
      '三、路径：先拆领域模型，再迁移状态机，最后补集成测试。预计两天，风险在迁移顺序。',
  });
  assert.equal(structured.ok, true);

  const judgements = validator.inspect({
    content: '我先列出我认为最关键的三个判断，内容如下，暂时还没有展开成提纲，但方向是清楚的，后面再补。',
    keyJudgements: ['库存与订单解耦', '先做防腐层', '状态机最后迁移'],
  });
  assert.equal(judgements.ok, true);

  const tooFast = validator.inspect({
    content: '1. 拆模型\n2. 做适配层\n3. 迁状态机 —— 这三个步骤就是我现在的全部想法，先记下来，后面再展开细节。',
    minutesSpent: 3,
  });
  assert.equal(tooFast.ok, false);
});

test('回收判定：三题各 0-2 分，<80% 判失败；没写答案的题即使自评 2 分也记 0', () => {
  const recall = new RecallPolicy(policy);
  const pass = recall.evaluate('d24h', ['因为A所以B', '最不确定的是迁移顺序', '靠数据跑一次'], new Date(), [2, 2, 2]);
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.score, 1);

  const fail = recall.evaluate('d24h', ['大概是吧', '不知道', '没想过'], new Date(), [1, 0, 0]);
  assert.equal(fail.verdict, 'fail');
  assert.deepEqual(fail.weakQuestions, [1, 2, 3]);

  const inflated = recall.evaluate('d24h', ['内容A', '', '内容C'], new Date(), [2, 2, 2]);
  assert.deepEqual(inflated.scores, [2, 0, 2]);
});

test('任务聚合：回收失败会把分区降为黄区并置 rework（打回是状态变更，不是提示）', () => {
  const clock = new ManualClock('2026-11-05T09:00:00Z');
  const task = TaskRecord.create(
    asTaskId('xs-0001'),
    { title: 'T', zone: 'red', zoneRuleId: 'r', rationale: 'x', reusedFramework: false, now: clock.now() },
    policy,
  );
  task.submitDraft(
    {
      content:
        '1. 拆领域模型：先把订单、库存、支付三块契约固定下来。\n' +
        '2. 因为库存扣减是外部契约，所以先做防腐层，再谈状态机。\n' +
        '3. 结论：迁移顺序是最大风险，需要先补集成测试再动状态机。',
      minutesSpent: 25,
    },
    clock.now(),
  );
  task.deliver(clock.now());
  const attempt = task.answerRecall('d24h', ['', '', ''], clock.now(), [0, 0, 0]);
  assert.equal(attempt.verdict, 'fail');
  assert.equal(task.zone, 'yellow');
  assert.equal(task.status, 'rework');
  assert.throws(() => task.answerRecall('d24h', ['a', 'b', 'c'], clock.now(), [2, 2, 2]), (e) => e.code === 'RECALL_ALREADY_ANSWERED');
});

test('任务聚合：红区无初稿不可交付；绿区不受先手约束', () => {
  const clock = new ManualClock();
  const red = TaskRecord.create(asTaskId('xs-0002'), { title: 'R', zone: 'red', zoneRuleId: 'r', rationale: '', reusedFramework: false, now: clock.now() }, policy);
  assert.equal(red.requiresDraft, true);
  assert.throws(() => red.deliver(clock.now()), (e) => e.code === 'DRAFT_REQUIRED');
  assert.throws(() => red.markSegment({ id: 'a', label: 'a', tag: 'self', weight: 1 }, clock.now()), (e) => e.code === 'DRAFT_REQUIRED');

  const green = TaskRecord.create(asTaskId('xs-0003'), { title: 'G', zone: 'green', zoneRuleId: 'g', rationale: '', reusedFramework: false, now: clock.now() }, policy);
  assert.equal(green.requiresDraft, false);
  assert.doesNotThrow(() => green.deliver(clock.now()));
});

test('拒绝率：健康区间 15%–40%，低于 10% 判"在盲从"，样本不足不判定', () => {
  const panel = new RefusalPanel(policy);
  for (let i = 0; i < 6; i += 1) panel.record({ suggestionId: `s${i}`, decision: 'accepted' });
  assert.equal(panel.tally().band, 'blind');

  const healthy = new RefusalPanel(policy);
  for (let i = 0; i < 6; i += 1) healthy.record({ suggestionId: `h${i}`, decision: i < 1 ? 'rejected' : 'accepted' });
  assert.equal(healthy.tally().band, 'healthy');

  const tiny = new RefusalPanel(policy);
  tiny.record({ suggestionId: 'x', decision: 'rejected' });
  assert.equal(tiny.tally().band, 'insufficient');
});

test('拒绝率：从快照恢复后仍然遵守 minSamples（不能因为重启就降低判定门槛）', () => {
  const restored = RefusalPanel.restore([{ suggestionId: 'a', decision: 'rejected' }], policy);
  assert.equal(restored.tally().band, 'insufficient');
  const withoutThresholds = RefusalPanel.restore([{ suggestionId: 'a', decision: 'rejected' }]);
  assert.notEqual(withoutThresholds.tally().band, 'insufficient', '无阈值时退回旧行为，说明参数是必须的');
});

test('健康度报告：四指标各自给区间，样本不足不编数字', () => {
  const report = new HealthReportBuilder(policy).build([], new Date());
  assert.equal(report.metrics.length, 4);
  assert.ok(report.metrics.every((m) => m.value === null && m.band === 'insufficient'));
  assert.equal(report.topConcern, null);
});

test('阈值自相矛盾时拒绝构造（避免静默跑一套坏规则）', () => {
  assert.throws(() => new DefaultThresholdPolicy({ aiRatioRecall: 0.7, aiRatioRework: 0.6 }), /aiRatioRecall 必须小于/);
});

test('仓储：内存仓储满足列表 / 覆盖 / 删除契约', async () => {
  const repo = new MemoryTaskRepository();
  const clock = new ManualClock();
  const service = new TaskService({
    repository: repo,
    clock,
    ids: new SequentialIdGenerator(),
    policy,
    logger: new MemoryLogger(),
    events: new NoopEventSink(),
  });
  const a = await service.create({ title: 'A', signals: { repeatable: true, withinCompetence: true, growthRelevant: true } });
  const b = await service.create({ title: 'B', signals: { repeatable: false, withinCompetence: true, growthRelevant: false } });
  assert.equal((await service.list()).length, 2);
  assert.equal((await service.load(a.task.id)).title, 'A');
  await service.save(a.task);
  assert.equal((await repo.list()).length, 2);
  await repo.remove(b.task.id);
  assert.equal((await service.list()).length, 1);
  await assert.rejects(() => service.load('xs-9999'), (e) => e.code === 'TASK_NOT_FOUND');
});

test('文档与实现一致：策略常量与方案原文的阈值对齐', () => {
  const source = readFileSync(new URL('../../先手协议-防认知债方案.html', import.meta.url), 'utf8');
  assert.match(source, /20 分钟/);
  assert.match(source, /30%\/60%/);
  assert.match(source, /15%–40%/);
  assert.equal(policy.draftMinutes, 20);
  assert.equal(policy.aiRatioRecall, 0.3);
  assert.equal(policy.aiRatioRework, 0.6);
  assert.equal(policy.refusalHealthyMin, 0.15);
  assert.equal(policy.refusalHealthyMax, 0.4);
  assert.equal(RECALL_QUESTIONS.length, 3);
});
