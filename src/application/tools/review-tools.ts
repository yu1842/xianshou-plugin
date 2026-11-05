import {
  arrayProp,
  oneOf,
  optNumArray,
  optStr,
  schemaObject,
  str,
  stringProp,
  type Args,
} from '../args.js';
import { EMPTY_PARAMS, TASK_ID_PROP, XianshouTool } from '../tool-base.js';
import type { TaskService, ToolResult } from '../TaskService.js';
import type { ToolViews } from '../views.js';
import { RECALL_QUESTIONS, windowLabel, type RecallWindow } from '../../domain/recall.js';
import { DomainError } from '../../domain/model.js';
import { HealthReportBuilder } from '../../domain/health.js';
import type { RefusalDecision } from '../../domain/refusal.js';

/**
 * 回收 / 拒绝率 / 健康度
 *
 * 这三个工具都只做一件事，且都不允许"刷分"：回收只能答一次，
 * 拒绝率按建议 id 覆盖，健康度是纯聚合。
 */

const WINDOWS: readonly string[] = ['d24h', 'd7d', '24h', '7d'];

export class RecallTool extends XianshouTool {
  readonly name = 'xianshou_recall';
  readonly description =
    '提交一次回收测试（3 分钟复述）的答案。三个问题必须依次回答：核心逻辑、最不确定的点、被反问时靠什么答。' +
    '合上材料再答 —— 这一条是整个方案里唯一无法伪造的动作。必须同时给出 self_report（三题 0=讲不出 / 1=说得清但卡壳 / 2=能完整讲）。' +
    '得分 < 80% 时任务会自动打回黄区重做先手，且同一窗口不能重答。';
  readonly parameters = schemaObject(
    {
      task_id: TASK_ID_PROP,
      window: { type: 'string', enum: ['d24h', 'd7d'], description: 'd24h=交付后 24 小时回收；d7d=7 天后回收' },
      answers: arrayProp('依次回答三个问题的原文（每题至少一句完整的话）', { type: 'string' }),
      self_report: arrayProp('三题自评得分，0–2 的整数', { type: 'integer', minimum: 0, maximum: 2 }),
      keep_task_open: { type: 'boolean', description: '保留给未来使用；当前为 false' },
    },
    ['task_id', 'window', 'answers', 'self_report'],
  );

  constructor(
    private readonly tasks: TaskService,
    private readonly views: ToolViews,
  ) {
    super();
  }

  protected async run(args: Args): Promise<ToolResult> {
    const task = await this.tasks.load(str(args, 'task_id'));
    const raw = oneOf(args, 'window', WINDOWS);
    const window: RecallWindow = raw === 'd24h' || raw === '24h' ? 'd24h' : 'd7d';
    const answers = args['answers'];
    if (!Array.isArray(answers) || answers.length !== RECALL_QUESTIONS.length) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `answers 必须依次包含 ${RECALL_QUESTIONS.length} 个问题的答案。`,
        '三个问题：核心逻辑是什么 / 最不确定什么 / 被反问靠什么答。缺一题就无法判定。',
      );
    }
    const selfReport = optNumArray(args, 'self_report');
    const attempt = task.answerRecall(
      window,
      answers.map((a) => String(a ?? '')),
      this.tasks.clock.now(),
      selfReport,
    );
    await this.tasks.save(task);
    return {
      value: {
        task_id: task.id,
        window: windowLabel(attempt.window),
        score: attempt.score,
        verdict: attempt.verdict,
        weak_questions: attempt.weakQuestions,
        new_zone: task.zone,
        status: task.status,
      },
      card: this.views.recall.result(attempt, task.title),
    };
  }
}

export class RefusalTool extends XianshouTool {
  readonly name = 'xianshou_refusal';
  readonly description =
    '记录用户对一条 AI 建议的处理方式：accepted（直接采纳）/ rejected（实质否决）/ partial（采纳但做了实质修改）。' +
    '每次用户明确否定或改写了一条 AI 建议时调用一次。这是判断力探针，不记录就无法发现"可能在盲从"。';
  readonly parameters = schemaObject(
    {
      task_id: TASK_ID_PROP,
      suggestion_id: stringProp('该条建议的稳定标识；同一 id 重复记录会覆盖'),
      decision: { type: 'string', enum: ['accepted', 'rejected', 'partial'], description: '处理方式' },
      note: stringProp('用户否决/修改的理由（可选，一两句话即可）'),
    },
    ['task_id', 'suggestion_id', 'decision'],
  );

  constructor(
    private readonly tasks: TaskService,
    private readonly views: ToolViews,
  ) {
    super();
  }

  protected async run(args: Args): Promise<ToolResult> {
    const task = await this.tasks.load(str(args, 'task_id'));
    const decision = oneOf(args, 'decision', ['accepted', 'rejected', 'partial'] as const) as RefusalDecision;
    const note = optStr(args, 'note');
    task.recordRefusal(
      {
        suggestionId: str(args, 'suggestion_id', { max: 64 }),
        decision,
        ...(note === undefined ? {} : { note }),
      },
      this.tasks.clock.now(),
    );
    await this.tasks.save(task);
    const tally = task.refusals.tally();
    return {
      value: { task_id: task.id, tally, rate: tally.rate, band: tally.band },
      card: this.views.refusal.panel(tally, task.title),
    };
  }
}

export class HealthTool extends XianshouTool {
  readonly name = 'xianshou_health';
  readonly description =
    '生成认知债健康度报告：无提示复述准确率、首版自主率、拒绝率、跨任务迁移率四个指标。' +
    '用户问"我这段时间到底有没有长进""我的用 AI 方式健不健康"时使用。四个指标必须一起看，任何一个单独看都会被伪装。' +
    'EMPTY 无参数。';
  readonly parameters = EMPTY_PARAMS;

  constructor(
    private readonly tasks: TaskService,
    private readonly views: ToolViews,
  ) {
    super();
  }

  protected async run(): Promise<ToolResult> {
    const all = await this.tasks.list();
    const report = new HealthReportBuilder(this.tasks.policy).build(all, this.tasks.clock.now());
    return {
      value: {
        samples: report.samples,
        metrics: report.metrics.map((m) => ({ key: m.key, label: m.label, value: m.value, band: m.band })),
        top_concern: report.topConcern,
      },
      card: this.views.health.report(report),
    };
  }
}

