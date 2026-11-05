import { card, type CardModel, type CardNode } from '../card.js';
import type { ZoneDecision } from '../../domain/zone.js';
import type { TaskRecord } from '../../domain/task.js';
import type { ThresholdPolicy } from '../../domain/policy.js';
import { pct } from '../../domain/ledger.js';

/**
 * 任务 / 分区 / 闸门 三类卡片
 *
 * 交互原则（见 docs/UI-SPEC.md §3）：每张卡只有一个"下一步"，
 * 且下一步必须是可执行的动作，不是"请注意"。说教卡片一律不出。
 */

const ZONE_META = {
  red: { label: '红区 · 必须先手', tone: 'danger' as const, minutes: 20 },
  yellow: { label: '黄区 · 可先问', tone: 'accent' as const, minutes: 0 },
  green: { label: '绿区 · 放开用', tone: 'success' as const, minutes: 0 },
};

export class ZoneCard {
  constructor(private readonly policy: ThresholdPolicy) {}

  forDecision(taskId: string, title: string, decision: ZoneDecision): CardModel {
    const meta = ZONE_META[decision.zone];
    const nodes: CardNode[] = [
      { kind: 'badge', text: meta.label, tone: meta.tone },
      { kind: 'paragraph', text: decision.rationale },
      { kind: 'kv', label: '命中判据', value: decision.ruleId },
      { kind: 'divider' },
    ];

    if (decision.zone === 'red') {
      nodes.push(
        { kind: 'heading', text: '下一步' },
        {
          kind: 'list',
          ordered: true,
          items: [
            `先花 ${this.policy.draftMinutes} 分钟写一个丑版本（骨架 / 伪代码 / 三条判断）`,
            '用 xianshou_draft 落稿，落稿后 AI 才被放行',
            'AI 增强完，用 xianshou_mark 标来源',
            '交付后 24 小时与 7 天各做一次 3 分钟复述',
          ],
        },
      );
    } else if (decision.zone === 'yellow') {
      nodes.push({
        kind: 'callout',
        tone: 'accent',
        title: '唯一的硬要求',
        text: '交付前必须能复述要点。答不出来，这个任务下一轮按红区处理。',
      });
    } else {
      nodes.push({
        kind: 'paragraph',
        text: '与能力成长无关，用多少都不产生认知债。不需要先手，也不需要留痕。',
      });
    }

    nodes.push({ kind: 'footnote', text: `任务 ${taskId} · ${title}` });
    return card(meta.tone, `已归档到${meta.label.split(' · ')[0]}`, nodes);
  }
}

export class GateCard {
  constructor(private readonly policy: ThresholdPolicy) {}

  /** 拦截卡：必须同时给出"为什么"和"怎么过"，否则用户只会去关插件。 */
  blocked(task: TaskRecord): CardModel {
    const minutes = this.policy.draftMinutes;
    return card(
      'danger',
      '先手闸门 · 已拦下这次调用',
      [
        { kind: 'badge', text: '红区任务 · 无初稿', tone: 'danger' },
        {
          kind: 'paragraph',
          text: `「${task.title}」属于要先手再增强的任务，但还没有可核对的初稿。AI 现在介入，你会拿到一份自己没参与建造的东西。`,
        },
        { kind: 'heading', text: `花 ${minutes} 分钟，过闸` },
        {
          kind: 'list',
          ordered: true,
          items: [
            '写一页骨架、三段提纲、伪代码，或三条你认为最关键的判断',
            '调用 xianshou_draft 提交（不足 80 字的敷衍内容会被拒）',
            '再重新发起刚才那次调用',
          ],
        },
        {
          kind: 'callout',
          tone: 'accent',
          title: '如果 20 分钟产不出任何东西',
          text: '这本身是信号：你对任务的领域理解还不够。此时该做的是补背景，而不是让 AI 替你完成理解。',
        },
        { kind: 'footnote', text: `任务 ${task.id} · 闸门不会记录你写了什么，只记录"有没有落稿"` },
      ],
      'AI 只能在你自己出过手之后介入',
    );
  }

  /** 通过卡：只在"刚过闸"这种关键时刻出现，日常放行不打扰。 */
  released(task: TaskRecord): CardModel {
    return card('teal', '闸门已放行', [
      { kind: 'kv', label: '任务', value: task.title },
      { kind: 'kv', label: '初稿字数', value: `${[...(task.draft?.content ?? '')].length} 字` },
      { kind: 'kv', label: '先手时长', value: `${task.draft?.minutesSpent ?? 0} 分钟` },
      { kind: 'divider' },
      { kind: 'paragraph', text: '现在可以让 AI 参与了。它应该在你的结构上做校验和补充，而不是替你决定结构。' },
    ]);
  }
}

export class TaskCard {
  constructor(private readonly policy: ThresholdPolicy) {}

  summary(task: TaskRecord): CardModel {
    const tally = task.ledger.tally();
    const nodes: CardNode[] = [
      { kind: 'badge', text: ZONE_META[task.zone].label, tone: ZONE_META[task.zone].tone },
      { kind: 'kv', label: '状态', value: statusLabel(task.status) },
      { kind: 'kv', label: '初稿', value: task.hasDraft ? `${[...(task.draft?.content ?? '')].length} 字` : '未落稿' },
      { kind: 'kv', label: '已标记段落', value: `${tally.segments} 段` },
    ];
    if (tally.total > 0) {
      nodes.push({
        kind: 'meter',
        label: '[AI] 占比',
        value: tally.aiRatio,
        tone: tally.aiRatio > this.policy.aiRatioRework ? 'danger' : tally.aiRatio >= this.policy.aiRatioRecall ? 'accent' : 'success',
        caption: `[自] ${pct(tally.selfRatio)}`,
      });
    }
    if (task.gates.length > 0) {
      const pending = task.gates.filter((g) => !task.recalls.some((r) => r.window === g.window));
      if (pending.length > 0) {
        nodes.push({ kind: 'kv', label: '待回收', value: pending.map((g) => (g.window === 'd24h' ? '24h' : '7d')).join(' / '), tone: 'teal' });
      }
    }
    nodes.push({ kind: 'footnote', text: `任务 ${task.id} · 更新于 ${task.updatedAt}` });
    return card(ZONE_META[task.zone].tone, task.title, nodes);
  }
}

export function statusLabel(status: TaskRecord['status']): string {
  switch (status) {
    case 'open':
      return '进行中';
    case 'delivered':
      return '已交付 · 待回收';
    case 'rework':
      return '已打回 · 需重做先手';
  }
}
