import { card, type CardModel, type CardNode } from '../card.js';
import { RECALL_QUESTIONS, windowLabel, type RecallAttempt, type RecallGate } from '../../domain/recall.js';
import type { TaskRecord } from '../../domain/task.js';

/**
 * 回收闸门卡片
 *
 * 原文强调："问题必须具体，泛泛的复习提醒打开率会归零。"
 * 所以卡片里绝不出现"来复习一下"，只有三个真问题，且要求合上材料。
 */
export class RecallCard {
  /** 到期提醒。一道一卡会刷屏，因此多个到期窗口合并为一张。 */
  due(task: TaskRecord, gates: readonly RecallGate[], overdue: boolean): CardModel {
    const windows = gates.map((g) => windowLabel(g.window)).join(' / ');
    const nodes: CardNode[] = [
      { kind: 'badge', text: overdue ? '已逾期' : '到期', tone: overdue ? 'danger' : 'teal' },
      { kind: 'paragraph', text: `「${task.title}」的${windows}到点了。合上所有材料，用 3 分钟回答下面三个问题。` },
      { kind: 'heading', text: '三个问题' },
      { kind: 'list', ordered: true, items: RECALL_QUESTIONS },
      { kind: 'divider' },
      { kind: 'kv', label: '判定标准', value: '说不出来，就是没学会' },
      { kind: 'kv', label: '提交方式', value: `xianshou_recall task_id=${task.id} window=${gates[0]?.window ?? 'd24h'}` },
      {
        kind: 'callout',
        tone: 'accent',
        title: '为什么必须现在做',
        text: '这是整套方案里唯一无法伪造的动作 —— 你没法假装自己记得。',
      },
    ];
    return card(overdue ? 'danger' : 'teal', `${windows}回收`, nodes);
  }

  result(attempt: RecallAttempt, taskTitle: string): CardModel {
    const passed = attempt.verdict === 'pass';
    const tone = passed ? 'success' : 'danger';
    const nodes: CardNode[] = [
      {
        kind: 'meter',
        label: '复述得分',
        value: attempt.score,
        tone,
        caption: `及格线 80%`,
      },
      { kind: 'divider' },
      ...RECALL_QUESTIONS.map((question, index) => ({
        kind: 'kv' as const,
        label: `${index + 1}. ${shorten(question)}`,
        value: `${attempt.scores[index] ?? 0}/2`,
        tone: (attempt.scores[index] ?? 0) <= 1 ? ('danger' as const) : ('success' as const),
      })),
      { kind: 'heading', text: '判定' },
      {
        kind: 'paragraph',
        text: passed
          ? '通过了。这条任务的知识确实留在了你身上，不只是留在了文件里。'
          : `没通过${attempt.weakQuestions.length > 0 ? `，卡在第 ${attempt.weakQuestions.join('、')} 题` : ''}。该任务已打回黄区，需要用一次完整的先手重做。`,
      },
    ];
    if (!passed) {
      nodes.push({
        kind: 'callout',
        tone: 'danger',
        title: '没有例外',
        text: '打回不是惩罚，是把"我以为我会了"和"我真的会了"分开的那一步。重做时不要先看旧稿。',
      });
    }
    nodes.push({ kind: 'footnote', text: `任务 ${taskTitle} · ${windowLabel(attempt.window)} · 判分方式：${attempt.scores.length === 3 ? '三题自评' : '结构校验'}` });
    return card(tone, passed ? '回收通过' : '回收未通过', nodes);
  }
}

function shorten(text: string): string {
  return text.replace(/？$/, '');
}
