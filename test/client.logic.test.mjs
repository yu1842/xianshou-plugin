import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const client = require('../client/client.js');
const {
  PANEL_ID,
  MODULES,
  PERMISSIONS,
  parseRoute,
  formatRoute,
  resolveAccess,
  reduceFeed,
  emptyFeed,
  deriveOverview,
  refusalTally,
  filterTasks,
  aiBand,
} = client.__internals;

// ── 路由 ──────────────────────────────────────────────

test('路由：默认进入概览，未知模块回落到概览而不是白屏', () => {
  assert.equal(parseRoute('').module, 'overview');
  assert.equal(parseRoute('#xianshou').module, 'overview');
  assert.equal(parseRoute('#xianshou/not-a-module').module, 'overview');
  assert.equal(parseRoute('#xianshou/tasks').module, 'tasks');
});

test('路由：模块 / 任务 id / 查询条件三段都能解析，且可逆', () => {
  const route = parseRoute('#xianshou/tasks/xs-0001?zone=red&q=%E8%AE%A2%E5%8D%95');
  assert.equal(route.module, 'tasks');
  assert.equal(route.id, 'xs-0001');
  assert.deepEqual(route.query, { zone: 'red', q: '订单' });
  assert.equal(formatRoute(route), '#xianshou/tasks/xs-0001?zone=red&q=%E8%AE%A2%E5%8D%95');
});

test('路由：非法 id 不会因为 decodeURIComponent 抛错而打断渲染', () => {
  const route = parseRoute('#xianshou/tasks/%E0%A4%A');
  assert.equal(route.module, 'tasks');
  assert.equal(typeof route.id, 'string');
});

test('路由：空查询不产生多余的问号（深链要干净）', () => {
  assert.equal(formatRoute({ module: 'health', id: null, query: {} }), '#xianshou/health');
  assert.equal(formatRoute({ module: 'health', id: null, query: { q: '' } }), '#xianshou/health');
});

// ── 权限 ──────────────────────────────────────────────

test('权限：宿主提供 has() 时以其判定为准，缺少 operate 降级为只读', () => {
  const viewOnly = { permissions: { has: (key) => key === PERMISSIONS.view } };
  assert.equal(resolveAccess(viewOnly).level, 'view');
  assert.equal(resolveAccess(viewOnly).source, 'host');

  const full = { permissions: { has: () => true } };
  assert.equal(resolveAccess(full).level, 'operate');

  const none = { permissions: { has: () => false } };
  const denied = resolveAccess(none);
  assert.equal(denied.level, 'locked', '宿主拒绝时入口保留但锁定，不能静默消失');
  assert.match(denied.reason, new RegExp(PERMISSIONS.view));
});

test('权限：宿主服务抛错时按拒绝处理（fail closed），不猜测用户角色', () => {
  const broken = {
    permissions: {
      has() {
        throw new Error('boom');
      },
    },
  };
  assert.equal(resolveAccess(broken).level, 'locked');
});

test('权限：探测不泛化到 ctx.auth / ctx.get(\'access\')，避免把无关服务当权限源', () => {
  const featureFlags = { has: () => false };
  assert.equal(resolveAccess({ auth: featureFlags }).level, 'view', 'ctx.auth 不应被当作权限服务');
  assert.equal(resolveAccess({ get: (name) => (name === 'access' ? featureFlags : null) }).level, 'view');
  assert.equal(resolveAccess({ permissions: featureFlags }).level, 'locked', '只有明确命名的 permissions 才认');
});

test('权限：没有平台权限服务时按只读开放，并说明原因', () => {
  const access = resolveAccess(null);
  assert.equal(access.level, 'view');
  assert.equal(access.source, 'default');
  assert.match(access.reason, /未检测到平台权限服务/);
});

test('权限：部署可显式覆盖（隐藏入口是唯一需要显式配置的动作）', () => {
  assert.equal(resolveAccess(null, { access: 'hidden' }).level, 'hidden');
  assert.equal(resolveAccess(null, { access: 'deny' }).level, 'hidden', 'deny 是旧写法，等价 hidden');
  assert.equal(resolveAccess(null, { access: 'operate' }).level, 'operate');
  assert.equal(
    resolveAccess({ permissions: { has: () => false } }, { access: 'operate' }).level,
    'locked',
    '宿主拒绝不能被配置放宽成可写',
  );
  assert.equal(
    resolveAccess({ permissions: { has: () => false } }, { access: 'hidden' }).level,
    'hidden',
    '显式配置可以把入口彻底藏掉',
  );
});

// ── 事件归约 ──────────────────────────────────────────

