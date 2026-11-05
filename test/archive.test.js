import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  createBundle,
  parseBundle,
  planMerge,
  serializeBundle,
} from '../dist/domain/archive.js';
import { FsArtifactStore, MemoryArtifactStore } from '../dist/adapters/storage/artifacts.js';
import { NodeHasher, Fnv1aHasher } from '../dist/adapters/hash/sha256.js';
import { buildMarkdownReport } from '../dist/application/report.js';
import { HealthReportBuilder, DefaultThresholdPolicy, MemoryLogger, PLUGIN_VERSION } from '../dist/index.js';
import { FakeHarness, seedDeliveredTask } from './helpers/harness.mjs';

const policy = new DefaultThresholdPolicy();
const logger = new MemoryLogger();

function snapshot(id, overrides = {}) {
  return {
    schemaVersion: 2,
    id,
    title: `任务 ${id}`,
    zone: 'red',
    zoneRuleId: 'r',
    rationale: '',
    status: 'delivered',
    createdAt: '2026-11-05T09:00:00.000Z',
    updatedAt: '2026-11-05T10:00:00.000Z',
    deliveredAt: '2026-11-05T10:00:00.000Z',
    draft: { content: '这是先手稿原文，包含一些只有我自己看得懂的判断。', minutesSpent: 22, keyJudgements: ['A'], createdAt: '2026-11-05T09:30:00.000Z' },
    segments: [
      { id: 's1', label: '引言', tag: 'self', weight: 600 },
      { id: 's2', label: '方案', tag: 'ai', weight: 300 },
    ],
    recalls: [{ window: 'd24h', answeredAt: '2026-11-06T10:00:00.000Z', scores: [2, 2, 1], answers: ['答案一', '答案二', '答案三'], score: 0.83, verdict: 'pass', weakQuestions: [3] }],
    gates: [{ window: 'd24h', scheduledFor: '2026-11-06T10:00:00.000Z', questions: ['a', 'b', 'c'] }],
    refusals: [{ suggestionId: 'x', decision: 'rejected' }],
    reusedFramework: true,
    ...overrides,
  };
}

// ── 备份包 ────────────────────────────────────────────

test('归档：导出→解析可以无损往返（字段逐个相等）', () => {
  const tasks = [snapshot('xs-1'), snapshot('xs-2', { zone: 'green', title: '翻译', reusedFramework: false })];
  const bundle = createBundle(tasks, { now: new Date('2026-11-06T12:00:00Z'), pluginVersion: PLUGIN_VERSION, redact: false });
  const parsed = parseBundle(serializeBundle(bundle));

  assert.equal(parsed.format, ARCHIVE_FORMAT);
  assert.equal(parsed.version, ARCHIVE_VERSION);
  assert.equal(parsed.tasks.length, 2);
  assert.deepEqual(parsed.tasks.find((t) => t.id === 'xs-1'), tasks[0]);
  assert.equal(parsed.redaction, 'none');
});

test('归档：脱敏只去掉正文，结构与指标必须保留', () => {
  const bundle = createBundle([snapshot('xs-1')], { now: new Date(), pluginVersion: PLUGIN_VERSION, redact: true });
  const task = bundle.tasks[0];
  assert.equal(task.draft.content, '（已脱敏）');
  assert.deepEqual(task.draft.keyJudgements, []);
  assert.deepEqual(task.recalls[0].answers, ['（已脱敏）', '（已脱敏）', '（已脱敏）']);
  assert.equal(task.draft.minutesSpent, 22, '时长属于指标，不能脱掉');
  assert.equal(task.segments.length, 2);
  assert.equal(task.recalls[0].score, 0.83);
  assert.equal(bundle.redaction, 'drafts-and-answers');
});

