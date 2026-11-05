/**
 * 端口 · 文档存储
 *
 * 任务有专门的仓储，但"训练营进度"这类单例状态不属于任务集合。
 * 用一个最小键值文档端口承载，避免为了一个对象再写一套仓储。
 *
 * 语义要求：read 未知键返回 null（不是抛错）——因为"还没开营"是正常状态，不是异常。
 */
export interface DocumentStore {
  readonly kind: string;
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}
