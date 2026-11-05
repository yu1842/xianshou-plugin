/**
 * 领域策略 · 阈值集中地
 *
 * 方案原文明确写着："文中所有阈值（20 分钟、30%/60%、15%–40%）为工程取值，
 * 需在真实场景中校准。" 因此阈值不是散落在各处魔法数字，而是可注入的策略对象。
 * 应用层依赖 ThresholdPolicy 接口，不依赖默认实现（依赖倒置）。
 */

export interface ThresholdPolicy {
  /** 先手时长下限（分钟）。默认 20 —— 方案原文的工程取值。 */
  readonly draftMinutes: number;
  /** 丑版本最小字符数（防敷衍）。 */
  readonly draftMinChars: number;
  /** [AI] 占比进入"需回收测试"的下限。 */
  readonly aiRatioRecall: number;
  /** [AI] 占比触发"打回重做"的下限。 */
  readonly aiRatioRework: number;
  /** 首版自主率目标。 */
  readonly selfRatioTarget: number;
  /** 回收测试及格线。 */
  readonly recallPassScore: number;
  /** 回收窗口（小时）。默认 [24, 168]。 */
  readonly recallWindowsHours: readonly number[];
  /** 回收窗口宽限期（小时），超过则标记为逾期未答。 */
  readonly recallGraceHours: number;
  /** 拒绝率健康区间下界。 */
  readonly refusalHealthyMin: number;
  /** 拒绝率健康区间上界。 */
  readonly refusalHealthyMax: number;
  /** 拒绝率低于此值 → "你可能在盲从"。 */
  readonly refusalBlindBelow: number;
  /** 拒绝率高于此值 → 为反对而反对。 */
  readonly refusalContrarianAbove: number;
  /** 健康度报告的最少样本量，低于此值不判定。 */
  readonly minSamples: number;
}

export type PolicyOverrides = Partial<Omit<ThresholdPolicy, 'recallWindowsHours'>> & {
  readonly recallWindowsHours?: readonly number[];
};

const DEFAULTS: ThresholdPolicy = {
  draftMinutes: 20,
  draftMinChars: 80,
  aiRatioRecall: 0.3,
  aiRatioRework: 0.6,
  selfRatioTarget: 0.5,
  recallPassScore: 0.8,
  recallWindowsHours: [24, 168],
  recallGraceHours: 48,
  refusalHealthyMin: 0.15,
  refusalHealthyMax: 0.4,
  refusalBlindBelow: 0.1,
  refusalContrarianAbove: 0.6,
  minSamples: 5,
};

/** 阈值组合非法时立刻失败，避免"静默跑着一套自相矛盾的规则"。 */
export class PolicyValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`阈值配置非法：${issues.join('；')}`);
    this.name = 'PolicyValidationError';
  }
}

export class DefaultThresholdPolicy implements ThresholdPolicy {
  readonly draftMinutes: number;
  readonly draftMinChars: number;
  readonly aiRatioRecall: number;
  readonly aiRatioRework: number;
  readonly selfRatioTarget: number;
  readonly recallPassScore: number;
  readonly recallWindowsHours: readonly number[];
  readonly recallGraceHours: number;
  readonly refusalHealthyMin: number;
  readonly refusalHealthyMax: number;
  readonly refusalBlindBelow: number;
  readonly refusalContrarianAbove: number;
  readonly minSamples: number;

  constructor(overrides: PolicyOverrides = {}) {
    const merged = { ...DEFAULTS, ...overrides };
    this.draftMinutes = merged.draftMinutes;
    this.draftMinChars = merged.draftMinChars;
    this.aiRatioRecall = merged.aiRatioRecall;
    this.aiRatioRework = merged.aiRatioRework;
    this.selfRatioTarget = merged.selfRatioTarget;
    this.recallPassScore = merged.recallPassScore;
    this.recallWindowsHours = Object.freeze([...merged.recallWindowsHours]);
    this.recallGraceHours = merged.recallGraceHours;
    this.refusalHealthyMin = merged.refusalHealthyMin;
    this.refusalHealthyMax = merged.refusalHealthyMax;
    this.refusalBlindBelow = merged.refusalBlindBelow;
    this.refusalContrarianAbove = merged.refusalContrarianAbove;
    this.minSamples = merged.minSamples;
    this.#assertCoherent();
  }

  /** 只校验"会让方案自相矛盾"的组合，不校验业务偏好。 */
  #assertCoherent(): void {
    const issues: string[] = [];
    if (this.aiRatioRecall >= this.aiRatioRework) {
      issues.push('aiRatioRecall 必须小于 aiRatioRework，否则"需回收"与"需重做"区间重叠');
    }
    if (this.refusalHealthyMin >= this.refusalHealthyMax) {
      issues.push('refusalHealthyMin 必须小于 refusalHealthyMax');
    }
    if (this.refusalBlindBelow >= this.refusalHealthyMin) {
      issues.push('refusalBlindBelow 必须小于 refusalHealthyMin');
    }
    if (this.recallWindowsHours.length === 0) {
      issues.push('recallWindowsHours 不能为空');
    }
    if (this.recallWindowsHours.some((h) => !Number.isFinite(h) || h <= 0)) {
      issues.push('recallWindowsHours 必须为正数小时');
    }
    if (this.recallPassScore <= 0 || this.recallPassScore > 1) {
      issues.push('recallPassScore 必须位于 (0, 1]');
    }
    if (issues.length > 0) throw new PolicyValidationError(issues);
  }
}