test('归档：解析对不可信输入给出字段级错误，而不是猜着读', () => {
  assert.throws(() => parseBundle('not json'), /不是合法的 JSON/);
  assert.throws(() => parseBundle('[]'), /根节点必须是对象/);
  assert.throws(() => parseBundle(JSON.stringify({ format: 'other', version: 1, tasks: [] })), /不是先手协议备份/);
  assert.throws(() => parseBundle(JSON.stringify({ format: ARCHIVE_FORMAT, version: 0, tasks: [] })), /备份版本非法/);
  assert.throws(
    () => parseBundle(JSON.stringify({ format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION + 1, tasks: [] })),
    /高于当前插件支持/,
  );
  assert.throws(() => parseBundle(JSON.stringify({ format: ARCHIVE_FORMAT, version: 1 })), /缺少 tasks 数组/);
  assert.throws(() => parseBundle(JSON.stringify({ format: ARCHIVE_FORMAT, version: 1, tasks: [{}] })), /tasks\[0\]\.id/);
  assert.throws(
    () => parseBundle(JSON.stringify({ format: ARCHIVE_FORMAT, version: 1, tasks: [{ id: 'x', schemaVersion: 99 }] })),
    /数据版本 99 高于/,
  );
});

test('归档：合并策略的计数与逐条动作一致', () => {
  const existing = [snapshot('same-old'), snapshot('only-existing')];
  const incoming = [snapshot('same-old', { updatedAt: '2026-11-05T11:00:00.000Z' }), snapshot('new-one')];

  const dry = planMerge(existing, incoming, 'dry-run');
  assert.equal(dry.inserted, 1);
  assert.equal(dry.replaced, 1, '备份里的更新被视为 replace');
  assert.equal(dry.skipped, 0);

  const merge = planMerge(existing, incoming, 'skip-existing');
  assert.equal(merge.inserted, 1);
  assert.equal(merge.skipped, 1);
  assert.equal(merge.replaced, 0);

  const overwrite = planMerge(existing, incoming, 'overwrite-existing');
  assert.equal(overwrite.inserted, 1);
  assert.equal(overwrite.replaced, 1);
  assert.deepEqual(
    overwrite.items.map((i) => i.action),
    ['replace', 'insert'],
  );
});

// ── 报表 ──────────────────────────────────────────────

