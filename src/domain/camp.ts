import { DomainError, round, toIso, type Iso8601 } from './model.js';
import type { ThresholdPolicy } from './policy.js';

/**
 * 训练营领域 · 四周模式
 *
 * 这个模块存在的理由只有一个：**让"我感觉进步了"变得可证伪**。
 * 方案原文的判断是——第一周和第四周必须做两次裸考，第一次建基线，第二次做脱离测试；
 * 否则前三周很可能只是在"表演学习"。
 *
 * 因此这里的校验比其它模块都硬：
 *  - 裸考必须声明"没用 AI"，且不可覆盖已记录的基线
 *  - 脱离测试必须等到 W4，且必须先有基线
 *  - 验收不给感觉分，只给两个比值
 */

export type CampPhase =
  | 'awaiting-baseline'
  | 'drill'
  | 'recall'
  | 'awaiting-exit'
  | 'graduated';

export type CampVerdict = 'pending' | 'pass' | 'partial' | 'fail';

export interface ProbeRecord {
  readonly kind: 'baseline' | 'exit';
  readonly title: string;
  /** 实际耗时（分钟）。 */
  readonly minutes: number;
  /** 质量评分 0–100，按同一把尺子打两次。 */
  readonly quality: number;
  readonly at: Iso8601;
  readonly note?: string;
}

export interface CampRecord {
  readonly id: string;
  readonly label: string;
  readonly startedAt: Iso8601;
  readonly weeks: number;
  readonly baseline: ProbeRecord | null;
  readonly exit: ProbeRecord | null;
  readonly closedAt: Iso8601 | null;
}

export const CAMP_DOC_KEY = 'xianshou.camp.default';

export function createCamp(input: { id: string; label: string; now: Date; weeks?: number }): CampRecord {
  const weeks = input.weeks ?? 4;
  if (!Number.isInteger(weeks) || weeks < 2 || weeks > 12) {
    throw new DomainError('INVALID_ARGUMENT', `weeks 必须是 2–12 的整数，收到 ${weeks}。`);
  }
  return {
    id: input.id,
    label: input.label,
    startedAt: toIso(input.now),
    weeks,
    baseline: null,
    exit: null,
    closedAt: null,
  };
}

export interface ProbeInput {
  readonly kind: 'baseline' | 'exit';
  readonly title: string;
  readonly minutes: number;
  readonly quality: number;
  readonly aiUsed: boolean;
  readonly at: Date;
  readonly note?: string;
  /** 跳过"必须等到 W4"的限制。用于补录历史数据，会在返回值里标注。 */
  readonly force?: boolean;
}

export interface ProbeOutcome {
  readonly camp: CampRecord;
  readonly probe: ProbeRecord;
  readonly warnings: readonly string[];
}

/**
 * 记录一次裸考。
 *
 * 这里拒绝的三件事，都是为了让验收还能算数：
 *  1. 用了 AI 的"裸考"（那不是基线，是另一个 AI 产出）
 *  2. 第二次基线（基线可以重来，就没有"脱离测试"了）
 *  3. W4 之前做脱离测试（那样比的是学习中的自己，不是学完的自己）
 */
