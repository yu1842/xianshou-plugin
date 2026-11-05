import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSemVer,
  compareSemVer,
  satisfies,
  releaseLine,
  isPrerelease,
  VersionGate,
  AdapterRegistry,
  lookupTier,
  SUPPORT_MATRIX,
  MemoryLogger,
} from '../dist/index.js';

const logger = new MemoryLogger();

/** npm 上真实存在的 0.2.x 版本序列（截至 2026-11）。 */
const REAL_VERSIONS = [
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.1-alpha.1',
  '0.2.1-rc.1',
  '0.2.1-rc.2',
  '0.2.1-rc.3',
  '0.2.1-rc.4',
  '0.2.1-rc.5',
  '0.2.2-alpha.2',
  '0.2.2-alpha.3',
  '0.2.2-rc.1',
];

test('semver 解析：预发布标识按 node-semver 规则排序（数字段低于字母段）', () => {
  const ordered = ['0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.10', '0.2.1', '0.2.2-alpha.1'];
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = parseSemVer(ordered[i - 1]);
    const next = parseSemVer(ordered[i]);
    assert.ok(compareSemVer(prev, next) < 0, `${ordered[i - 1]} 应小于 ${ordered[i]}`);
  }
});

test('semver 解析：非法版本返回 null 而不是抛错（探测阶段不能崩）', () => {
  assert.equal(parseSemVer('0.2'), null);
  assert.equal(parseSemVer('latest'), null);
  assert.equal(parseSemVer('v0.2.1-rc.1+build.5').patch, 1);
});

test('版本范围：engines.dsh 覆盖 0.2.1-rc.1 及以上的全部 0.2.x，不覆盖 0.3.x', () => {
  const range = '>=0.2.1-rc.1 <0.3.0';
  assert.equal(satisfies('0.2.1-rc.1', range), true, '下界必须包含（含预发布）');
  assert.equal(satisfies('0.2.1-rc.5', range), true);
  assert.equal(satisfies('0.2.2-rc.1', range), true);
  assert.equal(satisfies('0.2.9', range), true);
  assert.equal(satisfies('0.2.0-rc.2', range), false, '低于下界不得放行');
  assert.equal(satisfies('0.2.1-alpha.5', range), false, 'alpha 早于 rc.1，同属低于下界');
  assert.equal(satisfies('0.3.0', range), false);
  assert.equal(satisfies('1.0.0', range), false);
});

test('版本范围：兼容 ^ / ~ / 空格分隔 / || 多分支', () => {
  assert.equal(satisfies('0.2.7', '^0.2.1'), true);
  assert.equal(satisfies('0.3.0', '^0.2.1'), false);
  assert.equal(satisfies('0.2.9', '~0.2.1'), true);
  assert.equal(satisfies('0.2.4', '>=0.2.1-rc.1 <0.2.3 || >=0.2.5 <0.3.0'), false);
  assert.equal(satisfies('0.2.6', '>=0.2.1-rc.1 <0.2.3 || >=0.2.5 <0.3.0'), true);
});

test('产品线判定不靠字符串前缀（0.2.10 vs 0.2.1 的经典坑）', () => {
  assert.equal(releaseLine('0.2.10'), '0.2');
  assert.equal(releaseLine('0.2.1-rc.1'), '0.2');
  assert.equal(releaseLine('not-a-version'), 'unknown');
  assert.equal(isPrerelease('0.2.1-rc.1'), true);
  assert.equal(isPrerelease('0.2.1'), false);
});

test('支持矩阵：每条真实版本都有明确层级，不存在"默认可信"的版本', () => {
  for (const version of REAL_VERSIONS) {
    const tier = lookupTier(version);
    assert.ok(['contract-verified', 'declared', 'provisional'].includes(tier), version);
  }
  assert.equal(lookupTier('0.2.1-rc.1'), 'contract-verified');
  assert.equal(lookupTier('0.2.2-alpha.2'), 'declared');
  assert.equal(lookupTier('0.3.1'), 'provisional');
  assert.ok(SUPPORT_MATRIX.length >= 10);
});

test('版本闸门：三条分支的判决互斥且可解释', () => {
  const gate = new VersionGate({ engineRange: '>=0.2.1-rc.1 <0.3.0', allowUnverified: false });
  assert.equal(gate.check('0.2.1-rc.1').verdict, 'allow');
  assert.equal(gate.check('0.2.2-alpha.2').verdict, 'allow-degraded');
  assert.equal(gate.check('0.2.0-rc.2').verdict, 'blocked');
  assert.equal(gate.check('0.3.0').verdict, 'blocked');

  const permissive = new VersionGate({ engineRange: '>=0.2.1-rc.1 <0.3.0', allowUnverified: true });
  assert.equal(permissive.check('0.3.0').verdict, 'allow-degraded');

  for (const version of [...REAL_VERSIONS, '0.3.0', '1.0.0', 'weird']) {
    const result = gate.check(version);
    assert.ok(result.reason.length > 0, `${version} 必须给出理由`);
  }
});

test('版本闸门：blocked 时抛错，错误信息可直接贴进 issue', () => {
  const gate = new VersionGate({ engineRange: '>=0.2.1-rc.1 <0.3.0', allowUnverified: false });
  assert.throws(() => gate.assertOrThrow('0.1.7-rc.2', logger), /超出 engines.dsh 范围/);
  assert.doesNotThrow(() => gate.assertOrThrow('0.2.1-rc.3', logger));
});

test('适配器选择：按产品线精确匹配，0.3.x 走预留适配器', () => {
  const registry = new AdapterRegistry();
  assert.equal(registry.select('0.2.1-rc.1', logger).id, 'dsh-0.2.x');
  assert.equal(registry.select('0.2.2-rc.1', logger).id, 'dsh-0.2.x');
  assert.equal(registry.select('0.3.0', logger).id, 'dsh-0.3.x');
  const adapters = registry.list().map((a) => `${a.id}@${a.range}`);
  assert.equal(adapters.length, 2);
});

test('适配器：0.3.x 适配器对未验证版本主动降级危险接缝（里氏替换仍成立）', () => {
  const registry = new AdapterRegistry();
  const adapter = registry.select('0.3.0', logger);
  const ctx = {
    version: '0.3.0',
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    emit: () => {},
    effect: () => {},
    get: () => ({ read: async () => null, write: async () => {} }),
  };
  const resolved = adapter.resolve(ctx, '0.3.0');
  assert.equal(resolved.capabilities.toolRegister, true);
  assert.equal(resolved.capabilities.toolGuard, false, '未验证版本上关闭单调守卫');
  assert.equal(resolved.capabilities.sessionState, false, '未验证版本上不写会话状态');
  assert.ok(resolved.downgraded.length >= 2);
});

test('能力探测：接缝缺失时能力清单整体归零（不会假装可用）', () => {
  const registry = new AdapterRegistry();
  const adapter = registry.select('0.2.1-rc.1', logger);
  const resolved = adapter.resolve({ version: '0.2.1-rc.1' }, '0.2.1-rc.1');
  assert.equal(Object.values(resolved.capabilities).every((v) => v === false), true);
  assert.equal(resolved.bridge.tools, undefined);
});
