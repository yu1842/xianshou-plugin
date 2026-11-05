import type {
  GuardRegistrar,
  HostBridge,
  HostCapabilities,
  LifecycleSeam,
  PolicySeam,
  PreToolDecision,
  SessionSink,
  ToolDefinitionLike,
  ToolExecutionLike,
  ToolGuardFn,
  ToolRegistrar,
} from '../../ports/host.js';
import { methodOf, readHost } from './probe.js';
import { satisfies } from './version.js';

/**
 * 适配器抽象
 *
 * 这里用的是模板方法：`resolve()` 固定"探测 → 组装 → 降级"的骨架，
 * 具体怎么从 ctx 拿到接缝、哪些能力要主动降级，由子类决定。
 * 加一条新产品线时只需新增一个子类并注册，插件的其余部分不动（开闭原则）。
 */
export abstract class HarnessAdapter {
  abstract readonly id: string;
  /** 负责的产品线，如 "0.2"。 */
  abstract readonly productLine: string;
  /** 该适配器声明的版本范围（semver range 原文）。 */
  abstract readonly range: string;

  supports(version: string): boolean {
    return satisfies(version, this.range);
  }

  /**
   * 只允许"削减"能力，不允许凭空添加：
   * 子类若声称某个宿主没有的能力可用，会导致运行期抛错而不是优雅降级，
   * 因此这里用 readonly 契约把降级方向锁死（里氏替换的前提）。
   */
  protected degrade(probed: HostCapabilities, _version: string): HostCapabilities {
    return probed;
  }

  resolve(ctx: unknown, version: string): BridgeResolution {
    const probed = this.probeCapabilities(ctx, version);
    const effective = this.degrade(probed, version);
    const downgraded = (Object.keys(probed) as (keyof HostCapabilities)[]).filter((k) => probed[k] && !effective[k]);
    return {
      adapterId: this.id,
      version,
      capabilities: effective,
      downgraded,
      bridge: this.buildBridge(ctx, version, effective),
    };
  }

  protected abstract probeCapabilities(ctx: unknown, version: string): HostCapabilities;
  protected abstract buildBridge(ctx: unknown, version: string, capabilities: HostCapabilities): HostBridge;
}

/** 组装期可写、对外只读：避免在每个接缝上写四次 `as` 断言。 */
type MutableBridge = { -readonly [K in keyof HostBridge]: HostBridge[K] };

export interface BridgeResolution {
  readonly adapterId: string;
  readonly version: string;
  readonly capabilities: HostCapabilities;
  readonly downgraded: readonly (keyof HostCapabilities)[];
  readonly bridge: HostBridge;
}

/**
 * 0.2.1 / 0.2.2 线适配器
 *
 * 0.2.1-rc.1 引入的四类接缝：ctx.tools.register / ctx.tools.guard /
 * tools/pre-execute 事件 / 会话状态读写。0.2.2 未改变这些形状。
 */
export class AdapterV0201 extends HarnessAdapter {
  readonly id: string = 'dsh-0.2.x';
  readonly productLine: string = '0.2';
  readonly range: string = '>=0.2.1-rc.1 <0.3.0';

  constructor(private readonly probe: { probe(ctx: unknown): HostCapabilities }) {
    super();
  }

  protected override probeCapabilities(ctx: unknown): HostCapabilities {
    return this.probe.probe(ctx);
  }

  protected override buildBridge(ctx: unknown, version: string, capabilities: HostCapabilities): HostBridge {
    const host = readHost(ctx);
    const bridge: MutableBridge = { version, capabilities };

    if (capabilities.toolRegister) {
      const tools = makeToolRegistrar(host.tools);
      if (tools) bridge.tools = tools;
    }
    if (capabilities.toolGuard) {
      const guards = makeGuardRegistrar(host.tools);
      if (guards) bridge.guards = guards;
    }
    if (capabilities.preExecute) {
      const policy = makePolicySeam(ctx);
      if (policy) bridge.policy = policy;
    }
    if (capabilities.sessionEvents) {
      const session = makeSessionSink(ctx);
      if (session) bridge.session = session;
    }
    if (capabilities.sessionState && host.sessionState) {
      bridge.state = makeStateSeam(host.sessionState);
    }
    const lifecycle = makeLifecycle(ctx);
    if (lifecycle) bridge.lifecycle = lifecycle;
    return bridge;
  }
}

/**
 * 0.3.x 预留适配器
 *
 * 为什么提前写：为了证明架构的扩展成本是一"个"子类，而不是一次重构。
 * 默认策略：未经验证的版本上，主动关闭表现层（presentCall/presentResult），
 * 只保留工具与闸门。理由是"缺失卡片"只影响观感，而"形状不符的卡片"会让整个
 * 工具调用渲染失败 —— 两种失败模式的代价不对称。
 */
export class AdapterV0300 extends AdapterV0201 {
  override readonly id = 'dsh-0.3.x';
  override readonly productLine = '0.3';
  override readonly range = '>=0.3.0 <0.4.0';

  protected override degrade(probed: HostCapabilities, _version: string): HostCapabilities {
    // 未验证版本上，凡"拒绝/覆写"类接缝一律关闭：
    // 拦截错了会挡住用户，状态接口形状变了会写坏数据 —— 两种代价都远大于少一层保护。
    return {
      ...probed,
      toolGuard: false,
      postExecute: false,
      sessionState: false,
    };
  }
}

function makeToolRegistrar(tools: unknown): ToolRegistrar | null {
  const register = methodOf(tools, 'register');
  if (!register) return null;
  return {
    register(definition: ToolDefinitionLike): () => void {
      const disposer = register.call(tools, definition);
      return typeof disposer === 'function' ? (disposer as () => void) : () => {};
    },
  };
}

function makeGuardRegistrar(tools: unknown): GuardRegistrar | null {
  const guard = methodOf(tools, 'guard');
  if (!guard) return null;
  return {
    guard(fn: ToolGuardFn): () => void {
      const disposer = guard.call(tools, fn);
      return typeof disposer === 'function' ? (disposer as () => void) : () => {};
    },
  };
}

function makePolicySeam(ctx: unknown): PolicySeam | null {
  const on = methodOf(ctx, 'on');
  if (!on) return null;
  return {
    onPreExecute(handler: (exec: Readonly<ToolExecutionLike>, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>): () => void {
      const disposer = on.call(ctx, 'tools/pre-execute', handler);
      return typeof disposer === 'function' ? (disposer as () => void) : () => {};
    },
  };
}

function makeSessionSink(ctx: unknown): SessionSink | null {
  const emit = methodOf(ctx, 'emit');
  if (!emit) return null;
  return {
    emit(type: string, payload: unknown): void {
      emit.call(ctx, type, payload);
    },
  };
}

function makeStateSeam(state: unknown): NonNullable<HostBridge['state']> {
  const read = methodOf(state, 'read');
  const write = methodOf(state, 'write');
  if (!read || !write) throw new Error('state seam incomplete');
  return {
    read: async (key: string) => read.call(state, key),
    write: async (key: string, value: unknown) => {
      await write.call(state, key, value);
    },
  };
}

function makeLifecycle(ctx: unknown): LifecycleSeam | null {
  const effect = methodOf(ctx, 'effect');
  if (!effect) return null;
  return {
    effect(register: () => () => void): void {
      effect.call(ctx, register);
    },
  };
}
