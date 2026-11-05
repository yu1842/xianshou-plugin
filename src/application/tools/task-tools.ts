import {
  booleanProp,
  numberProp,
  optBool,
  optStr,
  optStrArray,
  schemaObject,
  str,
  stringProp,
  type Args,
} from '../args.js';
import { TASK_ID_PROP, XianshouTool } from '../tool-base.js';
import type { TaskService, ToolResult } from '../TaskService.js';
import type { ToolViews } from '../views.js';
import { DomainError } from '../../domain/model.js';
import { pct } from '../../domain/ledger.js';
import { windowLabel } from '../../domain/recall.js';

/**
 * 任务三件套：建档 / 查状态 / 先手落稿
 *
 * 工具描述不是功能说明书，而是"什么时候该用"的可执行条件。
 * 模型主要靠这段文字决定行为，因此这里写的是判据，不是能力清单。
 */

export class StartTaskTool extends XianshouTool {
  readonly name = 'xianshou_start';
  readonly description =
    '为一次任务建立认知债档案，并判定它属于红区（必须先手）/ 黄区（可先问）/ 绿区（放开用）。' +
    '凡是用户要"用 AI 帮忙做"的实质工作，先调用本工具，再动其他工具。' +
    '三个判据必须由用户回答，不要替他猜：这件事以后还要重复做吗？落在他的能力圈内吗？跟他的能力成长有关吗？';
  readonly parameters = schemaObject(
    {
      title: stringProp('任务的简短名称，会出现在卡片标题里', { maxLength: 120 }),
      repeatable: booleanProp('这件事用户以后还要重复做吗？'),
      within_competence: booleanProp('这件事落在用户当前的能力圈内吗（他能独立做出来）？'),
      growth_relevant: booleanProp('这件事与用户的能力成长有关吗？纯搬运/排版/翻译类杂务为 false。'),
      reused_framework: booleanProp('是否复用了用户自己既有的框架（用于跨任务迁移率统计）'),
    },
    ['title', 'repeatable', 'within_competence', 'growth_relevant'],
  );

  constructor(
    private readonly tasks: TaskService,
    private readonly views: ToolViews,
  ) {
    super();
  }

  protected async run(args: Args): Promise<ToolResult> {
    const title = str(args, 'title', { max: 120 });
    const repeatable = optBool(args, 'repeatable');
    const within = optBool(args, 'within_competence');
    const growth = optBool(args, 'growth_relevant');
    if (repeatable === undefined || within === undefined || growth === undefined) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        '三个判据（repeatable / within_competence / growth_relevant）都必须明确回答，不能留空。',
        '先问用户这三个问题，再建档。判错的代价是后面所有闸门一起失效。',
      );
    }
    const reused = optBool(args, 'reused_framework');
    const { task, decision } = await this.tasks.create({
      title,
      signals: { repeatable, withinCompetence: within, growthRelevant: growth },
      ...(reused === undefined ? {} : { reusedFramework: reused }),
    });

    return {
      value: {
        task_id: task.id,
        zone: task.zone,
        rule: decision.ruleId,
        requires_draft: task.requiresDraft,
        draft_minutes: this.tasks.policy.draftMinutes,
      },
      card: this.views.zone.forDecision(task.id, task.title, decision),
    };
  }
}

export class TaskStatusTool extends XianshouTool {
  readonly name = 'xianshou_status';
  readonly description =
    '查看一个任务的当前状态（分区、是否已落稿、[AI] 占比、待回收窗口）；不传 task_id 时列出全部任务。' +
    '用户问"我现在什么进度""还有哪些账没还"时使用。';
  readonly parameters = schemaObject({ task_id: TASK_ID_PROP }, []);

  constructor(
    private readonly tasks: TaskService,
    private readonly views: ToolViews,
  ) {
    super();
  }

