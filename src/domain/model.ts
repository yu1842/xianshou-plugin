/**
 * 领域层 · 值对象与基础类型
 *
 * 本文件不依赖 Cordis、Node 内置模块或任何第三方库。
 * 领域层是插件中唯一"可以脱离宿主单独测试"的部分，所有阈值判断都由它承担。
 */

/** 任务风险分区。红=必须先手；黄=可先问但须能复述；绿=放开用。 */
export type Zone = 'red' | 'yellow' | 'green';

/** 段来源标记：[自] 自己想的 / [AI] 未实质修改 / [改] 实质修改过。 */
export type SourceTag = 'self' | 'ai' | 'revised';

/** 任务生命周期。`rework` 表示被闸门打回，必须重做一次先手。 */
export type TaskStatus = 'open' | 'delivered' | 'rework';

/** 回收窗口：交付后 24 小时与 7 天。 */
export type RecallWindow = 'd24h' | 'd7d';

/** 回收判定结论。 */
export type RecallVerdict = 'pass' | 'fail' | 'pending';

/** 拒绝率健康度区间。 */
export type RefusalBand = 'insufficient' | 'blind' | 'healthy' | 'contrarian';

/**
 * 品牌类型工具：让 TaskId 与普通 string 在类型层面不可互换。
 * 运行期零开销，只在编译期提供保护。
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type TaskId = Brand<string, 'TaskId'>;

export function asTaskId(raw: string): TaskId {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw)) {
    throw new DomainError('INVALID_TASK_ID', `任务 ID 非法：${raw}`);
  }
  return raw as TaskId;
}

/** 领域错误：可被工具层翻译成模型可读的失败原因，不做进程级异常。 */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export type DomainErrorCode =
  | 'INVALID_TASK_ID'
  | 'TASK_NOT_FOUND'
  | 'TASK_EXISTS'
  | 'DRAFT_REQUIRED'
  | 'DRAFT_TOO_THIN'
  | 'SEGMENT_NOT_FOUND'
  | 'RECALL_NOT_DUE'
  | 'RECALL_ALREADY_ANSWERED'
  | 'NO_SAMPLES'
  | 'INVALID_ARGUMENT';

/** 单调时钟抽象的结果：仅用 ISO 字符串跨进程传输，避免时区与序列化漂移。 */
export type Iso8601 = string;

export function toIso(date: Date): Iso8601 {
  return date.toISOString();
}

export function fromIso(value: Iso8601): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new DomainError('INVALID_ARGUMENT', `非法时间：${value}`);
  return d;
}

/** 四舍五入到指定小数位，避免 0.30000000000000004 这类浮点噪声进入展示层。 */
export function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
