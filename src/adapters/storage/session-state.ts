import type { TaskId } from '../../domain/model.js';
import type { TaskSnapshot } from '../../domain/task.js';
import type { TaskRepository } from '../../ports/repository.js';
import type { HostBridge } from '../../ports/host.js';
import type { Logger } from '../../ports/observability.js';

/**
 * 会话状态仓储 · 首选方案
 *
 * 0.2.1 起插件可以把自己的记录写进会话状态（session state record）。
 * 相比文件，它的优势是随会话迁移、随 profile 复制、在 SDK / headless 下也成立。
 *
 * 但会话状态的读写是"键值"而非"表"，因此这里用一条索引键维护任务清单。
 * 索引与数据不一致时以索引为准并记警告 —— 宁可丢一条孤立记录，
 * 也不能让 list() 变成 O(全库扫描)。
 */
export class SessionStateRepository implements TaskRepository {
  readonly kind = 'session-state';
  readonly #bridge: HostBridge;
  readonly #logger: Logger;
  readonly #prefix = 'xianshou.task.';
  readonly #indexKey = 'xianshou.index';

  constructor(bridge: HostBridge, logger: Logger) {
    this.#bridge = bridge;
    this.#logger = logger;
  }

  static isAvailable(bridge: HostBridge): boolean {
    return bridge.capabilities.sessionState && bridge.state !== undefined;
  }

  async load(id: TaskId): Promise<TaskSnapshot | null> {
    const value = await this.#read(`${this.#prefix}${id}`);
    return isSnapshot(value) ? value : null;
  }

  async save(snapshot: TaskSnapshot): Promise<void> {
    await this.#write(`${this.#prefix}${snapshot.id}`, snapshot);
    const index = await this.#readIndex();
    if (!index.includes(snapshot.id)) {
      index.push(snapshot.id);
      await this.#write(this.#indexKey, index);
    }
  }

  async list(): Promise<readonly TaskSnapshot[]> {
    const index = await this.#readIndex();
    const out: TaskSnapshot[] = [];
    for (const id of index) {
      const value = await this.#read(`${this.#prefix}${id}`);
      if (isSnapshot(value)) out.push(value);
      else this.#logger.warn('[xianshou] 索引中的任务在会话状态里缺失', { id });
    }
    return out;
  }

  async remove(id: TaskId): Promise<void> {
    await this.#write(`${this.#prefix}${id}`, null);
    const index = (await this.#readIndex()).filter((x) => x !== id);
    await this.#write(this.#indexKey, index);
  }

  async #readIndex(): Promise<string[]> {
    const value = await this.#read(this.#indexKey);
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  }

  async #read(key: string): Promise<unknown> {
    if (!this.#bridge.state) return null;
    try {
      return await this.#bridge.state.read(key);
    } catch (error) {
      this.#logger.warn('[xianshou] 会话状态读取失败', { key, error: String(error) });
      return null;
    }
  }

  async #write(key: string, value: unknown): Promise<void> {
    if (!this.#bridge.state) throw new Error('会话状态接缝不可用');
    await this.#bridge.state.write(key, value);
  }
}

function isSnapshot(value: unknown): value is TaskSnapshot {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}
