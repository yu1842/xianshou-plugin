import { numberProp, oneOf, optNum, optStr, schemaObject, str, stringProp, type Args } from '../args.js';
import { TASK_ID_PROP, XianshouTool } from '../tool-base.js';
import type { TaskService, ToolResult } from '../TaskService.js';
import type { ToolViews } from '../views.js';
import { LedgerPolicy, pct } from '../../domain/ledger.js';
import { DomainError, type SourceTag } from '../../domain/model.js';
import { formatIso } from '../../ui/format.js';
import { windowLabel } from '../../domain/recall.js';

/**
 * 留痕三件套：打标 / 审计 / 交付
 *
 * 关键设计：标记的单位是"段落"，不是"文档"。因为用户真正能判断的粒度是
 * "这一节是我写的还是 AI 写的"，而不是一个全文比例。
 */

const TAGS: readonly SourceTag[] = ['self', 'ai', 'revised'];

export class MarkSegmentTool extends XianshouTool {
  readonly name = 'xianshou_mark';
  readonly description =
    '给交付物里的一个段落打来源标记：[自] 自己想的 / [AI] AI 生成且未实质修改 / [改] AI 生成但自己做了实质修改。' +
    '同一 segment_id 重复标记会覆盖（改判）。建议按自然段或小节打标，不要给整篇打一个标签 —— 那样比例就失去意义了。';
  readonly parameters = schemaObject(
    {
      task_id: TASK_ID_PROP,
      segment_id: stringProp('段落的稳定标识，如 "sec-2" 或 "引言"'),
      tag: { type: 'string', enum: ['self', 'ai', 'revised'], description: 'self=[自] / ai=[AI] / revised=[改]' },
      label: stringProp('给人看的段名（可选），如"二、核心论证"'),
      weight: numberProp('该段权重，一般用字符数。默认 1 —— 但用字符数才不会被"写很长但全标自"骗过。'),
    },
    ['task_id', 'segment_id', 'tag'],
  );

  constructor(
    private readonly tasks: TaskService,
    private readonly views: ToolViews,
    private readonly ledgerPolicy: LedgerPolicy,
  ) {
    super();
  }

  protected async run(args: Args): Promise<ToolResult> {
    const task = await this.tasks.load(str(args, 'task_id'));
    const segmentId = str(args, 'segment_id', { max: 64 });
    const tag = oneOf(args, 'tag', TAGS);
    const label = optStr(args, 'label') ?? segmentId;
    const weight = Math.max(1, Math.trunc(optNum(args, 'weight') ?? 1));
    task.markSegment({ id: segmentId, label, tag, weight }, this.tasks.clock.now());
    await this.tasks.save(task);

    const verdict = this.ledgerPolicy.judge(task.ledger.tally());
    return {
      value: {
        task_id: task.id,
        segment_id: segmentId,
        tag,
        tally: verdict.tally,
        band: verdict.band,
        ai_ratio: verdict.tally.aiRatio,
      },
      card: this.views.ledger.marked(segmentId, tag, label, verdict),
    };
  }
}

export class AuditLedgerTool extends XianshouTool {
  readonly name = 'xianshou_audit';
  readonly description =
    '统计交付物的来源比例并给出判定：< 30% 正常；30%–60% 需先做回收测试；> 60% 打回红区重做。' +
    '交付前必须调用一次。判为"重做"时会清空初稿状态并标记 rework —— 这不是警告，是状态变更。';
  readonly parameters = schemaObject({ task_id: TASK_ID_PROP }, ['task_id']);

  constructor(
    private readonly tasks: TaskService,
    private readonly views: ToolViews,
    private readonly ledgerPolicy: LedgerPolicy,
  ) {
    super();
  }

  protected async run(args: Args): Promise<ToolResult> {
    const task = await this.tasks.load(str(args, 'task_id'));
    const verdict = this.ledgerPolicy.judge(task.ledger.tally());
    if (verdict.band === 'rework') {
      task.sendBackToRework(this.tasks.clock.now());
      await this.tasks.save(task);
    }
    return {
      value: {
        task_id: task.id,
        band: verdict.band,
        tally: verdict.tally,
        headline: verdict.headline,
        action: verdict.action,
        requires_recall: verdict.band !== 'healthy',
        status: task.status,
      },
      card: this.views.ledger.report(verdict, task.title),
    };
  }
}

export class DeliverTool extends XianshouTool {
  readonly name = 'xianshou_deliver';
  readonly description =
    '标记任务已交付，并生成回收闸门（默认 24 小时与 7 天各一次 3 分钟复述）。' +
    '只在用户确认"已经交了/发了/定稿了"之后调用。红区任务没有先手稿会被拒绝；' +
    '[AI] 占比 > 60% 时应先 xianshou_audit 处理，不要强行交付。';
  readonly parameters = schemaObject({ task_id: TASK_ID_PROP }, ['task_id']);

  constructor(
    private readonly tasks: TaskService,
    private readonly ledgerPolicy: LedgerPolicy,
  ) {
    super();
  }

  protected async run(args: Args): Promise<ToolResult> {
    const task = await this.tasks.load(str(args, 'task_id'));
    const verdict = this.ledgerPolicy.judge(task.ledger.tally());
    if (verdict.band === 'rework') {
      throw new DomainError(
        'DRAFT_REQUIRED',
        `[AI] 占比 ${pct(verdict.tally.aiRatio)} 超过 60%，不能按健康交付处理。`,
        '先执行 xianshou_audit 让它打回重做，或补上你自己的部分并重新标记。',
      );
    }
    const gates = task.deliver(this.tasks.clock.now());
    await this.tasks.save(task);
    return {
      value: {
        task_id: task.id,
        status: task.status,
        delivered_at: task.deliveredAt,
        gates: gates.map((g) => ({ window: windowLabel(g.window), scheduled_for: g.scheduledFor })),
      },
      card: {
        tone: 'teal',
        title: '已交付 · 回收闸门已上膛',
        subtitle: task.title,
        nodes: [
          ...gates.map((g) => ({
            kind: 'kv' as const,
            label: windowLabel(g.window),
            value: `${formatIso(g.scheduledFor)} 到期`,
            tone: 'teal' as const,
          })),
          { kind: 'divider' },
          {
            kind: 'callout',
            tone: 'accent',
            title: '到时候只做一件事',
            text: '合上所有材料，用 3 分钟回答三个问题。答不出来就是没学会，任务会被打回。',
          },
          { kind: 'footnote', text: `当前 [AI] 占比 ${pct(verdict.tally.aiRatio)} · 判分不看你交付得多漂亮，只看你还能不能讲出来` },
        ],
      },
    };
  }
}
