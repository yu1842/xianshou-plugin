import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  JsonFileRepository,
  MemoryTaskRepository,
  MigratingRepository,
  SessionStateRepository,
  ResilientRepository,
  DEFAULT_MIGRATIONS,
  MemoryLogger,
  TaskRecord,
  DefaultThresholdPolicy,
  ManualClock,
  asTaskId,
} from '../dist/index.js';

const logger = new MemoryLogger();
const policy = new DefaultThresholdPolicy();

function snapshot(id, overrides = {}) {
  return { ...TaskRecord.create(asTaskId(id), { title: id, zone: 'green', zoneRuleId: 'g', rationale: '', reusedFramework: false, now: new Date('2026-11-05T00:00:00Z') }, policy).toSnapshot(), ...overrides };
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'xianshou-'));
}

test('仓储契约：文件仓储与内存仓储行为一致（里氏替换的验收方式）', async () => {
  const dir = await tempDir();
  const repos = [new MemoryTaskRepository(), new JsonFileRepository(dir, logger)];
  try {
    for (const repo of repos) {
      assert.equal(await repo.load(asTaskId('xs-0001')), null);
      await repo.save(snapshot('xs-0001'));
      await repo.save(snapshot('xs-0002'));
      assert.equal((await repo.list()).length, 2);
      assert.equal((await repo.load(asTaskId('xs-0001'))).id, 'xs-0001');
      await repo.save(snapshot('xs-0001', { title: '覆盖后' }));
      assert.equal((await repo.load(asTaskId('xs-0001'))).title, '覆盖后');
      await repo.remove(asTaskId('xs-0002'));
      assert.equal((await repo.list()).length, 1);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件仓储：原子写入不留临时文件，且不改动其他任务', async () => {
  const dir = await tempDir();
  try {
    const repo = new JsonFileRepository(dir, logger);
    await repo.save(snapshot('xs-0001'));
    await repo.save(snapshot('xs-0001', { title: '二次写入' }));
    const files = await readdir(dir);
    assert.deepEqual(files, ['xs-0001.json'], '不应残留 .tmp 文件');
    const text = await readFile(join(dir, 'xs-0001.json'), 'utf8');
    assert.match(text, /二次写入/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件仓储：损坏文件被跳过而不是拖垮整张列表', async () => {
  const dir = await tempDir();
  try {
    const repo = new JsonFileRepository(dir, logger);
    await repo.save(snapshot('xs-0001'));
    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8');
    assert.equal((await repo.list()).length, 1);
    assert.ok(logger.entries.some((e) => e.message.includes('跳过损坏')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件仓储：非法任务 ID 被拒绝，防止路径穿越', async () => {
  const dir = await tempDir();
  try {
    const repo = new JsonFileRepository(dir, logger);
    await assert.rejects(() => repo.save(snapshot('xs-0001', { id: '../../etc/passwd' })), /非法任务 ID/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('迁移：v1 数据补齐字段后可用，且不回写旧版本', async () => {
  const inner = new MemoryTaskRepository();
  const legacy = snapshot('xs-0001');
  const v1 = { ...legacy, schemaVersion: 1 };
  delete v1.gates;
  delete v1.refusals;
  delete v1.reusedFramework;
  await inner.save(v1);

  const repo = new MigratingRepository(inner, DEFAULT_MIGRATIONS);
  const loaded = await repo.load(asTaskId('xs-0001'));
  assert.equal(loaded.schemaVersion, 2);
  assert.deepEqual(loaded.gates, []);
  assert.equal(loaded.reusedFramework, false);
  assert.equal((await inner.load(asTaskId('xs-0001'))).schemaVersion, 1, '读路径不应修改源数据');
});

test('迁移：未来版本数据 fail closed，不猜测式读入', async () => {
  const inner = new MemoryTaskRepository();
  await inner.save(snapshot('xs-0001', { schemaVersion: 99 }));
  const repo = new MigratingRepository(inner, DEFAULT_MIGRATIONS);
  await assert.rejects(() => repo.load(asTaskId('xs-0001')), /高于插件支持上限/);
});

test('会话状态仓储：索引与数据分离，缺记录时给警告而不是抛错', async () => {
  const store = new Map();
  const bridge = {
    version: '0.2.1-rc.1',
    capabilities: { toolRegister: true, toolGuard: true, preExecute: true, postExecute: true, sessionState: true, sessionEvents: true },
    state: {
      read: async (key) => (store.has(key) ? store.get(key) : null),
      write: async (key, value) => {
        if (value === null) store.delete(key);
        else store.set(key, value);
      },
    },
  };
  const repo = new SessionStateRepository(bridge, logger);
  assert.equal(SessionStateRepository.isAvailable(bridge), true);
  await repo.save(snapshot('xs-0001'));
  await repo.save(snapshot('xs-0002'));
  assert.equal((await repo.list()).length, 2);
  assert.equal((await repo.load(asTaskId('xs-0001'))).id, 'xs-0001');
  store.delete('xianshou.task.xs-0002');
  assert.equal((await repo.list()).length, 1);
  assert.ok(logger.entries.some((e) => e.message.includes('会话状态里缺失')));
});

test('存储降级：底层写失败后切内存副本，并明确告知不再持久化', async () => {
  const failing = {
    kind: 'broken',
    load: async () => null,
    list: async () => {
      throw new Error('EACCES');
    },
    save: async () => {
      throw new Error('EACCES');
    },
    remove: async () => {},
  };
  const repo = new ResilientRepository(failing, logger);
  await repo.save(snapshot('xs-0001'));
  assert.equal(repo.degraded, true);
  assert.equal((await repo.load(asTaskId('xs-0001'))).id, 'xs-0001');
  assert.ok(logger.entries.some((e) => e.message.includes('存储降级')));
});

test('仓储选择：无会话状态接缝时自动降级到文件（auto 模式）', async () => {
  const { FakeHarness } = await import('./helpers/harness.mjs');
  const dir = await tempDir();
  try {
    const harness = new FakeHarness({ noState: true });
    const runtime = harness.mount({ storage: { mode: 'auto', directory: dir } });
    await runtime.ready;
    assert.equal(runtime.repositoryKind, 'json-file+migrating+resilient');
    await harness.dispatch('xianshou_start', { title: 'T', repeatable: true, within_competence: true, growth_relevant: true });
    const files = await readdir(dir);
    assert.equal(files.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