  protected async run(args: Args): Promise<ToolResult> {
    const taskId = optStr(args, 'task_id');
    if (taskId) {
      const task = await this.tasks.load(taskId);
      const tally = task.ledger.tally();
      const pending = task.gates.filter((g) => !task.recalls.some((r) => r.window === g.window));
      return {
        value: {
          task_id: task.id,
          zone: task.zone,
          status: task.status,
          has_draft: task.hasDraft,
          segments: tally.segments,
          ai_ratio: tally.aiRatio,
          due_recalls: pending.map((g) => windowLabel(g.window)),
        },
        card: this.views.task.summary(task),
      };
    }

    const all = await this.tasks.list();
    if (all.length === 0) {
      return {
        value: { count: 0, tasks: [] },
        card: {
          tone: 'neutral',
          title: '还没有任何任务',
          nodes: [
            { kind: 'paragraph', text: '认知债的账本目前是空的。第一次用 AI 做实质工作前，先建档。' },
            { kind: 'footnote', text: 'xianshou_start 只需要回答三个问题。' },
          ],
        },
      };
    }
    return {
      value: {
        count: all.length,
        tasks: all.map((t) => ({
          task_id: t.id,
          title: t.title,
          zone: t.zone,
          status: t.status,
          ai_ratio: t.ledger.tally().aiRatio,
        })),
      },
      card: {
        tone: 'teal',
        title: `共 ${all.length} 个任务`,
        subtitle: '红区必须先手；黄区须能复述；绿区放开用',
        nodes: all.slice(0, 12).map((t) => ({
          kind: 'kv' as const,
          label: `${zoneGlyph(t.zone)} ${t.title}`,
          value: `${statusText(t.status)}　[AI] ${pct(t.ledger.tally().aiRatio)}`,
        })),
      },
    };
  }
}

export class SubmitDraftTool extends XianshouTool {
  readonly name = 'xianshou_draft';
  readonly description =
    '提交用户的"丑版本"先手稿（骨架 / 三段提纲 / 伪代码 / 三条关键判断），落稿后红区任务才会被放行。' +
    '内容必须来自用户本人，不要替他生成 —— 这一步被代劳，整个方案就失效了。' +
    '不足 80 字、且既无结构也无三条判断的内容会被拒绝。';
  readonly parameters = schemaObject(
    {
      task_id: TASK_ID_PROP,
      content: stringProp('用户自己写的丑版本原文。原样提交，不要润色，不要补充。'),
      minutes_spent: numberProp('用户自报投入的分钟数（可选；申报后会被校验）'),
      key_judgements: {
        type: 'array',
        items: { type: 'string' },
        description: '如果内容是零散判断而非提纲，把三条以上关键判断逐条列出',
      },
    },
    ['task_id', 'content'],
  );

  constructor(
    private readonly tasks: TaskService,
    private readonly views: ToolViews,
  ) {
    super();
  }

  protected async run(args: Args): Promise<ToolResult> {
    const task = await this.tasks.load(str(args, 'task_id'));
    const content = str(args, 'content');
    const minutes = optionalMinutes(args);
    const judgements = optStrArray(args, 'key_judgements');
    const artifact = task.submitDraft(
      {
        content,
        ...(minutes === undefined ? {} : { minutesSpent: minutes }),
        ...(judgements === undefined ? {} : { keyJudgements: judgements }),
      },
      this.tasks.clock.now(),
    );
    await this.tasks.save(task);
    return {
      value: { task_id: task.id, chars: [...artifact.content].length, minutes_spent: artifact.minutesSpent, gate_open: true },
      card: this.views.gate.released(task),
    };
  }
}

function optionalMinutes(args: Args): number | undefined {
  const raw = args['minutes_spent'];
  if (raw === undefined || raw === null) return undefined;
  const num = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(num) ? Math.max(0, Math.trunc(num)) : undefined;
}

function zoneGlyph(zone: 'red' | 'yellow' | 'green'): string {
  return zone === 'red' ? '[红]' : zone === 'yellow' ? '[黄]' : '[绿]';
}

function statusText(status: 'open' | 'delivered' | 'rework'): string {
  return status === 'open' ? '进行中' : status === 'delivered' ? '已交付' : '需重做';
}