const EVENTS = [
  { type: 'xianshou/domain-event', payload: { type: 'task.created', taskId: 'xs-1', zone: 'red', title: '重构订单模块' } },
  { type: 'xianshou/domain-event', payload: { type: 'draft.accepted', taskId: 'xs-1', chars: 120 } },
  { type: 'xianshou/domain-event', payload: { type: 'segment.marked', taskId: 'xs-1', tag: 'ai', aiRatio: 0.62 } },
  { type: 'xianshou/domain-event', payload: { type: 'task.delivered', taskId: 'xs-1', gates: [{ window: 'd24h', scheduledFor: '2026-11-06T09:00:00Z' }, { window: 'd7d', scheduledFor: '2026-11-12T09:00:00Z' }] } },
  { type: 'xianshou/domain-event', payload: { type: 'task.created', taskId: 'xs-2', zone: 'green', title: '翻译一段话' } },
  { type: 'xianshou/gate-denied', payload: { taskId: 'xs-1', tool: 'write' } },
  { type: 'xianshou/notify', payload: { id: 'n1', title: '24 小时回收到期' } },
];

function replay(events) {
  return events.reduce((state, event) => reduceFeed(state, event), emptyFeed());
}

test('事件归约：一次完整链路折叠出正确的任务状态与计数', () => {
  const state = replay(EVENTS);
  assert.equal(state.order.length, 2);
  assert.equal(state.tasks['xs-1'].title, '重构订单模块');
  assert.equal(state.tasks['xs-1'].hasDraft, true);
  assert.equal(state.tasks['xs-1'].aiRatio, 0.62);
  assert.equal(state.tasks['xs-1'].status, 'delivered');
  assert.equal(state.tasks['xs-1'].gates.length, 2);
  assert.equal(state.denials.length, 1);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.events, 7);

  const stats = deriveOverview(Object.values(state.tasks));
  assert.equal(stats.total, 2);
  assert.equal(stats.zones.red, 1);
  assert.equal(stats.zones.green, 1);
  assert.equal(stats.pendingRecalls, 2);
});

test('事件归约：收回失败会把任务降级为黄区 + rework（与宿主侧规则一致）', () => {
  const state = replay([
    { type: 'xianshou/domain-event', payload: { type: 'task.created', taskId: 'xs-3', zone: 'red', title: 'T' } },
    { type: 'xianshou/domain-event', payload: { type: 'recall.failed', taskId: 'xs-3', score: 0.4 } },
  ]);
  assert.equal(state.tasks['xs-3'].zone, 'yellow');
  assert.equal(state.tasks['xs-3'].status, 'rework');
});

test('事件归约：未知事件与畸形输入被忽略，不污染状态', () => {
  const state = replay([
    { type: 'xianshou/domain-event', payload: { type: 'something.else', taskId: 'xs-9' } },
    { type: 'xianshou/unknown', payload: {} },
    null,
    'nonsense',
  ]);
  assert.equal(state.events >= 0, true);
  assert.deepEqual(Object.keys(state.tasks).filter((id) => id !== 'xs-9'), []);
});

test('事件归约：纯函数，重复归约同一条事件不会破坏结构', () => {
  const once = replay(EVENTS);
  const twice = reduceFeed(once, EVENTS[0]);
  assert.equal(twice.tasks['xs-1'].zone, 'red');
  assert.equal(once.events, 7);
  assert.equal(twice.events, 8);
  assert.equal(once.denials.length, 1, '原状态不被就地修改');
});

// ── 指标 ──────────────────────────────────────────────

test('拒绝率：样本不足不判定，半改按半权计', () => {
  const build = (accepted, rejected, partial) =>
    refusalTally([{ refusals: { accepted, rejected, partial } }]);

  assert.equal(build(1, 0, 0).band, 'insufficient', '1 条样本不下结论');
  assert.equal(build(9, 0, 0).band, 'blind');
  assert.equal(build(6, 1, 0).band, 'insufficient', '14.3% 未达健康下界 15%');
  assert.equal(build(5, 1, 0).band, 'healthy', '16.7% 落在健康区间');
  assert.equal(build(1, 1, 0).band, 'insufficient', '总量未达阈值仍不判定');
  const half = build(3, 0, 4);
  assert.equal(half.rate, 0.2857, '（0 + 4×0.5）/ 7');
});

test('比例分档：三档边界与空值处理', () => {
  assert.equal(aiBand(0).band, 'empty');
  assert.equal(aiBand(0.29).band, 'healthy');
  assert.equal(aiBand(0.3).band, 'recall');
  assert.equal(aiBand(0.6).band, 'recall');
  assert.equal(aiBand(0.61).band, 'rework');
});

test('筛选：分区 / 状态 / 关键词 / 排序可组合', () => {
  const tasks = [
    { id: 'xs-1', title: '重构订单模块', zone: 'red', status: 'open' },
    { id: 'xs-2', title: '翻译一段话', zone: 'green', status: 'delivered' },
    { id: 'xs-3', title: '整理会议纪要', zone: 'yellow', status: 'open' },
  ];
  assert.equal(filterTasks(tasks, { zone: 'red' }).length, 1);
  assert.equal(filterTasks(tasks, { zone: 'all' }).length, 3);
  assert.equal(filterTasks(tasks, { q: '订单' }).length, 1);
  assert.equal(filterTasks(tasks, { q: 'XS-2' }).length, 1, 'ID 搜索不区分大小写');
  assert.deepEqual(filterTasks(tasks, { sort: 'risk' }).map((t) => t.zone), ['red', 'yellow', 'green']);
  assert.equal(filterTasks(tasks, { status: 'delivered' }).length, 1);
});