export function recordProbe(camp: CampRecord, input: ProbeInput, policy: ThresholdPolicy): ProbeOutcome {
  const warnings: string[] = [];

  if (input.aiUsed) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      '裸考不能使用 AI —— 用了 AI 的产出是"AI 的基线"，不是你的。',
      '关掉 AI、换一个同难度的小任务重做一次。这一条没有例外，否则整份验收失去意义。',
    );
  }
  if (!Number.isFinite(input.minutes) || input.minutes <= 0 || input.minutes > 60 * 24 * 14) {
    throw new DomainError('INVALID_ARGUMENT', `耗时必须是 0 到 20160 分钟之间的正数，收到 ${input.minutes}。`);
  }
  if (!Number.isFinite(input.quality) || input.quality < 0 || input.quality > 100) {
    throw new DomainError('INVALID_ARGUMENT', `质量评分必须是 0–100，收到 ${input.quality}。`, '同一把尺子打两次才有可比性。');
  }

  const dayIndex = dayOf(camp, input.at);

  if (input.kind === 'baseline') {
    if (camp.baseline !== null) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        '基线已经记录过，不能覆盖。',
        '基线的价值来自"它是第一次"。要重新开营请用 xianshou_camp action=start 新建一轮。',
      );
    }
    const probe: ProbeRecord = {
      kind: 'baseline',
      title: input.title,
      minutes: Math.round(input.minutes),
      quality: Math.round(input.quality),
      at: toIso(input.at),
      ...(input.note ? { note: input.note } : {}),
    };
    return { camp: { ...camp, baseline: probe }, probe, warnings };
  }

  if (camp.baseline === null) {
    throw new DomainError('INVALID_ARGUMENT', '没有基线就没有对照 —— 先做 W1 裸考。', '先 xianshou_probe kind=baseline。');
  }
  if (camp.exit !== null) {
    throw new DomainError('INVALID_ARGUMENT', '脱离测试已经记录过，不能重复。');
  }
  const minDays = policy.campMinDays;
  if (dayIndex < minDays && input.force !== true) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `现在才第 ${dayIndex} 天，脱离测试要等到第 ${minDays} 天（W4）。`,
      '提前测的是"学习中的你"，不是"学完的你"，两次数据不可比。确有补录需求时传 force=true，结果会标注。',
    );
  }
  if (dayIndex < minDays) {
    warnings.push(`提前于第 ${minDays} 天记录了脱离测试（force=true），这次结果不可与他人横向比较。`);
  }

  const probe: ProbeRecord = {
    kind: 'exit',
    title: input.title,
    minutes: Math.round(input.minutes),
    quality: Math.round(input.quality),
    at: toIso(input.at),
    ...(input.note ? { note: input.note } : {}),
  };
  return { camp: { ...camp, exit: probe, closedAt: toIso(input.at) }, probe, warnings };
}

export interface CampEvaluation {
  readonly phase: CampPhase;
  readonly dayIndex: number;
  readonly verdict: CampVerdict;
  readonly qualityRatio: number | null;
  readonly timeRatio: number | null;
  readonly readyForExit: boolean;
  readonly headline: string;
  readonly detail: string;
  readonly nextStep: string;
}

export function dayOf(camp: CampRecord, now: Date): number {
  const start = new Date(camp.startedAt).getTime();
  const diff = now.getTime() - start;
  return Math.floor(diff / 86_400_000) + 1;
}

export function evaluateCamp(camp: CampRecord, now: Date, policy: ThresholdPolicy): CampEvaluation {
  const dayIndex = Math.max(1, dayOf(camp, now));
  const minDays = policy.campMinDays;

  if (camp.exit !== null && camp.baseline !== null) {
    return verdictOf(camp, dayIndex, policy);
  }

  if (camp.baseline === null) {
    return {
      phase: 'awaiting-baseline',
      dayIndex,
      verdict: 'pending',
      qualityRatio: null,
      timeRatio: null,
      readyForExit: false,
      headline: `第 ${dayIndex} 天 · 还没有基线`,
      detail: '这一周不教任何工具，只做一件事：不用 AI 独立完成一个真实的小任务，记下耗时与质量。',
      nextStep: '用 xianshou_probe kind=baseline 记录。没有基线的人，之后所有"我感觉进步了"都不可信。',
    };
  }

  if (dayIndex < 8) {
    return {
      phase: 'drill',
      dayIndex,
      verdict: 'pending',
      qualityRatio: null,
      timeRatio: null,
      readyForExit: false,
      headline: `第 ${dayIndex} 天 · 先手训练`,
      detail: '每天一个红区任务，严格 20 分钟先手。评价重点不是产出好坏，而是"那 20 分钟是不是越来越不难"。',
      nextStep: '正常用 xianshou_start → xianshou_draft 记录，不用额外操作。',
    };
  }

  if (dayIndex < 15) {
    return {
      phase: 'recall',
      dayIndex,
      verdict: 'pending',
      qualityRatio: null,
      timeRatio: null,
      readyForExit: false,
      headline: `第 ${dayIndex} 天 · 回收训练`,
      detail: '强制 24 小时与 7 天双回收；每天抽一个上周的交付物做复述测试，记录通过率。',
      nextStep: '用 xianshou_recall 提交。这周大概率会第一次发现：那些"效率很高"的产出，自己一点都想不起来。',
    };
  }

  return {
    phase: 'awaiting-exit',
    dayIndex,
    verdict: 'pending',
    qualityRatio: null,
    timeRatio: null,
    readyForExit: dayIndex >= minDays,
    headline: `第 ${dayIndex} 天 · 该做脱离测试了`,
    detail: `撤掉 AI，做一个与 W1 同难度的任务。基线：${camp.baseline.minutes} 分钟 / ${camp.baseline.quality} 分。`,
    nextStep:
      dayIndex >= minDays
        ? '用 xianshou_probe kind=exit 记录。验收标准：质量不低于基线的 90%，耗时增幅不超过 20%。'
        : `还差 ${minDays - dayIndex} 天到第 ${minDays} 天；现在测的是"学习中的你"。`,
  };
}

