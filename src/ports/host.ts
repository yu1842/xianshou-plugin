import type { ContentBlockModel } from '../ui/card.js';

/**
 * 端口 · 宿主接缝（Host Seams）
 *
 * 这是全插件唯一知道"宿主长什么样"的契约集合，但它只描述形状，不 import 宿主代码。
 * 好处：换版本时只需要换实现（adapters/harness/*），领域层与应用层完全不动。
 * 接口按"能力"拆开（接口隔离），能力缺失时对应功能降级，而不是整个插件拒绝启动。
 */

/** 宿主侧工具调用的最小结构。字段名对齐 DSH 的 ToolExecution。 */
export interface ToolExecutionLike {
  readonly name: string;
  readonly callId?: string;
  readonly arguments: unknown;
  readonly agent?: unknown;
}

/** 前置决策：与 DSH `PreToolDecision` 对齐，但只建模我们需要的三种。 */
export type PreToolDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason?: string; readonly displayReason?: Record<string, string> };

export interface ToolSchemaLike {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ToolOutputLike {
  readonly schema: Record<string, unknown>;
  render(args: unknown, value: unknown): ContentBlockModel[];
}

export interface ToolDefinitionLike extends ToolSchemaLike {
  readonly output: ToolOutputLike;
  execute(args: unknown, exec: unknown): Promise<unknown>;
  presentCall?(args: unknown): unknown;
  presentResult?(args: unknown, result: unknown): unknown;
  readonly timeoutMs?: number;
  isConcurrencySafe?(args: unknown): boolean;
}

export interface ToolRegistrar {
  register(definition: ToolDefinitionLike): () => void;
}

export type ToolGuardFn = (execution: Readonly<ToolExecutionLike>) => string | undefined;

export interface GuardRegistrar {
  /** 单调守卫：只能拒绝，不能被后续监听器改回允许。 */
  guard(fn: ToolGuardFn): () => void;
}

export interface PolicySeam {
  onPreExecute(
    handler: (exec: Readonly<ToolExecutionLike>, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>,
  ): () => void;
}

export interface SessionSink {
  emit(type: string, payload: unknown): void;
}

/** 生命周期接缝：定时器等非托管资源必须经由它注册释放函数，否则卸载后会泄漏。 */
export interface LifecycleSeam {
  effect(register: () => () => void): void;
}

/** 宿主能力清单。启动时探测一次，作为"降级决策"的唯一依据。 */
export interface HostCapabilities {
  readonly toolRegister: boolean;
  readonly toolGuard: boolean;
  readonly preExecute: boolean;
  readonly postExecute: boolean;
  readonly sessionState: boolean;
  readonly sessionEvents: boolean;
}

export const NO_CAPABILITIES: HostCapabilities = Object.freeze({
  toolRegister: false,
  toolGuard: false,
  preExecute: false,
  postExecute: false,
  sessionState: false,
  sessionEvents: false,
});

export interface HostBridge {
  /** 宿主版本号（semver 原文，如 0.2.1-rc.1）。 */
  readonly version: string;
  readonly capabilities: HostCapabilities;
  readonly tools?: ToolRegistrar;
  readonly guards?: GuardRegistrar;
  readonly policy?: PolicySeam;
  readonly session?: SessionSink;
  readonly lifecycle?: LifecycleSeam;
  /** 宿主原生的会话状态读写；缺失时由存储适配器降级到文件。 */
  readonly state?: {
    read(key: string): Promise<unknown>;
    write(key: string, value: unknown): Promise<void>;
  };
}

export function missingCapabilities(bridge: HostBridge, required: readonly (keyof HostCapabilities)[]): string[] {
  return required.filter((key) => bridge.capabilities[key] !== true).map(String);
}