// ── 注册 ──────────────────────────────────────────────

function fakeCtx(overrides = {}) {
  const registrations = [];
  const ctx = {
    slots: {
      inject(slot, factory) {
        factory();
        return () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    ...overrides,
  };
  return { ctx, registrations };
}

test('注册：入口在 sidebar.panellist，面板在 main，且 key 与 id 严格相等', () => {
  const { ctx, registrations } = fakeCtx();
  client.apply(ctx);

  const entry = registrations.find((r) => r.options.name === 'sidebar.panellist');
  const panel = registrations.find((r) => r.options.name === 'main');

  assert.ok(entry, '必须注册侧边栏入口');
  assert.equal(entry.options.id, PANEL_ID);
  assert.equal(typeof entry.options.label, 'function');
  assert.equal(entry.options.label(), '先手协议');
  assert.equal(typeof entry.component, 'function');

  assert.ok(panel, '必须注册整页面板');
  assert.equal(panel.options.key, PANEL_ID, 'main 是键控槽位，key 必须等于入口 id');
  assert.equal(typeof panel.component, 'function');
});

test('注册：宿主拒绝时仍然注册入口，让"没入口"不会成为不可排查的失败', () => {
  const { ctx, registrations } = fakeCtx({ permissions: { has: () => false }, config: {} });
  client.apply(ctx);
  assert.equal(registrations.length, 2, '入口与面板都要注册，点开是锁定说明页');
  assert.ok(registrations.some((r) => r.options.name === 'sidebar.panellist'));
});

test('注册：只有显式 access=hidden 才完全不注册', () => {
  const { ctx, registrations } = fakeCtx({ config: { access: 'hidden' } });
  client.apply(ctx);
  assert.equal(registrations.length, 0);
});

test('注册：模块声明完整且 id 唯一，入口与面板的 id 不漂移', () => {
  assert.equal(MODULES.length, 9);
  assert.equal(new Set(MODULES.map((m) => m.id)).size, MODULES.length);
  for (const module of MODULES) {
    assert.ok(module.label && module.icon && module.hint);
  }
});

test('包声明：双面导出与 client 平台声明就位', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['./client'], './client/client.js');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(pkg.files.includes('client'));
  assert.ok(pkg.exports['.'], '宿主半边不能被删掉');
});

// ── Cordis 严格上下文 ─────────────────────────────────

/** 复现 Cordis 语义：读未 inject 的属性会抛错。 */
function strictCtx(base) {
  const allowed = new Set(Object.keys(base));
  return new Proxy(base, {
    get(target, key) {
      if (key === 'then') return undefined;
      if (typeof key === 'symbol') return target[key];
      if (allowed.has(key)) return target[key];
      throw new Error(`cannot get property "${String(key)}" without inject`);
    },
    has() {
      return true;
    },
  });
}

test('客户端：严格上下文下 apply 不抛（探测 config / permissions 都要容错）', () => {
  const registrations = [];
  const base = {
    slots: {
      inject(_slot, factory) {
        factory();
        return () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    get: () => undefined,
  };
  const ctx = strictCtx(base);
  assert.throws(() => ctx.config, /without inject/, '先证明这个假 ctx 确实会抛');
  assert.doesNotThrow(() => client.apply(ctx));
  assert.equal(registrations.length, 2);
});

test('客户端：严格上下文下权限探测回落为只读，而不是崩溃', () => {
  const base = { get: () => undefined };
  const access = resolveAccess(strictCtx(base));
  assert.equal(access.level, 'view');
  assert.equal(access.source, 'default');
});

test('容错：拿不到 slots 服务时只报错不抛（"没有入口"的第二种可能）', () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const ctx = strictCtx({ get: () => undefined });
    assert.doesNotThrow(() => client.apply(ctx));
    assert.ok(errors.some((line) => line.includes('拿不到 slots 服务')), '必须留下可排查的错误');
  } finally {
    console.error = originalError;
  }
});

test('容错：单个槽位注册抛错时，另一个仍然注册（单点失败不拖垮整体）', () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const registered = [];
  try {
    const ctx = {
      slots: {
        inject(_slot, factory) {
          factory();
          return () => {};
        },
        register(options) {
          if (options.name === 'sidebar.panellist') throw new Error('unknown slot');
          registered.push(options.name);
          return () => {};
        },
      },
    };
    assert.doesNotThrow(() => client.apply(ctx));
    assert.deepEqual(registered, ['main'], '入口失败不应影响面板注册');
    assert.ok(errors.some((line) => line.includes('注册槽位失败')));
  } finally {
    console.error = originalError;
  }
});
