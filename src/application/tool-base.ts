import { card } from '../ui/card.js';
import type { CardModel } from '../ui/card.js';
import { DomainError } from '../domain/model.js';
import { asArgs, schemaObject, stringProp, type Args } from './args.js';
import type { ToolResult } from './TaskService.js';

/**
 * 工具基类
 *
 * 统一处理四件与业务无关的事（模板方法）：
 *   1. 入参形状校验
 *   2. 取消信号检查（协作式，符合宿主 tools/execute 的取消契约）
 *   3. 领域错误 → 结构化失败结果（让模型能自我修正，而不是看到一堆栈）
 *   4. 把 CardModel 挂进 value，使 output.render 保持纯函数
 *
 * 子类只写 name / description / parameters / run()，其余一概不碰。
 */

export interface ToolInvocation {
  readonly signal?: AbortSignal | undefined;
  readonly callId?: string | undefined;
}

/** 所有工具共享的输出契约：ok + card 必备，其余按工具自定义。 */
export const BASE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['ok', 'card'],
  properties: {
    ok: { type: 'boolean', description: '本次调用是否成功' },
    card: { type: 'object', description: '面向界面的卡片模型（render 的输入）' },
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' }, hint: { type: 'string' } },
    },
  },
  additionalProperties: true,
};

export abstract class XianshouTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown> = BASE_OUTPUT_SCHEMA;
  /** 协作式超时预算。所有工具都是本地 IO，3 秒足够。 */
  readonly timeoutMs = 3000;
  /** 同一 turn 内并发执行不会互相破坏状态：仓储按任务 id 写入，服务无共享可变状态。 */
  isConcurrencySafe(args: unknown): boolean {
    const taskId = typeof args === 'object' && args !== null ? (args as Args)['task_id'] : undefined;
    return typeof taskId === 'string';
  }

  async invoke(raw: unknown, invocation: ToolInvocation = {}): Promise<ToolResult & { value: Record<string, unknown> }> {
    if (invocation.signal?.aborted) {
      return failureCard('CANCELLED', '调用已取消，未做任何修改。');
    }
    try {
      const args = asArgs(raw);
      const result = await this.run(args, invocation);
      return { ...result, value: { ok: true, ...result.value, card: result.card } };
    } catch (error) {
      if (error instanceof DomainError) {
        return failureCard(error.code, error.message, error.hint);
      }
      throw error;
    }
  }

  protected abstract run(args: Args, invocation: ToolInvocation): Promise<ToolResult>;
}

/** 失败也要有卡片：静默失败会让用户以为操作成功了。 */
export function failureCard(code: string, message: string, hint?: string): ToolResult {
  const nodes = [
    { kind: 'paragraph' as const, text: message },
    ...(hint ? [{ kind: 'callout' as const, tone: 'accent' as const, title: '怎么修正', text: hint }] : []),
    { kind: 'footnote' as const, text: `错误码 ${code}` },
  ];
  const model: CardModel = card('danger', '操作未完成', nodes);
  return {
    value: { ok: false, error: { code, message, ...(hint ? { hint } : {}) }, card: model },
    card: model,
  };
}

/** 供 render 使用的取值器：value 的形状由各工具自定，这里只做安全下探。 */
export function cardFromValue(value: unknown): CardModel {
  const candidate = (value as { card?: CardModel } | null)?.card;
  if (candidate && typeof candidate.title === 'string' && Array.isArray(candidate.nodes)) return candidate;
  return card('neutral', '无可展示内容', [{ kind: 'paragraph', text: '该结果没有附带卡片。' }]);
}

/** 参数空对象（无参数工具用）。 */
export const EMPTY_PARAMS = schemaObject({}, []);
export const TASK_ID_PROP = stringProp('任务 ID，由 xianshou_start 返回，形如 xs-xxxxxx', { examples: ['xs-1a2b3c'] });
