import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MarkdownCardRenderer,
  PlainCardRenderer,
  Theme,
  ThemeResolver,
  PALETTE,
  toneStyle,
  tokensCssDocument,
  tokensToCss,
  card,
  DefaultThresholdPolicy,
  TaskRecord,
  TaskService,
  MemoryTaskRepository,
  ManualClock,
  SequentialIdGenerator,
  MemoryLogger,
  NoopEventSink,
  asTaskId,
} from '../dist/index.js';
import { GateCard, LedgerCard, RecallCard, RefusalCard, HealthCard, ZoneCard } from '../dist/ui/views/index.js';
import { SourceLedger, LedgerPolicy } from '../dist/domain/ledger.js';
import { RecallPolicy } from '../dist/domain/recall.js';
import { HealthReportBuilder } from '../dist/domain/health.js';
import { ZoneClassifier } from '../dist/domain/zone.js';

const policy = new DefaultThresholdPolicy();
const light = new Theme('light');
const dark = new Theme('dark');

function makeTask({ zone = 'red' } = {}) {
  return TaskRecord.create(
    asTaskId('xs-0001'),
    { title: '重构订单模块', zone, zoneRuleId: 'r', rationale: '重复做且在能力圈内', reusedFramework: true, now: new Date('2026-11-05T09:00:00Z') },
    policy,
  );
}

test('渲染器：同一 CardModel 渲染结果稳定（replay 安全）', () => {
  const model = card('danger', '先手闸门 · 已拦下这次调用', [
    { kind: 'heading', text: '下一步' },
    { kind: 'list', ordered: true, items: ['写丑版本', '落稿'] },
    { kind: 'meter', label: '[AI] 占比', value: 0.62, tone: 'danger', caption: '目标 <30%' },
    { kind: 'divider' },
    { kind: 'footnote', text: 'footer' },
  ]);
  const renderer = new MarkdownCardRenderer(light);
  const first = renderer.toText(model);
  const second = renderer.toText(model);
  assert.equal(first, second);
  assert.match(first, /下一步/);
  assert.match(first, /62%/);
  assert.match(first, /▓{7}░{5}/, '计量条固定 12 格，避免不同宽度下比例失真');
});

test('渲染器：不产生三连空行，也不残留末尾空白', () => {
  const model = card('teal', 'T', [
    { kind: 'paragraph', text: 'a' },
    { kind: 'paragraph', text: 'b' },
    { kind: 'divider' },
  ]);
  const text = new MarkdownCardRenderer(light).toText(model);
  assert.ok(!/\n{3,}/.test(text));
  assert.equal(text, text.trimEnd());
});

test('主题：浅/深两套令牌都被解析，auto 跟随宿主，缺省回落浅色', () => {
  assert.equal(new ThemeResolver('light').resolve({ prefersDark: true }).name, 'light');
  assert.equal(new ThemeResolver('dark').resolve({ prefersDark: false }).name, 'dark');
  assert.equal(new ThemeResolver('auto').resolve({ prefersDark: true }).name, 'dark');
  assert.equal(new ThemeResolver('auto').resolve({}).name, 'light');
  assert.notEqual(PALETTE.light.bg, PALETTE.dark.bg);
});

test('主题：五种语义色的前景/背景/符号互不相同（无色环境也能区分）', () => {
  const tones = ['neutral', 'accent', 'teal', 'danger', 'success'];
  for (const theme of ['light', 'dark']) {
    const glyphs = tones.map((t) => toneStyle(theme, t).glyph);
    assert.equal(new Set(glyphs).size, tones.length, `${theme} 的语义符号不能重复`);
    const fgs = tones.map((t) => toneStyle(theme, t).fg);
    assert.equal(new Set(fgs).size, tones.length, `${theme} 的语义前景色不能重复`);
  }
});

test('设计令牌：交付的 CSS 与令牌源保持同步（禁止手工改 CSS）', () => {
  const css = readFileSync(new URL('../docs/ui-tokens.css', import.meta.url), 'utf8');
  assert.equal(css, tokensCssDocument());
  assert.match(tokensToCss('light'), /--xs-accent: #b45309/);
  assert.match(tokensToCss('dark'), /--xs-accent: #e0a061/);
});

test('视图：五类卡片都能渲染出可读文本，且都不含空洞说教句', () => {
  const zone = new ZoneCard(policy).forDecision('xs-0001', '重构订单模块', new ZoneClassifier().classify({ repeatable: true, withinCompetence: true, growthRelevant: true }));
  const gate = new GateCard(policy).blocked(makeTask());
  const ledger = new LedgerPolicy(policy);
  const tally = new SourceLedger();
  tally.add({ id: 'a', label: 'A', tag: 'ai', weight: 70 });
  tally.add({ id: 'b', label: 'B', tag: 'self', weight: 30 });
  const report = new LedgerCard().report(ledger.judge(tally.tally()), '重构订单模块');
  const recall = new RecallCard().result(new RecallPolicy(policy).evaluate('d24h', ['a', 'b', 'c'], new Date(), [2, 1, 2]), '重构订单模块');
  const refusal = new RefusalCard().panel({ accepted: 9, rejected: 0, partial: 0, total: 9, rate: 0, band: 'blind' }, '重构订单模块');
  const health = new HealthCard().report(new HealthReportBuilder(policy).build([], new Date()));

  for (const model of [zone, gate, report, recall, refusal, health]) {
    const text = new MarkdownCardRenderer(light).toText(model);
    assert.ok(text.length > 40, `${model.title} 内容过短`);
    assert.ok(!/请注意|加油|努力|一定要/.test(text), '不出现空洞说教');
    assert.deepEqual(new PlainCardRenderer().render(model).length, 1);
  }
});

test('视图：拦截卡必须同时给"为什么"和"怎么过"（否则用户只会去关插件）', () => {
  const text = new MarkdownCardRenderer(light).toText(new GateCard(policy).blocked(makeTask()));
  assert.match(text, /没参与建造|AI 现在介入/);
  assert.match(text, /xianshou_draft/);
  assert.match(text, /再重新发起刚才那次调用/);
});

test('视图：盲从告警带推导过程，而不是一句"你应该多拒绝"', () => {
  const text = new MarkdownCardRenderer(dark).toText(
    new RefusalCard().panel({ accepted: 10, rejected: 0, partial: 0, total: 10, rate: 0, band: 'blind' }),
  );
  assert.match(text, /82%/);
  assert.match(text, /68%/);
});

test('视图：健康度报告给"样本不足"而不是编造一个 0 分', () => {
  const text = new MarkdownCardRenderer(light).toText(new HealthCard().report(new HealthReportBuilder(policy).build([], new Date())));
  assert.match(text, /样本不足/);
  assert.ok(!/(?:^|[^0-9])0%/.test(text), '不得把无数据渲染成 0%');
});

test('视图：任务摘要卡在未留痕时不显示比例条（没有数据就不要画表）', async () => {
  const service = new TaskService({
    repository: new MemoryTaskRepository(),
    clock: new ManualClock(),
    ids: new SequentialIdGenerator(),
    policy,
    logger: new MemoryLogger(),
    events: new NoopEventSink(),
  });
  const { task } = await service.create({
    title: 'T',
    signals: { repeatable: true, withinCompetence: true, growthRelevant: true },
  });
  const { TaskCard } = await import('../dist/ui/views/task-view.js');
  const text = new MarkdownCardRenderer(light).toText(new TaskCard(policy).summary(task));
  assert.ok(!text.includes('[AI] 占比'), '零段落时不画比例条');
  assert.match(text, /未落稿/);
});
