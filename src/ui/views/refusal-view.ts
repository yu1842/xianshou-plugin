import { card, type CardModel, type CardNode } from '../card.js';
import { refusalAction, refusalHeadline, type RefusalTally } from '../../domain/refusal.js';

/**
 * 拒绝率面板卡片
 *
 * 关键交互设计：当拒绝率过低时，不说"你应该多拒绝"（这是道德要求），
 * 而是给一个具体动作："下次先找一个可能错的地方"。可执行 > 正确。
 */
export class RefusalCard {
  panel(tally: RefusalTally, taskTitle?: string): CardModel {
    const tone =
      tally.band === 'blind' ? 'danger' : tally.band === 'healthy' ? 'success' : tally.band === 'contrarian' ? 'accent' : 'neutral';
    const nodes: CardNode[] = [];
    if (tally.rate === null) {
      nodes.push({ kind: 'paragraph', text: '还没有记录过任何一次"采纳 / 否决"。拒绝率是判断力探针，需要先有样本。' });
    } else if (tally.band === 'insufficient') {
      // 样本不足时不画计量条：一根满格或空格的横条会被读成"100%"或"0%"，
      // 而这时候真实情况是"还不知道"。
      nodes.push(
        { kind: 'paragraph', text: '样本还不够下结论。这时候任何比例都不可信 —— 包括看起来很高的那个。' },
        { kind: 'divider' },
        { kind: 'kv', label: '直接采纳', value: `${tally.accepted} 条` },
        { kind: 'kv', label: '实质否决', value: `${tally.rejected} 条` },
        { kind: 'kv', label: '部分修改', value: `${tally.partial} 条（按半权计）` },
      );
    } else {
      nodes.push(
        { kind: 'meter', label: '实质否决率', value: tally.rate, tone, caption: `健康区间 15%–40%` },
        { kind: 'divider' },
        { kind: 'kv', label: '直接采纳', value: `${tally.accepted} 条` },
        { kind: 'kv', label: '实质否决', value: `${tally.rejected} 条` },
        { kind: 'kv', label: '部分修改', value: `${tally.partial} 条（按半权计）` },
        { kind: 'heading', text: refusalHeadline(tally) },
        { kind: 'paragraph', text: refusalAction(tally) },
      );
    }
    if (tally.band === 'blind') {
      nodes.push({
        kind: 'callout',
        tone: 'danger',
        title: '推导',
        text: '82% 的人对 AI 输出有信心，同一批人里 68% 经常发现它出错。一个从不拒绝 AI 建议的人，几乎不可能是判断正确的那一个。',
      });
    }
    return card(tone, '拒绝率面板', nodes, taskTitle);
  }
}
