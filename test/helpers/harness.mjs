import { MemoryLogger, MemoryNotifier, ManualClock, SequentialIdGenerator } from '../../dist/index.js';
import { MemoryArtifactStore } from '../../dist/adapters/storage/artifacts.js';
import { Fnv1aHasher } from '../../dist/adapters/hash/sha256.js';
import { MemoryDocumentStore } from '../../dist/adapters/storage/documents.js';
import { mount } from '../../dist/plugin.js';

/**
 * 模拟宿主
 *
 * 目标不是"假装跑过真机"，而是把宿主契约压缩成可断言的最小实现：
 * 工具注册、单调守卫、pre-execute 水位线、会话事件、会话状态、ctx.effect。
 * 每个接缝都可以按版本/配置关闭，用来验证降级路径。
 */
export class FakeHarness {
  constructor(options = {}) {
    this.options = options;
    this.version = options.version ?? '0.2.1-rc.1';
    this.tools = new Map();
    this.guards = [];
    this.preExecute = [];
    this.disposers = [];
    this.emitted = [];
    this.store = options.store ?? new Map();
    this.effects = [];
    this.unloaded = false;

    const self = this;
    this.sessionState = options.noState
      ? undefined
      : {
          read: async (key) => (self.store.has(key) ? self.store.get(key) : null),
          write: async (key, value) => {
            if (value === null) self.store.delete(key);
            else self.store.set(key, value);
          },
        };

    this.ctx = {
      version: this.version,
      ...(options.noTools
        ? {}
        : {
            tools: {
              register: (definition) => {
                self.tools.set(definition.name, definition);
                const dispose = () => self.tools.delete(definition.name);
                self.disposers.push(dispose);
                return dispose;
              },
              ...(options.noGuard
                ? {}
                : {
                    guard: (fn) => {
                      self.guards.push(fn);
                      const dispose = () => {
                        self.guards = self.guards.filter((g) => g !== fn);
                      };
                      self.disposers.push(dispose);
                      return dispose;
                    },
                  }),
            },
          }),
      ...(options.noEvents
        ? {}
        : {
            on: (event, handler) => {
              if (event === 'tools/pre-execute') self.preExecute.push(handler);
              const dispose = () => {
                self.preExecute = self.preExecute.filter((h) => h !== handler);
              };
              self.disposers.push(dispose);
              return dispose;
            },
          }),
      ...(options.noEmit
        ? {}
        : {
            emit: (type, payload) => {
              self.emitted.push({ type, payload });
            },
          }),
      ...(options.noEffect
        ? {}
        : {
            effect: (register) => {
              const dispose = register();
              self.effects.push(dispose);
              self.disposers.push(dispose);
            },
          }),
      get: (name) => (name === 'sessionState' && !options.noState ? self.sessionState : undefined),
    };
  }

  mount(config) {
    this.logger = new MemoryLogger();
    this.notifier = new MemoryNotifier();
    this.clock = new ManualClock(this.options.startTime ?? '2026-11-05T09:00:00.000Z');
    this.artifacts = new MemoryArtifactStore();
    this.hasher = new Fnv1aHasher();
    this.documents = new MemoryDocumentStore();
    const runtime = mount({
      ctx: this.ctx,
      config,
      logger: this.logger,
      notifier: this.notifier,
      clock: this.clock,
      ids: new SequentialIdGenerator(),
      artifacts: this.artifacts,
      hasher: this.hasher,
      documents: this.documents,
    });
    this.runtime = runtime;
    return runtime;
  }

  async ready() {
    await this.runtime.ready;
    return this.runtime;
  }

  toolNames() {
    return [...this.tools.keys()].sort();
  }

  /** 模拟宿主自带的写入类工具（插件只负责拦截，不负责实现）。 */
  addHostTool(name, impl = async () => ({ written: true })) {
    this.tools.set(name, {
      name,
      description: `host tool ${name}`,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: `${name} ok` }] },
      execute: impl,
    });
    const dispose = () => this.tools.delete(name);
    this.disposers.push(dispose);
  }

  /** 复现宿主的执行顺序：pre-execute 瀑布 → 单调守卫 → 工具体 → render。 */
  async dispatch(name, args = {}, options = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`工具未注册：${name}`);
    const exec = {
      name,
      arguments: args,
      callId: options.callId ?? 'call-1',
      signal: options.signal ?? new AbortController().signal,
    };

    const step = (index) => async () => {
      if (index >= this.preExecute.length) return { kind: 'allow' };
      return this.preExecute[index](exec, step(index + 1));
    };
    const decision = await step(0)();

    if (decision.kind !== 'allow') {
      return { blocked: true, decision, value: null, text: '' };
    }
    for (const guard of this.guards) {
      const denied = guard(exec);
      if (denied) return { blocked: true, decision: { kind: 'deny', reason: denied }, value: null, text: '' };
    }

    const value = await tool.execute(args, { signal: exec.signal, callId: exec.callId });
    const blocks = tool.output.render(args, value);
    return { blocked: false, decision, value, blocks, text: blocks.map((b) => b.text).join('\n') };
  }

  async unload() {
    for (const dispose of [...this.disposers].reverse()) {
      try {
        await dispose();
      } catch {
        /* 卸载期间的单点失败不应中断整体清理 */
      }
    }
    this.disposers = [];
    this.unloaded = true;
  }

  leftover() {
    return { tools: this.tools.size, guards: this.guards.length, preExecute: this.preExecute.length };
  }
}

/** 标准流程：建档 → 落稿 → 标来源 → 交付。返回 task_id，供后续断言使用。 */
export async function seedDeliveredTask(harness, options = {}) {
  const start = await harness.dispatch('xianshou_start', {
    title: options.title ?? '重构订单模块',
    repeatable: true,
    within_competence: true,
    growth_relevant: true,
  });
  if (!start.value?.ok) throw new Error(`建档失败：${JSON.stringify(start.value)}`);
  const taskId = start.value.task_id;

  await harness.dispatch('xianshou_draft', {
    task_id: taskId,
    content: options.draft ??
      '# 订单模块重构\n' +
        '1. 先拆出领域模型：订单、库存、支付三块契约各自固定。\n' +
        '2. 因为库存扣减与订单状态强耦合，所以先做库存适配层，把契约留在适配器里。\n' +
        '3. 结论：先做防腐层，再迁移状态机；最大风险是迁移顺序，先补集成测试。',
    minutes_spent: 22,
  });

  const segments = options.segments ?? [
    { segment_id: 'sec-1', tag: 'self', weight: 400 },
    { segment_id: 'sec-2', tag: 'ai', weight: 150 },
    { segment_id: 'sec-3', tag: 'revised', weight: 250 },
  ];
  for (const segment of segments) {
    await harness.dispatch('xianshou_mark', { task_id: taskId, ...segment });
  }

  await harness.dispatch('xianshou_deliver', { task_id: taskId });
  return taskId;
}
