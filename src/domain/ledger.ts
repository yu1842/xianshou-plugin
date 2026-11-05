import { DomainError, clamp01, round, type SourceTag } from './model.js';
import type { ThresholdPolicy } from './policy.js';

/**
 * 来源账本 · 聚合内的值对象
 *
 * 铁律 02：「让跳过变得可见，而不是禁止跳过」。可见的最小单位是
 * "每段一个标记 + 交付前一个比例"。账本只负责记事实和算比例，
 * 不做"该不该重做"的判断 —— 那是 LedgerPolicy 的职责（单一职责）。
 */

export interface LedgerSegment {
  readonly id: string;
  /** 段名，用给人看的短标签即可（如"二、核心论证"）。 */
  readonly label: string;
  readonly tag: SourceTag;
  /** 权重：默认取字符数，让"一段很长但全标 [自]"无法虚增自主率。 */
  readonly weight: number;
}

export interface LedgerTally {
  readonly segments: number;
  readonly self: number;
  readonly ai: number;
  readonly revised: number;
  readonly total: number;
  /** [AI] 占比，0..1；总权重为 0 时返回 0。 */
  readonly aiRatio: number;
  /** 首版自主率代理指标：[自] 权重占比。 */
  readonly selfRatio: number;
}

export type LedgerBand = 'healthy' | 'recall' | 'rework';

export interface LedgerVerdict {
  readonly band: LedgerBand;
  readonly tally: LedgerTally;
  readonly headline: string;
  readonly action: string;
}

export class SourceLedger {
  #segments: LedgerSegment[] = [];

  static restore(segments: readonly LedgerSegment[]): SourceLedger {
    const ledger = new SourceLedger();
    for (const s of segments) ledger.add(s);
    return ledger;
  }

  get size(): number {
    return this.#segments.length;
  }

  list(): readonly LedgerSegment[] {
    return [...this.#segments];
  }

  /** 同一 id 重复标记视为"改判"，而不是追加 —— 用户改标签比新增更常见。 */
  add(segment: LedgerSegment): void {
    if (segment.weight <= 0 || !Number.isFinite(segment.weight)) {
      throw new DomainError('INVALID_ARGUMENT', `段落权重大于 0 才可计入：${segment.id}`);
    }
    const index = this.#segments.findIndex((s) => s.id === segment.id);
    if (index >= 0) this.#segments[index] = segment;
    else this.#segments.push(segment);
  }

  remove(segmentId: string): boolean {
    const before = this.#segments.length;
    this.#segments = this.#segments.filter((s) => s.id !== segmentId);
    if (this.#segments.length === before) {
      throw new DomainError('SEGMENT_NOT_FOUND', `没有这个段落：${segmentId}`);
    }
    return true;
  }

  tally(): LedgerTally {
    const sums = { self: 0, ai: 0, revised: 0 };
    for (const s of this.#segments) sums[s.tag] += s.weight;
    const total = sums.self + sums.ai + sums.revised;
    return {
      segments: this.#segments.length,
      self: sums.self,
      ai: sums.ai,
      revised: sums.revised,
      total,
      aiRatio: total === 0 ? 0 : round(clamp01(sums.ai / total)),
      selfRatio: total === 0 ? 0 : round(clamp01(sums.self / total)),
    };
  }
}

/**
 * 比例 → 结论的策略。与 SourceLedger 分离，理由：
 * 阈值可能按课程/团队不同而调整，但账本的记账口径不应因此改变。
 */
export class LedgerPolicy {
  constructor(private readonly thresholds: ThresholdPolicy) {}

  judge(tally: LedgerTally): LedgerVerdict {
    if (tally.total === 0) {
      return {
        band: 'recall',
        tally,
        headline: '还没有任何来源标记',
        action: '先用 xianshou_mark 给关键段落打上 [自]/[AI]/[改]，再谈比例。',
      };
    }
    if (tally.aiRatio > this.thresholds.aiRatioRework) {
      return {
        band: 'rework',
        tally,
        headline: `[AI] 占比 ${pct(tally.aiRatio)} —— 你交了一份自己没参与建造的东西`,
        action: '打回红区，用一次完整的先手重做；重做后重新标记。',
      };
    }
    if (tally.aiRatio >= this.thresholds.aiRatioRecall) {
      return {
        band: 'recall',
        tally,
        headline: `[AI] 占比 ${pct(tally.aiRatio)} —— 结构可能是 AI 给的，你只做了填充`,
        action: '先做一次回收测试，确认能讲清核心逻辑再交付。',
      };
    }
    return {
      band: 'healthy',
      tally,
      headline: `[AI] 占比 ${pct(tally.aiRatio)} —— 你在主导，AI 在辅助`,
      action: '正常，保持。交付后仍建议做一次 24 小时回收。',
    };
  }
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
