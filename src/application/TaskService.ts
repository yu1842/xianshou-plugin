import type { CardModel } from '../ui/card.js';
import type { Logger } from '../ports/observability.js';
import type { Clock, IdGenerator } from '../ports/time.js';
import type { TaskRepository } from '../ports/repository.js';
import type { ThresholdPolicy } from '../domain/policy.js';
import { asTaskId, DomainError, type Iso8601, type TaskId, type Zone } from '../domain/model.js';
import { TaskRecord, type TaskSnapshot } from '../domain/task.js';
import { ZoneClassifier, type ZoneSignals } from '../domain/zone.js';
import { isDue, isOverdue, type RecallGate } from '../domain/recall.js';

/**
 * 任务服务 · 应用层
 *
 * 职责边界很窄：加载 → 交给领域对象 → 保存。它不判断"该不该重做"，
 * 也不决定卡片长什么样。这样工具类不必各自处理持久化，也不会各自解释阈值。
 */

export type DomainEvent =
  | { readonly type: 'task.created'; readonly taskId: TaskId; readonly zone: Zone; readonly title: string }
  | {
      readonly type: 'task.saved';
      readonly taskId: TaskId;
      readonly zone: Zone;
      readonly hasDraft: boolean;
      readonly status: string;
      readonly title: string;
    }
  | { readonly type: 'draft.accepted'; readonly taskId: TaskId; readonly chars: number }
  | { readonly type: 'segment.marked'; readonly taskId: TaskId; readonly tag: string; readonly aiRatio: number }
  | { readonly type: 'task.delivered'; readonly taskId: TaskId; readonly gates: readonly Iso8601[] }
  | { readonly type: 'recall.failed'; readonly taskId: TaskId; readonly score: number }
  | { readonly type: 'gate.bypassed'; readonly taskId: TaskId; readonly tool: string }
  | { readonly type: 'refusal.recorded'; readonly taskId: TaskId; readonly decision: string };

export interface EventSink {
  publish(event: DomainEvent): void;
}

export class NoopEventSink implements EventSink {
  publish(): void {}
}

/** 组合多个订阅者：缓存、会话事件、日志各取所需，互不影响。 */
export class CompositeEventSink implements EventSink {
  readonly #sinks: readonly EventSink[];
  constructor(sinks: readonly EventSink[]) {
    this.#sinks = sinks;
  }
  publish(event: DomainEvent): void {
    for (const sink of this.#sinks) {
      try {
        sink.publish(event);
      } catch {
        // 订阅者失败不能影响主流程：账本已经落盘，事件是衍生品。
      }
    }
  }
}

export interface TaskServiceDeps {
  readonly repository: TaskRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly policy: ThresholdPolicy;
  readonly logger: Logger;
  readonly events?: EventSink;
  readonly classifier?: ZoneClassifier;
}

export interface CreateTaskRequest {
  readonly title: string;
  readonly signals: ZoneSignals;
  readonly reusedFramework?: boolean;
}

export interface DueRecall {
  readonly task: TaskRecord;
  readonly gates: readonly RecallGate[];
  readonly overdue: boolean;
}

export class TaskService {
  readonly #deps: TaskServiceDeps;
  readonly #classifier: ZoneClassifier;

  constructor(deps: TaskServiceDeps) {
    this.#deps = deps;
    this.#classifier = deps.classifier ?? new ZoneClassifier();
  }

  get policy(): ThresholdPolicy {
    return this.#deps.policy;
  }

  get clock(): Clock {
    return this.#deps.clock;
  }

  async create(request: CreateTaskRequest): Promise<{ task: TaskRecord; decision: ReturnType<ZoneClassifier['classify']> }> {
    const decision = this.#classifier.classify(request.signals);
    const now = this.#deps.clock.now();
    const id = asTaskId(this.#deps.ids.next('xs'));
    const task = TaskRecord.create(
      id,
      {
        title: request.title,
        zone: decision.zone,
        zoneRuleId: decision.ruleId,
        rationale: decision.rationale,
        reusedFramework: request.reusedFramework === true,
        now,
      },
      this.#deps.policy,
    );
    await this.save(task);
    this.#deps.events?.publish({ type: 'task.created', taskId: task.id, zone: decision.zone, title: task.title });
    this.#deps.logger.info('[xianshou] 任务创建', { id: task.id, zone: decision.zone, rule: decision.ruleId });
    return { task, decision };
  }

  async load(id: string): Promise<TaskRecord> {
    const taskId = asTaskId(id);
    const snapshot = await this.#deps.repository.load(taskId);
    if (!snapshot) throw new DomainError('TASK_NOT_FOUND', `没有这个任务：${id}`, '先用 xianshou_start 创建任务。');
    return TaskRecord.restore(snapshot, this.#deps.policy);
  }

  /**
   * 导入一条快照：先走 TaskRecord.restore 做结构与版本校验，再落库。
   * 不直接 write snapshot —— 恢复的输入来自外部文件，必须当成不可信数据。
   */
  async importSnapshot(snapshot: TaskSnapshot): Promise<TaskRecord> {
    const task = TaskRecord.restore(snapshot, this.#deps.policy);
    await this.save(task);
    return task;
  }

  async save(task: TaskRecord): Promise<void> {
    await this.#deps.repository.save(task.toSnapshot());
    // 同步缓存与解析式守卫：守卫是同步的，只能读内存快照，因此每次写入都要广播。
    this.#deps.events?.publish({
      type: 'task.saved',
      taskId: task.id,
      zone: task.zone,
      hasDraft: task.hasDraft,
      status: task.status,
      title: task.title,
    });
  }

  async list(): Promise<TaskRecord[]> {
    const snapshots = await this.#deps.repository.list();
    const tasks: TaskRecord[] = [];
    for (const snapshot of snapshots) {
      try {
        tasks.push(TaskRecord.restore(snapshot, this.#deps.policy));
      } catch (error) {
        // 单条坏数据不能拖垮整个列表：健康度面板的价值大于"零容忍"。
        this.#deps.logger.warn('[xianshou] 跳过无法恢复的任务', { id: snapshot.id, error: String(error) });
      }
    }
    return tasks.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /** 到期回收：以持久化的 scheduledFor 为准，不依赖内存定时器。 */
  async dueRecalls(now?: Date): Promise<DueRecall[]> {
    const at = now ?? this.#deps.clock.now();
    const tasks = await this.list();
    const out: DueRecall[] = [];
    for (const task of tasks) {
      const answered = new Set(task.recalls.map((r) => r.window));
      const pending = task.gates.filter((g) => !answered.has(g.window) && isDue(g, at));
      if (pending.length === 0) continue;
      out.push({
        task,
        gates: pending,
        overdue: pending.some((g) => isOverdue(g, at, this.#deps.policy.recallGraceHours)),
      });
    }
    return out;
  }
}

/** 工具返回值统一形状：模型侧看 value，界面侧看 card。 */
export interface ToolResult {
  readonly value: Record<string, unknown>;
  readonly card: CardModel;
}
