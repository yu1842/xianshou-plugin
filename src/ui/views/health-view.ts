import { card, type CardModel, type CardNode } from '../card.js';
import type { HealthReport, Metric } from '../../domain/health.js';

/**
 * 健康度面板卡片
 *
 * 四个指标一起看，但不给总分 —— 总分会被优化，四个分开的指标不会。
 * 视觉上强制"一格一指标"，禁止合并成一枚大分数。
 */
export class HealthCard {
  report(report: HealthReport): CardModel {
    const nodes: CardNode[] = [
      { kind: 'paragraph', text: `基于 ${report.samples} 个任务。任何单个指标都能被伪装，四个一起看很难。` },
      { kind: 'divider' },
      ...report.metrics.flatMap((m) => this.#metric(m)),
    ];
    if (report.topConcern) {
      nodes.push({
        kind: 'callout',
        tone: 'danger',
        title: '最需要处理的一项',
        text: report.topConcern,
      });
    }
    nodes.push({
      kind: 'footnote',
      text: '指标口径：复述测记忆，首版自主率测建构参与，拒绝率测判断力，迁移率测能力是否沉淀成资产。',
    });
    return card(report.topConcern ? 'accent' : 'teal', '认知债健康度', nodes);
  }

  #metric(m: Metric): CardNode[] {
    const tone = m.band === 'good' ? 'success' : m.band === 'bad' ? 'danger' : m.band === 'warn' ? 'accent' : 'neutral';
    if (m.value === null) {
      return [
        { kind: 'kv', label: m.label, value: '样本不足', tone: 'neutral' },
        { kind: 'footnote', text: `${m.note}（目标 ${m.target}）` },
      ];
    }
    return [
      { kind: 'meter', label: m.label, value: m.value, tone, caption: `目标 ${m.target}` },
      { kind: 'footnote', text: m.note },
    ];
  }
}