test('报表：含四指标、明细、校验值与口径说明', () => {
  const tasks = [snapshot('xs-1')];
  const health = new HealthReportBuilder(policy).build([], new Date('2026-11-06T12:00:00Z'));
  const md = buildMarkdownReport(tasks, {
    generatedAt: new Date('2026-11-06T12:00:00Z'),
    pluginVersion: PLUGIN_VERSION,
    checksum: 'abc123',
    health,
  });

  assert.match(md, /# 先手协议 · 认知债报表/);
  assert.match(md, /无提示复述准确率/);
  assert.match(md, /### 任务 xs-1/);
  assert.match(md, /sha256\(archive\.json\) = abc123/);
  assert.match(md, /口径/);
  assert.match(md, /工程取值/);
  assert.ok(!md.includes('undefined'), '报表里不能出现 undefined');
  assert.ok(!md.includes('NaN'));
});

test('报表：任务标题里的竖线不会破坏表格', () => {
  const md = buildMarkdownReport([snapshot('xs-1', { title: 'A | B' })], {
    generatedAt: new Date('2026-11-06T12:00:00Z'),
    pluginVersion: PLUGIN_VERSION,
    checksum: 'x',
    health: new HealthReportBuilder(policy).build([], new Date()),
  });
  assert.match(md, /A \\\| B/);
});

// ── 产物存储 ──────────────────────────────────────────

test('存储：文件名白名单挡住路径穿越与非法字符', async () => {
  const store = new MemoryArtifactStore();
  for (const bad of ['../escape.json', 'a/b.json', 'a\\b.json', 'na me.json', '', 'x'.repeat(130)]) {
    await assert.rejects(() => store.write(bad, 'x'), /文件名/, `应拒绝：${bad}`);
  }
  await store.write('ok_name-1.json', 'x');
  assert.deepEqual(await store.list(), ['ok_name-1.json']);
});

test('存储：默认不覆盖，显式 overwrite 才允许', async () => {
  const store = new MemoryArtifactStore();
  await store.write('a.json', 'first');
  await assert.rejects(() => store.write('a.json', 'second'), /已存在/);
  await store.write('a.json', 'second', { overwrite: true });
  assert.equal(await store.read('a.json'), 'second');
});

test('存储：文件实现原子写入，且拒绝越界读取', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xs-archive-'));
  try {
    const store = new FsArtifactStore(dir, logger);
    const result = await store.write('r.json', '{"a":1}');
    assert.ok(result.path.endsWith('r.json'));
    assert.deepEqual(await store.list(), ['r.json']);
    assert.equal(await store.read('r.json'), '{"a":1}');
    assert.equal(await store.exists('../etc/passwd'), false);
    await assert.rejects(() => store.read('../etc/passwd'), /文件名/);
    await writeFile(join(dir, 'bad.txt'), 'x', 'utf8');
    await assert.rejects(() => store.read('/etc/hostname'), /只接受/);
    const files = await readdir(dir);
    assert.ok(!files.some((f) => f.endsWith('.tmp')), '不应残留临时文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('哈希：同一个内容稳定，不同内容不同', () => {
  const hasher = new NodeHasher();
  assert.equal(hasher.sha256('abc'), hasher.sha256('abc'));
  assert.notEqual(hasher.sha256('abc'), hasher.sha256('abd'));
  assert.equal(hasher.sha256('abc').length, 64);
  assert.equal(new Fnv1aHasher().sha256('abc').length, 64);
});

// ── 工具 ──────────────────────────────────────────────

test('工具：export 写 json+md，返回值带校验值与文件清单', async () => {
  const harness = new FakeHarness();
  harness.mount({ storage: { mode: 'memory' }, recall: { autoRemind: false, sweepMinutes: 0 } });
  await harness.runtime.ready;
  await seedDeliveredTask(harness);

  const result = await harness.dispatch('xianshou_export', { format: 'both', name: 'weekly' });
  assert.equal(result.value.ok, true);
  assert.equal(result.value.files.length, 2);
  assert.equal(result.value.tasks, 1);
  assert.match(result.value.checksum, /^[0-9a-f]{64}$/);
  assert.ok(harness.artifacts.files.has('weekly.json'));
  assert.ok(harness.artifacts.files.has('weekly.md'));

  const md = harness.artifacts.files.get('weekly.md');
  assert.match(md, /认知债报表/);
  assert.match(md, new RegExp(result.value.checksum.slice(0, 16)));
});

test('工具：只导 markdown 时会提示"这不是可恢复的备份"', async () => {
  const harness = new FakeHarness();
  harness.mount({ storage: { mode: 'memory' } });
  await harness.runtime.ready;
  await seedDeliveredTask(harness);

  const result = await harness.dispatch('xianshou_export', { format: 'markdown', name: 'only-md' });
  assert.match(result.value.note, /不是可恢复的备份/);
  assert.ok(harness.artifacts.files.has('only-md.md'));
  assert.ok(!harness.artifacts.files.has('only-md.json'));
});

test('工具：导出默认不覆盖同名文件，报错里给恢复路径', async () => {
  const harness = new FakeHarness();
  harness.mount({ storage: { mode: 'memory' } });
  await harness.runtime.ready;
  await seedDeliveredTask(harness);

  await harness.dispatch('xianshou_export', { format: 'json', name: 'dup' });
  const again = await harness.dispatch('xianshou_export', { format: 'json', name: 'dup' });
  assert.equal(again.value.ok, false);
  assert.match(again.value.error.message, /已存在/);
  assert.match(again.value.error.hint, /overwrite/);

  const forced = await harness.dispatch('xianshou_export', { format: 'json', name: 'dup', overwrite: true });
  assert.equal(forced.value.ok, true);
});

test('工具：import 默认 dry-run 不写账本，确认后才落地', async () => {
  const harness = new FakeHarness();
  harness.mount({ storage: { mode: 'memory' } });
  await harness.runtime.ready;
  await seedDeliveredTask(harness);
  const exported = await harness.dispatch('xianshou_export', { format: 'json', name: 'backup' });
  assert.equal(exported.value.ok, true);
  const before = (await harness.dispatch('xianshou_status', {})).value.count;

  // 另起一个空账本，从备份恢复
  const fresh = new FakeHarness();
  fresh.mount({ storage: { mode: 'memory' } });
  await fresh.runtime.ready;
  fresh.artifacts.files.set('backup.json', harness.artifacts.files.get('backup.json'));

  const dry = await fresh.dispatch('xianshou_import', { file: 'backup.json' });
  assert.equal(dry.value.ok, true);
  assert.equal(dry.value.applied, false);
  assert.equal(dry.value.inserted, 1);
  assert.equal((await fresh.dispatch('xianshou_status', {})).value.count, 0, 'dry-run 不能改账本');

  const real = await fresh.dispatch('xianshou_import', { file: 'backup.json', mode: 'merge' });
  assert.equal(real.value.applied, true);
  assert.equal((await fresh.dispatch('xianshou_status', {})).value.count, before);
});

test('工具：恢复只增不删——不会因为导入旧备份而删掉现有任务', async () => {
  const harness = new FakeHarness();
  harness.mount({ storage: { mode: 'memory' } });
  await harness.runtime.ready;
  await seedDeliveredTask(harness, { title: '甲' });
  await harness.dispatch('xianshou_export', { format: 'json', name: 'snap' });

  // 再建一个新任务，然后恢复旧备份
  await seedDeliveredTask(harness, { title: '乙' });
  const before = (await harness.dispatch('xianshou_status', {})).value.count;
  assert.equal(before, 2);

  const result = await harness.dispatch('xianshou_import', { file: 'snap.json', mode: 'overwrite' });
  assert.equal(result.value.ok, true);
  const after = (await harness.dispatch('xianshou_status', {})).value.count;
  assert.equal(after, 2, '导入不应删除任何任务');
  assert.equal(result.value.inserted, 0);
});

test('工具：备份文件损坏时失败得清楚，不写入任何东西', async () => {
  const harness = new FakeHarness();
  harness.mount({ storage: { mode: 'memory' } });
  await harness.runtime.ready;
  harness.artifacts.files.set('broken.json', '{ not json');

  const result = await harness.dispatch('xianshou_import', { file: 'broken.json', mode: 'merge' });
  assert.equal(result.value.ok, false);
  assert.match(result.value.error.message, /不是合法的 JSON/);
  assert.equal((await harness.dispatch('xianshou_status', {})).value.count, 0);
});

test('工具：mode / format 非法时给可执行的提示', async () => {
  const harness = new FakeHarness();
  harness.mount({ storage: { mode: 'memory' } });
  await harness.runtime.ready;

  const badMode = await harness.dispatch('xianshou_import', { file: 'x.json', mode: 'yolo' });
  assert.equal(badMode.value.ok, false);
  assert.match(badMode.value.error.message, /mode 只能是/);

  const badFormat = await harness.dispatch('xianshou_export', { format: 'csv' });
  assert.equal(badFormat.value.ok, false);
  assert.match(badFormat.value.error.message, /format 只能是/);
});

// ── 版本一致性 ────────────────────────────────────────

test('版本：宿主常量、客户端常量与 package.json 三者一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const clientSource = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  const clientVersion = /const PACKAGE_VERSION = '([^']+)'/.exec(clientSource)[1];
  assert.equal(PLUGIN_VERSION, pkg.version);
  assert.equal(clientVersion, pkg.version);
});
