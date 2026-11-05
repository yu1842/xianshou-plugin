import { round } from './model.js';
import type { ThresholdPolicy } from './policy.js';
import type { TaskRecord } from './task.js';

/**
 * 健康度报告 · 四个指标一起看
 *
 * 方案原文："任何一个单独看都会被伪装，四个一起看很难。"
 * 因此报告不是给一个总分，而是四个指标各自带区间与信号。
 */

export type MetricBand = 'good' | 'warn' | 'bad' | 'insufficient';

export interface Metric {
  readonly key: 'recall' | 'autonomy' | 'refusal' | 'migration';
  readonly label: string;
  readonly value: number | null;
  readonly display: string;
  readonly target: string;
  readonly band: MetricBand;
  readonly note: string;
}

export interface HealthReport {
  readonly generatedAt: string;
  readonly samples: number;
  readonly metrics: readonly Metric[];
  /** 只列真正危险的那一条，避免一次给四个警报。 */
  readonly topConcern: string | null;
}

export class HealthReportBuilder {
  constructor(private readonly thresholds: ThresholdPolicy) {}

  build(tasks: readonly TaskRecord[], now: Date): HealthReport {
    const delivered = tasks.filter((t) => t.deliveredAt !== null);
    const recallValues = delivered
      .map((t) => t.recallAccuracy())
      .filter((v): v is number => v !== null);
    const recall = recallValues.length === 0 ? null : round(recallValues.reduce((a, b) => a + b, 0) / recallValues.length);

    const autonomyValues = delivered.map((t) => t.ledger.tally().selfRatio).filter((v) => v > 0);
    const autonomy = autonomyValues.length === 0 ? null : round(autonomyValues.reduce((a, b) => a + b, 0) / autonomyValues.length);

    const refusalCounts = delivered.reduce(
      (acc, t) => {
        const tally = t.refusals.tally();
        return { rejected: acc.rejected + tally.rejected + tally.partial * 0.5, total: acc.total + tally.total };
      },
      { rejected: 0, total: 0 },
    );
    const refusal = refusalCounts.total === 0 ? null : round(refusalCounts.rejected / refusalCounts.total);

    const migration = tasks.length === 0 ? null : round(tasks.filter((t) => t.reusedFramework).length / tasks.length);

    const metrics: Metric[] = [
      this.#metric('recall', '无提示复述准确率', recall, '≥ 80%', (v) => (v >= 0.8 ? 'good' : v < 0.6 ? 'bad' : 'warn'), '测记忆与理解；低于 60% 说明这三周只是表演学习。'),
      this.#metric('autonomy', '首版自主率', autonomy, '≥ 50%', (v) => (v >= this.thresholds.selfRatioTarget ? 'good' : v < 0.3 ? 'bad' : 'warn'), '测建构参与度；AI 介入前已成型的部分占了交付物多少。'),
      this.#metric('refusal', '拒绝率', refusal, '15%–40%', (v) => (v < this.thresholds.refusalBlindBelow ? 'bad' : v > this.thresholds.refusalHealthyMax ? 'warn' : v < this.thresholds.refusalHealthyMin ? 'warn' : 'good'), '测判断力是否在线；从不拒绝几乎不可能是判断正确的那一个。'),
      this.#metric('migration', '跨任务迁移率', migration, '逐月上升', (v) => (v >= 0.3 ? 'good' : v <= 0 ? 'bad' : 'warn'), '测能力是否沉淀成资产；每次从零问 AI 是危险信号。'),
    ];

    const bad = metrics.find((m) => m.band === 'bad');
    return {
      generatedAt: now.toISOString(),
      samples: tasks.length,
      metrics,
      topConcern: bad ? bad.note : null,
    };
  }

  #metric(
    key: Metric['key'],
    label: string,
    value: number | null,
    target: string,
    band: (v: number) => MetricBand,
    note: string,
  ): Metric {
    if (value === null) {
      return { key, label, value, display: '—', target, band: 'insufficient', note: `样本不足：${note}` };
    }
    const percent = `${Math.round(value * 100)}%`;
    return { key, label, value, display: percent, target, band: band(value), note };
  }
}
