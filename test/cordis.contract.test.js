import test from 'node:test';
import assert from 'node:assert/strict';

import { mount, VERSION_FALLBACK } from '../dist/index.js';
import { MemoryLogger, ManualClock, SequentialIdGenerator, MemoryNotifier } from '../dist/index.js';

/**
 * Cordis 上下文契约
 *
 * Cordis 的 Context 是 Proxy：**读取未 inject 的服务属性会直接抛错**
 * （cannot get property "x" without inject）。
 * 这类错误只会在真实宿主里出现，用普通对象做假 ctx 的测试永远发现不了。
 * 所以这里用一个"严格 Proxy"复现该语义。
 */

function strictCtx(base) {
  const allowed = new Set(Object.keys(base));
  return new Proxy(base, {
    get(target, key) {
      if (key === 'then') return undefined; // 避免被当成 thenable
      if (typeof key === 'symbol') return target[key];
      if (allowed.has(key)) return target[key];
      throw new Error(`cannot get property "${String(key)}" without inject`);
    },
    has() {
      return true;
    },
  });
}

function baseCtx(overrides = {}) {
  const tools = new Map();
  return {
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
      guard: () => () => {},
    },
    on: () => () => {},
    effect: (register) => register(),
    emit: () => {},
    get: (name) => (name === 'tools' ? undefined : undefined),
    ...overrides,
  };
}

function mountWith(ctx) {
  const logger = new MemoryLogger();
  const runtime = mount({
    ctx,
    config: { storage: { mode: 'memory' } },
    logger,
    notifier: new MemoryNotifier(),
    clock: new ManualClock(),
    ids: new SequentialIdGenerator(),
  });
  return { runtime, logger };
}

test('Cordis 契约：直接读未注入的服务属性会抛错——先用这个假 ctx 证明它确实会抛', () => {
  const ctx = strictCtx(baseCtx());
  assert.throws(() => ctx.version, /cannot get property "version" without inject/);
});

test('插件激活：严格上下文下不抛错（版本探测不能把整个插件打断）', async () => {
  const ctx = strictCtx(baseCtx());
  const { runtime, logger } = mountWith(ctx);
  await runtime.ready;

  assert.equal(runtime.version, VERSION_FALLBACK, '读不到版本时回落基线，而不是崩溃');
  assert.equal(runtime.capabilities.find((c) => c.id === 'toolset').status, 'applied');
  assert.equal(runtime.capabilities.find((c) => c.id === 'gate').status, 'applied');
  assert.ok(logger.entries.some((e) => e.message.includes('未能从宿主读到版本号')));
});

test('插件激活：ctx.get 也抛错时仍然能挂载（两条探测路径都要容错）', async () => {
  const ctx = strictCtx(
    baseCtx({
      get() {
        throw new Error('cannot get property without inject');
      },
    }),
  );
  const { runtime } = mountWith(ctx);
  await runtime.ready;
  assert.equal(runtime.capabilities.find((c) => c.id === 'toolset').status, 'applied');
});

test('版本探测：直读 version 会抛、ctx.get("version") 可读——复现 0.2.1-rc.3 真机行为', async () => {
  // 真机观测：0.2.1-rc.3 上直读 ctx.version 抛 "cannot get property"，
  // 说明 version 是已定义服务；此时 get() 应当能读到真实版本，而不是回落基线。
  const ctx = strictCtx(
    baseCtx({
      get: (name) => (name === 'version' ? '0.2.1-rc.3' : undefined),
    }),
  );
  assert.throws(() => ctx.version, /without inject/);
  const { runtime, logger } = mountWith(ctx);
  await runtime.ready;
  assert.equal(runtime.version, '0.2.1-rc.3');
  assert.ok(!logger.entries.some((e) => e.message.includes('未能从宿主读到版本号')), '读到真实版本时不应告警');
});

test('版本探测：版本挂在 app 服务上时也能读到', async () => {
  const ctx = strictCtx(
    baseCtx({
      get: (name) => (name === 'app' ? { version: '0.2.1-rc.5' } : undefined),
    }),
  );
  const { runtime } = mountWith(ctx);
  await runtime.ready;
  assert.equal(runtime.version, '0.2.1-rc.5');
});

test('版本探测：环境变量 DSH_VERSION 优先于探测', async () => {
  const previous = process.env.DSH_VERSION;
  process.env.DSH_VERSION = '0.2.1-rc.3';
  try {
    const ctx = strictCtx(baseCtx());
    const { runtime } = mountWith(ctx);
    await runtime.ready;
    assert.equal(runtime.version, '0.2.1-rc.3');
  } finally {
    if (previous === undefined) delete process.env.DSH_VERSION;
    else process.env.DSH_VERSION = previous;
  }
});

test('插件激活：十三个工具全部注册（严格上下文下也不缺）', async () => {
  const tools = new Map();
  const base = baseCtx();
  base.tools.register = (definition) => {
    tools.set(definition.name, definition);
    return () => tools.delete(definition.name);
  };
  const { runtime } = mountWith(strictCtx(base));
  await runtime.ready;
  assert.equal(tools.size, 13);
  assert.ok(tools.has('xianshou_export'));
  assert.ok(tools.has('xianshou_import'));
  assert.ok(tools.has('xianshou_camp'));
  assert.ok(tools.has('xianshou_probe'));
  assert.ok(tools.has('xianshou_start'));
});
