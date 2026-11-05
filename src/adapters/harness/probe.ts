import { NO_CAPABILITIES, type HostCapabilities } from '../../ports/host.js';

/**
 * 宿主上下文的结构化视图
 *
 * 这里刻意不使用任何宿主类型导入：插件对宿主的了解只通过"形状"表达，
 * 因此 0.2.1 / 0.2.2 / 0.3.x 的差异只影响本目录下的适配器，不影响上层。
 */

export type AnyRecord = Record<string, unknown>;

export function asRecord(value: unknown): AnyRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as AnyRecord) : undefined;
}

export function methodOf(target: unknown, key: string): ((...args: unknown[]) => unknown) | undefined {
  const record = asRecord(target);
  if (!record) return undefined;
  const candidate = record[key];
  return typeof candidate === 'function' ? (candidate as (...args: unknown[]) => unknown) : undefined;
}

export function propOf(target: unknown, key: string): unknown {
  return asRecord(target)?.[key];
}

/** 会话状态服务的候选名。不同 rc 之间的服务名存在差异，故按序探测。 */
const SESSION_STATE_NAMES = ['sessionState', 'session-state', 'sessionRecords', 'state'] as const;

export interface ProbedHost {
  readonly tools?: unknown;
  readonly on?: unknown;
  readonly effect?: unknown;
  readonly get?: unknown;
  readonly emit?: unknown;
  readonly sessionState?: unknown;
}

export function readHost(ctx: unknown): ProbedHost {
  const record = asRecord(ctx);
  if (!record) return {};
  const getFn = methodOf(ctx, 'get');
  const resolve = (name: string): unknown => {
    const direct = record[name];
    if (direct !== undefined) return direct;
    if (!getFn) return undefined;
    try {
      return getFn.call(ctx, name);
    } catch {
      return undefined;
    }
  };
  let sessionState: unknown;
  for (const name of SESSION_STATE_NAMES) {
    const candidate = resolve(name);
    if (candidate && methodOf(candidate, 'read') && methodOf(candidate, 'write')) {
      sessionState = candidate;
      break;
    }
  }
  return {
    tools: record['tools'],
    on: record['on'],
    effect: record['effect'],
    get: getFn,
    emit: record['emit'],
    sessionState,
  };
}

/**
 * 能力探测
 *
 * 只探测"是否存在"，不探测"语义是否一致"。首次使用时若抛错，
 * 适配器会把该能力降级（见 HarnessAdapter.#installSafely），
 * 因为一个"存在但签名变了"的方法比一个不存在的方法更危险。
 */
export class CapabilityProbe {
  probe(ctx: unknown): HostCapabilities {
    const host = readHost(ctx);
    const tools = host.tools;
    const hasRegister = methodOf(tools, 'register') !== undefined;
    const hasGuard = methodOf(tools, 'guard') !== undefined;
    const hasOn = methodOf(host, 'on') !== undefined;
    const stateRead = host.sessionState ? methodOf(host.sessionState, 'read') : undefined;
    const stateWrite = host.sessionState ? methodOf(host.sessionState, 'write') : undefined;

    if (!hasRegister && !hasOn) return NO_CAPABILITIES;

    return {
      toolRegister: hasRegister,
      toolGuard: hasGuard,
      // 事件接缝的可用性依赖 ctx.on；具体事件名在 0.2.x 内保持一致。
      preExecute: hasOn && hasRegister,
      postExecute: hasOn && hasRegister,
      sessionState: Boolean(stateRead && stateWrite),
      sessionEvents: methodOf(host, 'emit') !== undefined,
    };
  }
}
