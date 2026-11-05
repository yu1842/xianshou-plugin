import type { TaskId, Iso8601 } from '../domain/model.js';
import type { TaskSnapshot } from '../domain/task.js';

/**
 * 端口 · 仓储
 *
 * 仓储只认快照（纯数据），不认识 TaskRecord。好处有两个：
 * 1. 存储适配器无需依赖领域对象，可单独替换为 Session 状态、文件、数据库；
 * 2. 领域对象的重建策略（含版本迁移）集中在 TaskRecord.restore，不会散落在适配器里。
 */

export interface TaskRepository {
  readonly kind: string;
  load(id: TaskId): Promise<TaskSnapshot | null>;
  save(snapshot: TaskSnapshot): Promise<void>;
  list(): Promise<readonly TaskSnapshot[]>;
  remove(id: TaskId): Promise<void>;
}

/** 键值状态端：供需要保存"插件自己的状态"（如启用标记、统计游标）的能力使用。 */
export interface StateStore {
  readonly kind: string;
  read<T>(key: string): Promise<T | null>;
  write(key: string, value: unknown): Promise<void>;
}

export interface Migration {
  readonly from: number;
  readonly to: number;
  readonly describe: string;
  /** 只做结构补齐，不做业务重算，保证"老数据要么忠实迁移，要么失败关闭"。 */
  migrate(snapshot: Record<string, unknown>): Record<string, unknown>;
}

export type RepositoryHealth = {
  readonly kind: string;
  readonly durable: boolean;
  readonly note: string;
};

export interface RepositoryDiagnostics {
  describe(): RepositoryHealth;
  lastWriteAt(): Iso8601 | null;
}
