import { card, type CardModel, type CardNode } from '../card.js';
import type { CampEvaluation, CampRecord, ProbeRecord } from '../../domain/camp.js';
import { pct } from '../../domain/ledger.js';

/**
 * 训练营卡片
 *
 * 这类卡片的说服力来自"具体"：不是"加油，坚持四周"，而是
 * "第 12 天 · W2 先手训练 · 评价重点是那 20 分钟是不是越来越不难"。
 */

const PHASE_LABEL: Record<string, string> = {
  'awaiting-baseline': 'W1 · 建立基线',
  drill: 'W2 · 先手训练',
  recall: 'W3 · 回收训练',
  'awaiting-exit': 'W4 · 脱离测试',
  graduated: '已结营',
};

export class CampCard {
  started(camp: CampRecord): CardModel {
    return card(
      'teal',
      '训练营已开营',
      [
        { kind: 'kv', label: '周期', value: `${camp.weeks} 周` },
        { kind: 'kv', label: '起点', value: formatTime(camp.startedAt) },
        { kind: 'divider' },
        { kind: 'heading', text: '四周安排' },
        {
          kind: 'list',
          ordered: true,
          items: [
            'W1 建立基线：不用 AI，独立完成一个真实小任务，记耗时与质量。这周不教任何工具。',
            'W2 先手训练：每天一个红区任务，严格 20 分钟先手。',
            'W3 回收训练：强制 24 小时与 7 天双回收，记录通过率。',
            'W4 脱离测试：撤掉 AI 做同难度任务，与基线对比。',
          ],
        },
        {
          kind: 'callout',
          tone: 'accent',
          title: '现在只做一件事',
          text: '做一个不用 AI 的小任务，然后用 xianshou_probe kind=baseline 记下耗时与质量。没有基线的人，之后所有"我感觉进步了"都不可信。',
        },
        { kind: 'footnote', text: `训练营 ${camp.id} · 第一周和第四周必须做两次裸考，这是唯一能证明课程有效的方式` },
      ],
      camp.label,
    );
  }

  progress(evaluation: CampEvaluation, camp: CampRecord): CardModel {
    const tone =
      evaluation.phase === 'awaiting-baseline' ? 'accent' : evaluation.phase === 'awaiting-exit' ? 'teal' : 'neutral';
    const nodes: CardNode[] = [
      { kind: 'badge', text: PHASE_LABEL[evaluation.phase] ?? evaluation.phase, tone },
      { kind: 'kv', label: '第几天', value: `第 ${evaluation.dayIndex} 天` },
      { kind: 'kv', label: '基线', value: camp.baseline ? `${camp.baseline.minutes} 分钟 / ${camp.baseline.quality} 分` : '未记录' },
      { kind: 'divider' },
      { kind: 'paragraph', text: evaluation.detail },
      { kind: 'callout', tone: 'accent', title: '下一步', text: evaluation.nextStep },
    ];
    return card(tone, evaluation.headline, nodes, camp.label);
  }

  probeRecorded(probe: ProbeRecord, evaluation: CampEvaluation, warnings: readonly string[]): CardModel {
    const isBaseline = probe.kind === 'baseline';
    const nodes: CardNode[] = [
      { kind: 'badge', text: isBaseline ? '基线已记录' : '脱离测试已记录', tone: isBaseline ? 'teal' : 'success' },
      { kind: 'kv', label: '任务', value: probe.title },
      { kind: 'kv', label: '耗时', value: `${probe.minutes} 分钟` },
      { kind: 'kv', label: '质量', value: `${probe.quality} 分` },
    ];
    if (!isBaseline) {
      nodes.push(
        { kind: 'divider' },
        { kind: 'kv', label: '质量比', value: evaluation.qualityRatio === null ? '—' : pct(evaluation.qualityRatio) },
        {
          kind: 'kv',
          label: '耗时变化',
          value:
            evaluation.timeRatio === null
              ? '—'
              : `${evaluation.timeRatio >= 1 ? '+' : ''}${Math.round((evaluation.timeRatio - 1) * 100)}%`,
        },
      );
    }
    for (const warning of warnings) nodes.push({ kind: 'callout', tone: 'accent', title: '注意', text: warning });
    nodes.push({
      kind: 'footnote',
      text: isBaseline
        ? `${evaluation.headline} · 接下来进入 W2，正常建档与落稿即可`
        : evaluation.headline,
    });
    return card(isBaseline ? 'teal' : 'success', isBaseline ? '基线已建立' : '脱离测试已完成', nodes);
  }

  verdict(evaluation: CampEvaluation, camp: CampRecord): CardModel {
    const tone =
      evaluation.verdict === 'pass' ? 'success' : evaluation.verdict === 'partial' ? 'accent' : evaluation.verdict === 'fail' ? 'danger' : 'neutral';
    const baseline = camp.baseline;
    const exit = camp.exit;
    const nodes: CardNode[] = [
      { kind: 'badge', text: verdictLabel(evaluation.verdict), tone },
      ...(baseline && exit
        ? [
            { kind: 'heading' as const, text: '两次裸考' },
            { kind: 'kv' as const, label: 'W1 基线', value: `${baseline.minutes} 分钟 / ${baseline.quality} 分` },
            { kind: 'kv' as const, label: 'W4 脱离', value: `${exit.minutes} 分钟 / ${exit.quality} 分` },
            { kind: 'divider' as const },
            {
              kind: 'meter' as const,
              label: '质量比',
              value: evaluation.qualityRatio ?? 0,
              tone: (evaluation.qualityRatio ?? 0) >= 0.9 ? ('success' as const) : ('danger' as const),
              caption: '要求 ≥ 90%',
            },
            {
              kind: 'meter' as const,
              label: '耗时比',
              // 以"+20% 预算"为满格：否则 1.08 会画成满格，看起来像"刚好达标"
              value: Math.min(1, (evaluation.timeRatio ?? 0) / 1.2),
              tone: (evaluation.timeRatio ?? 9) <= 1.2 ? ('success' as const) : ('danger' as const),
              caption: `实际 ${evaluation.timeRatio === null ? '—' : `${evaluation.timeRatio >= 1 ? '+' : ''}${Math.round((evaluation.timeRatio - 1) * 100)}%`}　要求 ≤ +20%`,
            },
          ]
        : []),
      { kind: 'paragraph', text: evaluation.detail },
      { kind: 'callout', tone: tone === 'neutral' ? 'accent' : tone, title: '然后呢', text: evaluation.nextStep },
      {
        kind: 'footnote',
        text: '验收标准来自方案原文：质量不低于基线的 90%，耗时增幅不超过 20%。不达标不是失败，是比漂亮分数更有用的信息。',
      },
    ];
    return card(tone, evaluation.headline, nodes, camp.label);
  }
}

function verdictLabel(verdict: string): string {
  if (verdict === 'pass') return '通过';
  if (verdict === 'partial') return '部分达标';
  if (verdict === 'fail') return '未通过';
  return '待验收';
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
