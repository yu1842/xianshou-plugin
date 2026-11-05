import { DomainError, asTaskId, round, toIso, type Iso8601, type TaskId, type TaskStatus, type Zone } from './model.js';
import { SourceLedger, type LedgerSegment } from './ledger.js';
import { DraftValidator, type DraftArtifact, type DraftInput } from './draft.js';
import { RefusalPanel, type RefusalEntry } from './refusal.js';
import { RecallPolicy, buildRecallGates, windowLabel, type RecallAttempt, type RecallGate, type RecallWindow } from './recall.js';
import type { ThresholdPolicy } from './policy.js';

/**
 * 任务聚合根
 *
 * 一个任务 = 一次"红区先手 → AI 增强 → 留痕 → 交付 → 回收"的完整闭环。
 * 所有状态迁移都在这里发生，外部只能通过方法改状态（封装），
 * 持久化只认 toSnapshot() 的纯数据（序列化边界清晰）。
 */

export interface TaskSnapshot {
  readonly schemaVersion: number;
  readonly id: string;
  readonly title: string;
  readonly zone: Zone;
  readonly zoneRuleId: string;
  readonly rationale: string;
  readonly status: TaskStatus;
  readonly createdAt: Iso8601;
  readonly updatedAt: Iso8601;
  readonly deliveredAt: Iso8601 | null;
  readonly draft: DraftArtifact | null;
  readonly segments: readonly LedgerSegment[];
  readonly recalls: readonly RecallAttempt[];
  readonly gates: readonly RecallGate[];
  readonly refusals: readonly RefusalEntry[];
  /** 是否复用了自己既有的框架（用于跨任务迁移率）。 */
  readonly reusedFramework: boolean;
}

export const TASK_SCHEMA_VERSION = 2;

export interface CreateTaskInput {
  readonly title: string;
  readonly zone: Zone;
  readonly zoneRuleId: string;
  readonly rationale: string;
  readonly reusedFramework: boolean;
  readonly now: Date;
}

export class TaskRecord {
  #status: TaskStatus;
  #zone: Zone;
  #draft: DraftArtifact | null;
  #ledger: SourceLedger;
  #recalls: RecallAttempt[];
  #gates: RecallGate[];
  #refusals: RefusalPanel;
  #deliveredAt: Iso8601 | null;
  #updatedAt: Iso8601;

  private constructor(
    readonly id: TaskId,
    readonly title: string,
    zone: Zone,
    readonly zoneRuleId: string,
    readonly rationale: string,
    readonly createdAt: Iso8601,
    readonly reusedFramework: boolean,
    private readonly policy: ThresholdPolicy,
  ) {
    this.#zone = zone;
    this.#status = 'open';
    this.#draft = null;
    this.#ledger = new SourceLedger();
    this.#recalls = [];
    this.#gates = [];
    this.#refusals = new RefusalPanel(policy);
    this.#deliveredAt = null;
    this.#updatedAt = createdAt;
  }

  static create(id: TaskId, input: CreateTaskInput, policy: ThresholdPolicy): TaskRecord {
    return new TaskRecord(
      id,
      input.title,
      input.zone,
      input.zoneRuleId,
      input.rationale,
      toIso(input.now),
      input.reusedFramework,
      policy,
    );
  }

