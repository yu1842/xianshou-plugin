import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TaskId } from '../../domain/model.js';
import type { TaskSnapshot } from '../../domain/task.js';
import type { TaskRepository } from '../../ports/repository.js';
import type { Logger } from '../../ports/observability.js';

/**
 * 文件仓储 · 降级方案
 *
 * 为什么需要它：会话状态的读写接口在 0.2.1 才成型，且不同 profile（headless / sdk）
 * 未必提供。插件的核心数据不能因为"宿主没给状态接口"就丢失，因此必须有可用的落盘路径。
 *
 * 写入策略：先写临时文件再 rename。rename 在同一文件系统内是原子的，
 * 这样即使进程在写入中被杀，也不会留下半截 JSON 导致下次加载失败。
 */
export class JsonFileRepository implements TaskRepository {
  readonly kind = 'json-file';
  readonly #dir: string;
  readonly #logger: Logger;

  constructor(dir: string, logger: Logger) {
    this.#dir = resolve(dir);
    this.#logger = logger;
  }

  get directory(): string {
    return this.#dir;
  }

  async load(id: TaskId): Promise<TaskSnapshot | null> {
    try {
      const text = await readFile(this.#path(id), 'utf8');
      return JSON.parse(text) as TaskSnapshot;
    } catch (error) {
      if (isNotFound(error)) return null;
      this.#logger.error('[xianshou] 读取任务失败（已按空结果处理，不覆盖原文件）', { id, error: String(error) });
      throw error;
    }
  }

  async save(snapshot: TaskSnapshot): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const target = this.#path(snapshot.id);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await rename(tmp, target);
  }

  async list(): Promise<readonly TaskSnapshot[]> {
    try {
      const files = await readdir(this.#dir);
      const snapshots: TaskSnapshot[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const text = await readFile(join(this.#dir, file), 'utf8');
        try {
          snapshots.push(JSON.parse(text) as TaskSnapshot);
        } catch {
          this.#logger.warn('[xianshou] 跳过损坏的任务文件', { file });
        }
      }
      return snapshots;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async remove(id: TaskId): Promise<void> {
    await rm(this.#path(id), { force: true });
  }

  #path(id: string): string {
    // 任务 ID 已在领域层做过字符白名单校验，这里再挡一次路径穿越。
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`非法任务 ID：${id}`);
    return join(this.#dir, `${id}.json`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}
