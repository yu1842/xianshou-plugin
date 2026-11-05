import { DomainError, round, toIso, type Iso8601, type RecallVerdict, type RecallWindow, type TaskId } from './model.js';
import type { ThresholdPolicy } from './policy.js';

/**
 * 回收闸门 · 方案的牙齿
 *
 * 三个问题固定不变（方案原文的动作四），因为它们指向三种不同的东西：
 * ① 结构是否记得  ② 盲区是否自知  ③ 抗反驳是否站得住。
 * 判分策略可插拔：默认自评，避免插件假装能判断"你是否真的懂了"。
 */

export type { RecallWindow } from './model.js';

export const RECALL_QUESTIONS: readonly string[] = Object.freeze([
  '这个结论的核心逻辑是什么？',
  '我最不确定的是哪一点？',
  '如果对方反问，我靠什么回答？',
]);

export interface RecallGate {
  readonly taskId: TaskId;
  readonly window: RecallWindow;
  readonly scheduledFor: Iso8601;
  readonly questions: readonly string[];
}

export interface RecallAttempt {
  readonly window: RecallWindow;
  readonly answeredAt: Iso8601;
  /** 三题各 0–2 分。 */
  readonly scores: readonly number[];
  readonly answers: readonly string[];
  readonly score: number;
  readonly verdict: RecallVerdict;
  /** 未达标的题号（1 起），用于定向提示。 */
  readonly weakQuestions: readonly number[];
}

export function buildRecallGates(
  taskId: TaskId,
  deliveredAt: Date,
  policy: ThresholdPolicy,
): RecallGate[] {
  return policy.recallWindowsHours.map((hours, index) => ({
    taskId,
    window: (index === 0 ? 'd24h' : 'd7d') as RecallWindow,
    scheduledFor: toIso(new Date(deliveredAt.getTime() + hours * 3600_000)),
    questions: [...RECALL_QUESTIONS],
  }));
}

export function windowLabel(window: RecallWindow): string {
  return window === 'd24h' ? '24 小时回收' : '7 天回收';
}

/** 判分策略接口：让"谁来判定"成为可替换的实现，而不是写死在流程里。 */
export interface RecallScorer {
  readonly id: string;
  /** 返回三题得分；缺答视为 0 分。 */
  score(answers: readonly string[], selfReport?: readonly number[]): readonly number[];
}

/** 默认：用户自评（0 讲不出 / 1 说得清但卡壳 / 2 能完整讲）。无法伪造的是"讲不出"本身。 */
export class SelfReportScorer implements RecallScorer {
  readonly id = 'self-report';
  score(answers: readonly string[], selfReport?: readonly number[]): readonly number[] {
    if (!selfReport || selfReport.length !== RECALL_QUESTIONS.length) {
      throw new DomainError('INVALID_ARGUMENT', '自评判分需要为三个问题各提供 0–2 的整数分。');
    }
    return selfReport.map((raw, i) => {
      const value = Math.trunc(raw);
      if (!Number.isFinite(value) || value < 0 || value > 2) {
        throw new DomainError('INVALID_ARGUMENT', `第 ${i + 1} 题评分必须是 0–2。`);
      }
      // 没写答案却给自己 2 分属于"表演式回收"，一律记 0。
      return (answers[i] ?? '').trim().length >= 2 ? value : 0;
    });
  }
}

/** 备选：结构启发式。只在没有自评时兜底，结果会标注 method=heuristic。 */
export class StructuralScorer implements RecallScorer {
  readonly id = 'structural';
  score(answers: readonly string[]): readonly number[] {
    return RECALL_QUESTIONS.map((_, i) => {
      const answer = (answers[i] ?? '').trim();
      if (answer.length === 0) return 0;
      let value = 1;
      if (answer.length >= 40) value = 2;
      // 第 2 题是"承认不确定"，出现不确定表述才算答到点上。
      if (i === 1 && !/(不确定|没把握|可能是|边界|风险|假设)/.test(answer)) value = Math.min(value, 1);
      return value;
    });
  }
}

export class RecallPolicy {
  constructor(
    private readonly thresholds: ThresholdPolicy,
    private readonly fallback: RecallScorer = new StructuralScorer(),
  ) {}

  /** 自评优先；没有自评就用结构启发式，并如实标出来源。 */
  evaluate(
    window: RecallWindow,
    answers: readonly string[],
    now: Date,
    selfReport?: readonly number[],
    scorer?: RecallScorer,
  ): RecallAttempt {
    const effective = scorer ?? (selfReport ? new SelfReportScorer() : this.fallback);
    const scores = effective.score(answers, selfReport);
    const max = RECALL_QUESTIONS.length * 2;
    const score = round(scores.reduce((a, b) => a + b, 0) / max);
    const passed = score >= this.thresholds.recallPassScore;
    return {
      window,
      answeredAt: toIso(now),
      scores,
      answers: [...answers],
      score,
      verdict: passed ? 'pass' : 'fail',
      weakQuestions: scores.map((s, i) => (s <= 1 ? i + 1 : 0)).filter((i) => i > 0),
    };
  }
}

/** 到期判定独立成纯函数，方便在无仓储的情况下单测。 */
export function isDue(gate: RecallGate, now: Date): boolean {
  return new Date(gate.scheduledFor).getTime() <= now.getTime();
}

export function isOverdue(gate: RecallGate, now: Date, graceHours: number): boolean {
  return new Date(gate.scheduledFor).getTime() + graceHours * 3600_000 < now.getTime();
}
