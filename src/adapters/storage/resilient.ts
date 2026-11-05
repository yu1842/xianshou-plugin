import type { TaskId } from '../../domain/model.js';
import type { TaskSnapshot } from '../../domain/task.js';
import type { TaskRepository } from '../../ports/repository.js';
import type { Logger } from '../../ports/observability.js';

/**
 * 弹性仓储装饰器
 *
 * 场景：会话状态或文件目录在运行中变得不可写（只读 profile、磁盘满、权限变更）。
 * 直接抛错会让每次工具调用都失败，用户看到的是"插件坏了"。
 *
 * 策略：首次写失败后切到内存副本继续服务，并明确告知"本次会话不持久化"。
 * 这是有意识的取舍 —— 宁可丢持久化，也不丢可用性；但必须让用户知道。
 */
export class ResilientRepository implements TaskRepository {
  readonly kind: string;
  readonly #inner: TaskRepository;
  readonly #logger: Logger;
  readonly #fallback = new Map<string, TaskSnapshot>();
  #degraded = false;

  constructor(inner: TaskRepository, logger: Logger) {
    this.#inner = inner;
    this.#logger = logger;
    this.kind = `${inner.kind}+resilient`;
  }

  get degraded(): boolean {
    return this.#degraded;
  }

  async load(id: TaskId): Promise<TaskSnapshot | null> {
    const cached = this.#fallback.get(id);
    if (cached) return cached;
    return this.#inner.load(id);
  }

  async save(snapshot: TaskSnapshot): Promise<void> {
    try {
      await this.#inner.save(snapshot);
    } catch (error) {
      this.#degrade(error);
      this.#fallback.set(snapshot.id, structuredClone(snapshot));
    }
  }

  async list(): Promise<readonly TaskSnapshot[]> {
    try {
      const all = await this.#inner.list();
      return all.map((s) => this.#fallback.get(s.id) ?? s);
    } catch (error) {
      this.#degrade(error);
      return [...this.#fallback.values()].map((s) => structuredClone(s));
    }
  }

  async remove(id: TaskId): Promise<void> {
    this.#fallback.delete(id);
    try {
      await this.#inner.remove(id);
    } catch (error) {
      this.#degrade(error);
    }
  }

  #degrade(error: unknown): void {
    if (this.#degraded) return;
    this.#degraded = true;
    this.#logger.error('[xianshou] 存储降级：本次会话的改动只保存在内存中，退出即丢失。', {
      backend: this.#inner.kind,
      error: String(error),
    });
  }
}
