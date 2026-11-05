import type { TaskId } from '../../domain/model.js';
import { TASK_SCHEMA_VERSION, type TaskSnapshot } from '../../domain/task.js';
import type { Migration, StateStore, TaskRepository } from '../../ports/repository.js';

/**
 * 存储适配器 · 内存实现
 *
 * 它是所有仓储契约测试的"参照实现"：任何新仓储必须通过同一组测试
 * （里氏替换的验收方式）。同时也是无持久化环境下的安全降级目标。
 */
export class MemoryTaskRepository implements TaskRepository {
  readonly kind = 'memory';
  readonly #items = new Map<string, TaskSnapshot>();

  async load(id: TaskId): Promise<TaskSnapshot | null> {
    return this.#items.get(id) ?? null;
  }

  async save(snapshot: TaskSnapshot): Promise<void> {
    this.#items.set(snapshot.id, structuredClone(snapshot));
  }

  async list(): Promise<readonly TaskSnapshot[]> {
    return [...this.#items.values()].map((s) => structuredClone(s));
  }

  async remove(id: TaskId): Promise<void> {
    this.#items.delete(id);
  }

  /** 仅供测试断言，不属于仓储契约。 */
  raw(): ReadonlyMap<string, TaskSnapshot> {
    return this.#items;
  }
}

export class MemoryStateStore implements StateStore {
  readonly kind = 'memory-state';
  readonly #values = new Map<string, unknown>();
  async read<T>(key: string): Promise<T | null> {
    return (this.#values.get(key) as T | undefined) ?? null;
  }
  async write(key: string, value: unknown): Promise<void> {
    this.#values.set(key, structuredClone(value));
  }
}

/**
 * 迁移装饰器
 *
 * 只在读取路径上做迁移：写路径永远写最新版本。这样"读旧写新"，
 * 不需要维护 N 个版本的写入逻辑，也避免了迁移链把旧数据写坏。
 */
export class MigratingRepository implements TaskRepository {
  readonly kind: string;
  readonly #inner: TaskRepository;
  readonly #migrations: readonly Migration[];

  constructor(inner: TaskRepository, migrations: readonly Migration[]) {
    this.#inner = inner;
    this.kind = `${inner.kind}+migrating`;
    this.#migrations = [...migrations].sort((a, b) => a.from - b.from);
  }

  async load(id: TaskId): Promise<TaskSnapshot | null> {
    const snapshot = await this.#inner.load(id);
    return snapshot ? this.#migrate(snapshot) : null;
  }

  async save(snapshot: TaskSnapshot): Promise<void> {
    await this.#inner.save(snapshot);
  }

  async list(): Promise<readonly TaskSnapshot[]> {
    const all = await this.#inner.list();
    return all.map((s) => this.#migrate(s));
  }

  async remove(id: TaskId): Promise<void> {
    await this.#inner.remove(id);
  }

  #migrate(snapshot: TaskSnapshot): TaskSnapshot {
    let current = snapshot as unknown as Record<string, unknown>;
    let version = typeof current['schemaVersion'] === 'number' ? (current['schemaVersion'] as number) : 1;
    if (version > TASK_SCHEMA_VERSION) {
      // fail closed：未来版本的数据不能被当前插件"猜测式"读入。
      throw new Error(`任务 ${snapshot.id} 的数据版本 ${version} 高于插件支持上限 ${TASK_SCHEMA_VERSION}`);
    }
    for (const migration of this.#migrations) {
      if (version === migration.from) {
        current = migration.migrate(current);
        version = migration.to;
      }
    }
    return { ...(current as unknown as TaskSnapshot), schemaVersion: version };
  }
}

/**
 * v1 → v2：v1 没有 gates / refusals / reusedFramework 三个字段。
 * 迁移只补齐结构，不重算业务数据（缺的回收计划就是没有，不能凭空生成）。
 */
export const migrationV1ToV2: Migration = {
  from: 1,
  to: 2,
  describe: '补齐 gates / refusals / reusedFramework 字段',
  migrate(snapshot) {
    return {
      ...snapshot,
      gates: Array.isArray(snapshot['gates']) ? snapshot['gates'] : [],
      refusals: Array.isArray(snapshot['refusals']) ? snapshot['refusals'] : [],
      reusedFramework: snapshot['reusedFramework'] === true,
      segments: Array.isArray(snapshot['segments']) ? snapshot['segments'] : [],
      recalls: Array.isArray(snapshot['recalls']) ? snapshot['recalls'] : [],
      schemaVersion: 2,
    };
  },
};

export const DEFAULT_MIGRATIONS: readonly Migration[] = [migrationV1ToV2];
