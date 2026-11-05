import type { TaskRecord } from '../domain/task.js';
import type { Zone } from '../domain/model.js';
import type { DomainEvent, EventSink } from './TaskService.js';

/**
 * 任务快照缓存
 *
 * 为什么需要它：`ctx.tools.guard()` 的守卫是**同步**函数（宿主契约），
 * 而仓储是异步的。守卫里不能 await，因此必须有一份同步可读的镜像。
 *
 * 一致性策略：缓存只在三个时点更新 —— 挂载时全量水合、每次写库后由事件驱动更新、
 * 工具写入成功后由事件更新。误差窗口因此被限制在"一次写库往返"之内，
 * 而守卫只做最后一道单调防线，权威判断仍在异步的 pre-execute 里。
 */
export interface CachedTask {
  readonly id: string;
  readonly zone: Zone;
  readonly hasDraft: boolean;
  readonly status: string;
  readonly updatedAt: string;
}

export class TaskCache implements EventSink {
  readonly #tasks = new Map<string, CachedTask>();

  hydrate(tasks: readonly TaskRecord[]): void {
    this.#tasks.clear();
    for (const task of tasks) {
      this.#tasks.set(task.id, {
        id: task.id,
        zone: task.zone,
        hasDraft: task.hasDraft,
        status: task.status,
        updatedAt: task.updatedAt,
      });
    }
  }

  publish(event: DomainEvent): void {
    if (event.type !== 'task.saved') return;
    const existing = this.#tasks.get(event.taskId);
    this.#tasks.set(event.taskId, {
      id: event.taskId,
      zone: event.zone,
      hasDraft: event.hasDraft,
      status: event.status,
      updatedAt: existing?.updatedAt ?? new Date().toISOString(),
    });
  }

  /**
   * 找出"当前正在推进、且欠着先手稿"的红区任务。
   * 只认 open / rework 状态：已交付的任务不该继续拦人，否则用户会被历史任务反复挡住。
   */
  pendingDraft(): CachedTask | undefined {
    let candidate: CachedTask | undefined;
    for (const task of this.#tasks.values()) {
      if (task.zone !== 'red') continue;
      if (task.status === 'delivered') continue;
      if (task.hasDraft) continue;
      candidate = task;
      break;
    }
    return candidate;
  }

  get(id: string): CachedTask | undefined {
    return this.#tasks.get(id);
  }

  get size(): number {
    return this.#tasks.size;
  }

  clear(): void {
    this.#tasks.clear();
  }
}
