import type { Zone } from './model.js';

/**
 * 三区分级 · 策略链
 *
 * 方案原文的判据只有一条主线：「这件任务你未来还要重复做吗？」
 * 但落地时必须回答三个二值问题。这里用「规则链 + 策略多态」表达：
 * 新增一条判据 = 新增一个 ZoneRule 实现，不改动分类器（开闭原则）。
 */

export interface ZoneSignals {
  /** 未来是否还要重复做同类任务。 */
  readonly repeatable: boolean;
  /** 是否落在自己的能力圈内（能独立完成）。 */
  readonly withinCompetence: boolean;
  /** 是否与能力成长有关。执行类杂务为 false。 */
  readonly growthRelevant: boolean;
}

export interface ZoneDecision {
  readonly zone: Zone;
  /** 命中的规则 ID，用于向用户解释"为什么判成这个区"。 */
  readonly ruleId: string;
  readonly rationale: string;
}

export interface ZoneRule {
  readonly id: string;
  readonly priority: number;
  /** 命中返回分区，未命中返回 undefined，交由下一条规则。 */
  decide(signals: ZoneSignals): ZoneDecision | undefined;
}

export class RedZoneRule implements ZoneRule {
  readonly id = 'repeatable-in-competence';
  readonly priority = 10;

  decide(s: ZoneSignals): ZoneDecision | undefined {
    if (!s.repeatable || !s.withinCompetence) return undefined;
    return {
      zone: 'red',
      ruleId: this.id,
      rationale: '重复做、且落在你的能力圈内 —— 构成核心能力资产，AI 只能在你的初稿上做校验与补充。',
    };
  }
}

export class YellowZoneOutOfCompetenceRule implements ZoneRule {
  readonly id = 'repeatable-out-of-competence';
  readonly priority = 20;

  decide(s: ZoneSignals): ZoneDecision | undefined {
    if (!s.repeatable || s.withinCompetence) return undefined;
    return {
      zone: 'yellow',
      ruleId: this.id,
      rationale: '虽要重复做，但当前在能力圈之外 —— 可先问，交付前必须能复述要点。',
    };
  }
}

export class YellowZoneGrowthRule implements ZoneRule {
  readonly id = 'one-off-growth-relevant';
  readonly priority = 30;

  decide(s: ZoneSignals): ZoneDecision | undefined {
    if (s.repeatable || !s.growthRelevant) return undefined;
    return {
      zone: 'yellow',
      ruleId: this.id,
      rationale: '一次性但与成长相关 —— 不强制先手，但要求能复述，避免留下知识掌握假象。',
    };
  }
}

export class GreenZoneRule implements ZoneRule {
  readonly id = 'not-growth-relevant';
  readonly priority = 40;

  decide(s: ZoneSignals): ZoneDecision | undefined {
    if (s.growthRelevant) return undefined;
    return {
      zone: 'green',
      ruleId: this.id,
      rationale: '与能力成长无关的杂务 —— 放开用，用多少都不产生认知债。',
    };
  }
}

/** 兜底规则：信号不完整时取保守值，宁可多要求一次复述，也不放过一次跳过。 */
export class FallbackZoneRule implements ZoneRule {
  readonly id = 'fallback-conservative';
  readonly priority = 1000;

  decide(): ZoneDecision {
    return {
      zone: 'yellow',
      ruleId: this.id,
      rationale: '信号不完整，按黄区处理：允许先问，但交付前需能复述。',
    };
  }
}

export class ZoneClassifier {
  readonly #rules: readonly ZoneRule[];

  constructor(rules?: readonly ZoneRule[]) {
    const list = rules ?? [
      new RedZoneRule(),
      new YellowZoneOutOfCompetenceRule(),
      new YellowZoneGrowthRule(),
      new GreenZoneRule(),
      new FallbackZoneRule(),
    ];
    this.#rules = [...list].sort((a, b) => a.priority - b.priority);
  }

  classify(signals: ZoneSignals): ZoneDecision {
    for (const rule of this.#rules) {
      const decided = rule.decide(signals);
      if (decided) return decided;
    }
    /* c8 ignore next */
    return new FallbackZoneRule().decide();
  }
}
