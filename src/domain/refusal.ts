import { clamp01, round, type RefusalBand } from './model.js';
import type { ThresholdPolicy } from './policy.js';

/**
 * 拒绝率面板 · 最反直觉的指标
 *
 * 推理链（方案原文）：82% 的人对 AI 输出有信心，同一批人里 68% 经常发现它出错。
 * 那么一个从不拒绝 AI 建议的用户，几乎不可能是判断正确的那一个。
 * 拒绝率因此是"判断力是否在线"的探针，而不是"使用量"的指标。
 */

export type RefusalDecision = 'accepted' | 'rejected' | 'partial';

export interface RefusalEntry {
  readonly suggestionId: string;
  readonly decision: RefusalDecision;
  readonly note?: string;
}

export interface RefusalTally {
  readonly accepted: number;
  readonly rejected: number;
  readonly partial: number;
  readonly total: number;
  /** 实质否决率 = (rejected + 0.5 × partial) / total。半改既非采纳也非否决，按半权计。 */
  readonly rate: number | null;
  readonly band: RefusalBand;
}

export class RefusalPanel {
  #entries: RefusalEntry[] = [];

  static restore(entries: readonly RefusalEntry[], thresholds?: ThresholdPolicy): RefusalPanel {
    const panel = new RefusalPanel(thresholds);
    for (const e of entries) panel.record(e);
    return panel;
  }

  constructor(private readonly thresholds?: ThresholdPolicy) {}

  list(): readonly RefusalEntry[] {
    return [...this.#entries];
  }

  record(entry: RefusalEntry): void {
    const index = this.#entries.findIndex((e) => e.suggestionId === entry.suggestionId);
    if (index >= 0) this.#entries[index] = entry;
    else this.#entries.push(entry);
  }

  tally(): RefusalTally {
    let accepted = 0;
    let rejected = 0;
    let partial = 0;
    for (const e of this.#entries) {
      if (e.decision === 'accepted') accepted += 1;
      else if (e.decision === 'rejected') rejected += 1;
      else partial += 1;
    }
    const total = accepted + rejected + partial;
    if (total === 0) {
      return { accepted, rejected, partial, total, rate: null, band: 'insufficient' };
    }
    const rate = round(clamp01((rejected + partial * 0.5) / total));
    return { accepted, rejected, partial, total, rate, band: this.#band(rate, total) };
  }

  #band(rate: number, total: number): RefusalBand {
    const t = this.thresholds;
    if (!t) {
      if (rate < 0.1) return 'blind';
      if (rate <= 0.4) return 'healthy';
      return 'contrarian';
    }
    if (total < t.minSamples) return 'insufficient';
    if (rate < t.refusalBlindBelow) return 'blind';
    if (rate < t.refusalHealthyMin) return 'insufficient';
    if (rate <= t.refusalHealthyMax) return 'healthy';
    if (rate > t.refusalContrarianAbove) return 'contrarian';
    return 'insufficient';
  }
}

export function refusalHeadline(tally: RefusalTally): string {
  switch (tally.band) {
    case 'insufficient':
      return tally.total === 0 ? '还没有样本' : `样本不足（${tally.total} 条），暂不判定`;
    case 'blind':
      return '你可能在盲从';
    case 'healthy':
      return '判断力在线';
    case 'contrarian':
      return '你在为反对而反对';
  }
}

export function refusalAction(tally: RefusalTally): string {
  switch (tally.band) {
    case 'insufficient':
      return '继续累积样本。少于 5 条时任何结论都不可信。';
    case 'blind':
      return '下一次 AI 建议先找一个可能错的地方，再决定是否采纳。';
    case 'healthy':
      return '保持。这个区间说明你在读，而不是在点同意。';
    case 'contrarian':
      return '否决比例过高同样异常 —— 检查是否在"为了不同而不同"，或任务本身已超出你的判断范围。';
  }
}
