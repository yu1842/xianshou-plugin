import {
  booleanProp,
  numberProp,
  optBool,
  optNum,
  optStr,
  schemaObject,
  str,
  stringProp,
  type Args,
} from '../args.js';
import { XianshouTool } from '../tool-base.js';
import type { TaskService, ToolResult } from '../TaskService.js';
import type { ToolViews } from '../views.js';
import type { DocumentStore } from '../../ports/documents.js';
import { DomainError } from '../../domain/model.js';
import {
  CAMP_DOC_KEY,
  createCamp,
  evaluateCamp,
  isCamp,
  recordProbe,
  type CampRecord,
  type ProbeInput,
} from '../../domain/camp.js';

/**
 * 训练营工具：开营 / 看进度 / 记录两次裸考
 *
 * 为什么拆成两个工具而不是一个大工具：
 * "记录裸考"是流程里唯一需要用户亲自做事、且不可代劳的动作（模型不能替他打分）。
 * 单独一个工具能让模型在描述里读到"必须由用户回答"，也方便用户在需要时直接点名调用。
 */

export interface CampToolDeps {
  readonly tasks: TaskService;
  readonly views: ToolViews;
  readonly documents: DocumentStore;
}

async function readCamp(documents: DocumentStore): Promise<CampRecord | null> {
  const raw = await documents.read(CAMP_DOC_KEY);
  return isCamp(raw) ? (raw as CampRecord) : null;
}

export class CampTool extends XianshouTool {
  readonly name = 'xianshou_camp';
  readonly description =
    '四周训练营：开营、查看当前阶段与验收结果。' +
    'action=start 新建一轮（会记录起点时间）；action=status 查看第几天、该做什么、以及脱离测试的判定。' +
    '验收标准是硬的：质量不低于基线的 90%、耗时增幅不超过 20%，两个数都来自两次"不用 AI"的裸考。' +
    '用户说"我想系统练四周""开个训练营""我练到哪一步了"时使用。';
  readonly parameters = schemaObject(
    {
      action: { type: 'string', enum: ['start', 'status'], description: 'start=开营；status=看进度（默认）' },
      label: stringProp('这一轮的标签，如"2026 秋 · 第 1 期"'),
      weeks: numberProp('周期周数，默认 4，允许 2–12'),
    },
    [],
  );

  constructor(private readonly deps: CampToolDeps) {
    super();
  }

  protected async run(args: Args): Promise<ToolResult> {
    const action = (optStr(args, 'action') ?? 'status') as 'start' | 'status';
    if (action !== 'start' && action !== 'status') {
      throw new DomainError('INVALID_ARGUMENT', `action 只能是 start / status，收到 ${action}。`);
    }
    const now = this.deps.tasks.clock.now();
    const existing = await readCamp(this.deps.documents);

    if (action === 'start') {
      if (existing && existing.exit === null) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          '已经有一轮进行中的训练营。',
          '先把这一轮走完（做完脱离测试），或换个标签等它结束再开新的。中途重开等于重置基线，之前的对比就没了。',
        );
      }
      const weeks = optNum(args, 'weeks');
      const camp = createCamp({
        id: `camp-${now.getTime().toString(36)}`,
        label: optStr(args, 'label') ?? '先手协议 · 四周训练营',
        now,
        ...(weeks === undefined ? {} : { weeks }),
      });
      await this.deps.documents.write(CAMP_DOC_KEY, camp);
      return {
        value: { ok: true, action: 'start', campId: camp.id, startedAt: camp.startedAt, weeks: camp.weeks },
        card: this.deps.views.camp.started(camp),
      };
    }

    if (!existing) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        '还没有开营记录。',
        '先 xianshou_camp action=start。没有起点时间，就无法判断你现在该做哪一周的事。',
      );
    }
    const evaluation = evaluateCamp(existing, now, this.deps.tasks.policy);
    return {
      value: {
        ok: true,
        action: 'status',
        campId: existing.id,
        dayIndex: evaluation.dayIndex,
        phase: evaluation.phase,
        verdict: evaluation.verdict,
        qualityRatio: evaluation.qualityRatio,
        timeRatio: evaluation.timeRatio,
        readyForExit: evaluation.readyForExit,
      },
      card:
        evaluation.verdict === 'pending'
          ? this.deps.views.camp.progress(evaluation, existing)
          : this.deps.views.camp.verdict(evaluation, existing),
    };
  }
}

export class ProbeTool extends XianshouTool {
  readonly name = 'xianshou_probe';
  readonly description =
    '记录一次"裸考"（不用 AI 独立完成的任务），kind=baseline 是 W1 基线，kind=exit 是 W4 脱离测试。' +
    '必须由用户本人完成并提供耗时与质量分；模型不能代填。' +
    'ai_used=true 会被直接拒绝——用了 AI 的产出是"AI 的基线"，不是你的。' +
    '基线只能记一次；脱离测试要等到第 21 天，且必须先有基线。';
  readonly parameters = schemaObject(
    {
      kind: { type: 'string', enum: ['baseline', 'exit'], description: 'baseline=W1 基线；exit=W4 脱离测试' },
      title: stringProp('这次裸考做的任务，一句话'),
      minutes: numberProp('实际耗时（分钟）'),
      quality: numberProp('质量评分 0–100，两次必须用同一把尺子'),
      ai_used: booleanProp('是否使用了 AI。必须为 false，否则拒绝记录'),
      note: stringProp('评分依据或背景（可选）'),
      force: booleanProp('补录历史数据时跳过"必须等到第 21 天"的限制（结果会标注不可横向比较）'),
    },
    ['kind', 'title', 'minutes', 'quality', 'ai_used'],
  );

  constructor(private readonly deps: CampToolDeps) {
    super();
  }

  protected async run(args: Args): Promise<ToolResult> {
    const kind = str(args, 'kind');
    if (kind !== 'baseline' && kind !== 'exit') {
      throw new DomainError('INVALID_ARGUMENT', `kind 只能是 baseline / exit，收到 ${kind}。`);
    }
    const camp = await readCamp(this.deps.documents);
    if (!camp) {
      throw new DomainError('INVALID_ARGUMENT', '还没有训练营。', '先 xianshou_camp action=start，再做裸考。');
    }

    const aiUsed = optBool(args, 'ai_used');
    const input: ProbeInput = {
      kind,
      title: str(args, 'title', { max: 120 }),
      minutes: optNum(args, 'minutes') ?? 0,
      quality: optNum(args, 'quality') ?? 0,
      aiUsed: aiUsed === true,
      at: this.deps.tasks.clock.now(),
      ...(optStr(args, 'note') ? { note: optStr(args, 'note') as string } : {}),
      ...(optBool(args, 'force') === true ? { force: true } : {}),
    };

    const outcome = recordProbe(camp, input, this.deps.tasks.policy);
    await this.deps.documents.write(CAMP_DOC_KEY, outcome.camp);
    const evaluation = evaluateCamp(outcome.camp, this.deps.tasks.clock.now(), this.deps.tasks.policy);

    return {
      value: {
        ok: true,
        kind,
        probe: outcome.probe,
        warnings: outcome.warnings,
        phase: evaluation.phase,
        verdict: evaluation.verdict,
        qualityRatio: evaluation.qualityRatio,
        timeRatio: evaluation.timeRatio,
      },
      card: this.deps.views.camp.probeRecorded(outcome.probe, evaluation, outcome.warnings),
    };
  }
}