  static restore(snapshot: TaskSnapshot, policy: ThresholdPolicy): TaskRecord {
    if (snapshot.schemaVersion > TASK_SCHEMA_VERSION) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `任务数据版本 ${snapshot.schemaVersion} 高于插件支持的 ${TASK_SCHEMA_VERSION}，拒绝以降级方式写入（fail closed）。`,
      );
    }
    const task = new TaskRecord(
      asTaskId(snapshot.id),
      snapshot.title,
      snapshot.zone,
      snapshot.zoneRuleId,
      snapshot.rationale,
      snapshot.createdAt,
      snapshot.reusedFramework,
      policy,
    );
    task.#status = snapshot.status;
    task.#draft = snapshot.draft;
    task.#ledger = SourceLedger.restore(snapshot.segments);
    task.#recalls = [...snapshot.recalls];
    task.#gates = [...snapshot.gates];
    // 阈值必须随快照一起恢复：否则从库里读回来的任务会退化成"无样本要求"的判分，
    // 一条记录就敢下"你在为反对而反对"的结论。
    task.#refusals = RefusalPanel.restore(snapshot.refusals, policy);
    task.#deliveredAt = snapshot.deliveredAt;
    task.#updatedAt = snapshot.updatedAt;
    return task;
  }

  get zone(): Zone {
    return this.#zone;
  }

  get status(): TaskStatus {
    return this.#status;
  }

  get draft(): DraftArtifact | null {
    return this.#draft;
  }

  get ledger(): SourceLedger {
    return this.#ledger;
  }

  get recalls(): readonly RecallAttempt[] {
    return [...this.#recalls];
  }

  get gates(): readonly RecallGate[] {
    return [...this.#gates];
  }

  get refusals(): RefusalPanel {
    return this.#refusals;
  }

  get deliveredAt(): Iso8601 | null {
    return this.#deliveredAt;
  }

  get updatedAt(): Iso8601 {
    return this.#updatedAt;
  }

  /** 闸门只对"还没落稿"的红区任务生效。绿区永远不拦，这是方案不做教条化的前提。 */
  get requiresDraft(): boolean {
    return this.#zone === 'red' && this.#draft === null && this.#status !== 'delivered';
  }

  get hasDraft(): boolean {
    return this.#draft !== null;
  }

  submitDraft(input: DraftInput, now: Date): DraftArtifact {
    if (this.#status === 'delivered') {
      throw new DomainError('DRAFT_REQUIRED', '任务已交付，先手稿不可再改；如需重做请新建任务。');
    }
    const validator = DraftValidator.withDefaults(this.policy.draftMinChars, this.policy.draftMinutes);
    const artifact = validator.accept(input, now);
    this.#draft = artifact;
    this.#touch(now);
    return artifact;
  }

  markSegment(segment: LedgerSegment, now: Date): void {
    if (this.#zone === 'red' && this.#draft === null) {
      throw new DomainError('DRAFT_REQUIRED', '红区任务还没有先手稿，先落稿再谈留痕。');
    }
    this.#ledger.add(segment);
    this.#touch(now);
  }

  unmarkSegment(segmentId: string, now: Date): void {
    this.#ledger.remove(segmentId);
    this.#touch(now);
  }

  recordRefusal(entry: RefusalEntry, now: Date): void {
    this.#refusals.record(entry);
    this.#touch(now);
  }

  /** 交付：生成回收闸门。回收计划必须落盘，不能只靠定时器（进程重启即失忆）。 */
  deliver(now: Date): RecallGate[] {
    if (this.#zone === 'red' && this.#draft === null) {
      throw new DomainError('DRAFT_REQUIRED', '红区任务没有先手稿，不能交付。');
    }
    if (this.#status === 'delivered') {
      return [...this.#gates];
    }
    this.#status = 'delivered';
    this.#deliveredAt = toIso(now);
    this.#gates = buildRecallGates(this.id, now, this.policy);
    this.#touch(now);
    return [...this.#gates];
  }

  answerRecall(window: RecallWindow, answers: readonly string[], now: Date, selfReport?: readonly number[]): RecallAttempt {
    const gate = this.#gates.find((g) => g.window === window);
    if (!gate) {
      throw new DomainError('RECALL_NOT_DUE', `没有 ${windowLabel(window)} 的计划；任务交付后才会生成回收闸门。`);
    }
    if (this.#recalls.some((r) => r.window === window)) {
      throw new DomainError('RECALL_ALREADY_ANSWERED', `${windowLabel(window)} 已经答过，不能重答刷分。`);
    }
    const policy = new RecallPolicy(this.policy);
    const attempt = policy.evaluate(window, answers, now, selfReport);
    this.#recalls.push(attempt);
    if (attempt.verdict === 'fail') {
      // 答不出来 = 没学会 → 打回黄区重做先手。这是方案里唯一"无法伪装"的惩罚。
      this.#zone = 'yellow';
      this.#status = 'rework';
    }
    this.#touch(now);
    return attempt;
  }

  /** 被比例闸门打回：保留原记录，状态置 rework，强制重做一次先手。 */
  sendBackToRework(now: Date): void {
    this.#status = 'rework';
    this.#draft = null;
    this.#touch(now);
  }

  recallAccuracy(): number | null {
    if (this.#recalls.length === 0) return null;
    const sum = this.#recalls.reduce((a, r) => a + r.score, 0);
    return round(sum / this.#recalls.length);
  }

  #touch(now: Date): void {
    this.#updatedAt = toIso(now);
  }

  toSnapshot(): TaskSnapshot {
    return {
      schemaVersion: TASK_SCHEMA_VERSION,
      id: this.id,
      title: this.title,
      zone: this.#zone,
      zoneRuleId: this.zoneRuleId,
      rationale: this.rationale,
      status: this.#status,
      createdAt: this.createdAt,
      updatedAt: this.#updatedAt,
      deliveredAt: this.#deliveredAt,
      draft: this.#draft,
      segments: this.#ledger.list(),
      recalls: this.#recalls,
      gates: this.#gates,
      refusals: this.#refusals.list(),
      reusedFramework: this.reusedFramework,
    };
  }
}