function verdictOf(camp: CampRecord, dayIndex: number, policy: ThresholdPolicy): CampEvaluation {
  const baseline = camp.baseline;
  const exit = camp.exit;
  /* c8 ignore next */
  if (!baseline || !exit) throw new Error('verdictOf 需要两次裸考');

  const qualityRatio = baseline.quality === 0 ? null : round(exit.quality / baseline.quality);
  const timeRatio = baseline.minutes === 0 ? null : round(exit.minutes / baseline.minutes);
  const qualityOk = qualityRatio !== null && qualityRatio >= policy.campQualityFloor;
  const timeOk = timeRatio !== null && timeRatio <= 1 + policy.campTimeBudget;

  let verdict: CampVerdict;
  if (qualityOk && timeOk) verdict = 'pass';
  else if (qualityOk || timeOk) verdict = 'partial';
  else verdict = 'fail';

  const qualityText = qualityRatio === null ? '—' : `${Math.round(qualityRatio * 100)}%`;
  const timeText = timeRatio === null ? '—' : `${timeRatio >= 1 ? '+' : ''}${Math.round((timeRatio - 1) * 100)}%`;

  if (verdict === 'pass') {
    return {
      phase: 'graduated',
      dayIndex,
      verdict,
      qualityRatio,
      timeRatio,
      readyForExit: true,
      headline: '脱离测试通过',
      detail: `质量 ${qualityText}（要求 ≥ ${Math.round(policy.campQualityFloor * 100)}%），耗时 ${timeText}（要求 ≤ +${Math.round(policy.campTimeBudget * 100)}%）。`,
      nextStep: '这是唯一能证明"这四周没白过"的证据。可以开下一轮，或把基线换成这次的结果。',
    };
  }
  if (verdict === 'partial') {
    return {
      phase: 'graduated',
      dayIndex,
      verdict,
      qualityRatio,
      timeRatio,
      readyForExit: true,
      headline: qualityOk ? '质量达标，但变慢了' : '速度回来了，但质量掉了',
      detail: `质量 ${qualityText}（要求 ≥ ${Math.round(policy.campQualityFloor * 100)}%），耗时 ${timeText}（要求 ≤ +${Math.round(policy.campTimeBudget * 100)}%）。`,
      nextStep: qualityOk
        ? '慢下来不一定是退步 —— 可能是你开始检查以前不会检查的地方。再跑一次同难度任务，看是不是稳定现象。'
        : '速度回来了但质量掉了，这通常意味着前三周的"先手"变成了形式。回 W2 重做两周再测。',
    };
  }
  return {
    phase: 'graduated',
    dayIndex,
    verdict,
    qualityRatio,
    timeRatio,
    readyForExit: true,
    headline: '脱离测试未通过',
    detail: `质量 ${qualityText}（要求 ≥ ${Math.round(policy.campQualityFloor * 100)}%），耗时 ${timeText}（要求 ≤ +${Math.round(policy.campTimeBudget * 100)}%）。`,
    nextStep: '这比给一个漂亮分数有用得多：说明前三周只是在表演学习。别急着重开，先看 W3 的回收通过率——那是最早的预警信号。',
  };
}

export function isCamp(value: unknown): value is CampRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['id'] === 'string' && typeof record['startedAt'] === 'string';
}
