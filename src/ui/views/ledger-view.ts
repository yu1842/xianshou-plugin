import { card, type CardModel, type CardNode } from '../card.js';
import { pct, type LedgerVerdict } from '../../domain/ledger.js';

/**
 * 留痕账本卡片
 *
 * 设计要点：比例必须配一条"这是什么意思"的解释。
 * 只给数字，用户会把它当 KPI；给了含义，它才是"可见的债"。
 */
export class LedgerCard {
  report(verdict: LedgerVerdict, taskTitle: string): CardModel {
    const { tally } = verdict;
    const tone = verdict.band === 'rework' ? 'danger' : verdict.band === 'recall' ? 'accent' : 'success';
    const nodes: CardNode[] = [
      {
        kind: 'meter',
        label: '[AI] 占比',
        value: tally.aiRatio,
        tone,
        caption: `[自] ${pct(tally.selfRatio)} · [改] ${pct(tally.total === 0 ? 0 : tally.revised / tally.total)}`,
      },
      { kind: 'divider' },
      { kind: 'kv', label: '[自] 自想', value: weightText(tally.self) },
      { kind: 'kv', label: '[AI] 未改', value: weightText(tally.ai) },
      { kind: 'kv', label: '[改] 实质改', value: weightText(tally.revised) },
      { kind: 'heading', text: '判定' },
      { kind: 'paragraph', text: verdict.headline },
      { kind: 'callout', tone, title: '建议动作', text: verdict.action },
    ];
    if (verdict.band === 'rework') {
      nodes.push({
        kind: 'footnote',
        text: '重做不需要推翻全部内容 —— 需要的是你重新走一次"先写骨架再看 AI"，然后把保留下来的部分重新标记。',
      });
    }
    return card(tone, '来源比例报告', nodes, taskTitle);
  }

  marked(segmentId: string, tag: string, label: string, verdict: LedgerVerdict): CardModel {
    const tone = verdict.band === 'rework' ? 'danger' : verdict.band === 'recall' ? 'accent' : 'success';
    const tagText = TAG_TEXT[tag] ?? tag;
    const segmentText = label === segmentId ? label : `${label}（${segmentId}）`;
    return card(tone, `已标记 [${tagText}]`, [
      { kind: 'kv', label: '段落', value: segmentText },
      {
        kind: 'meter',
        label: '当前 [AI] 占比',
        value: verdict.tally.aiRatio,
        tone,
        caption: `${verdict.tally.segments} 段已标`,
      },
      { kind: 'paragraph', text: verdict.headline },
    ]);
  }
}

/** 标签的展示文案与领域枚举分离：领域说 self/ai/revised，界面说 自/AI/改。 */
const TAG_TEXT: Record<string, string> = { self: '自', ai: 'AI', revised: '改' };

function weightText(weight: number): string {
  return `${Math.round(weight)} 字权重`;
}
