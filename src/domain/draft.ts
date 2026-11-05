import { DomainError, toIso, type Iso8601 } from './model.js';

/**
 * 先手产物（"丑版本"）与其校验规则链
 *
 * 方案原文的唯一硬要求是："别人看了能说出你想干什么"。
 * 这条要求无法自动判定，因此拆成三条可判定的近似规则：
 *   1. 有实质内容（字符数下限）
 *   2. 有时间投入（先手分钟数）
 *   3. 有结构或判断（骨架/伪代码/三条判断任选其一）
 * 规则链可替换：不同岗位（L2/L3）的先手形态不同，见 docs/ARCHITECTURE.md 「已知限制」。
 */

export interface DraftArtifact {
  readonly content: string;
  readonly minutesSpent: number;
  readonly keyJudgements: readonly string[];
  readonly createdAt: Iso8601;
}

export interface DraftInput {
  readonly content: string;
  readonly minutesSpent?: number;
  readonly keyJudgements?: readonly string[];
}

export interface DraftCheck {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  readonly signals: {
    readonly chars: number;
    readonly hasStructure: boolean;
    readonly keyJudgements: number;
  };
}

export interface DraftRule {
  readonly id: string;
  check(input: DraftInput, signals: DraftCheck['signals']): string | undefined;
}

/** 结构信号：标题、编号列表、因果连接词、伪代码关键字、表格。命中即算"有骨架"。 */
const STRUCTURE_PATTERNS: readonly RegExp[] = [
  /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.、)]\s)/m,
  /^\s*#{1,6}\s/m,
  /(因为|所以|因此|从而|据此|前提是|结论是)/,
  /\b(if|for|while|return|function|const|let|def|class)\b/,
  /\|.*\|.*\|/,
];

export function detectStructure(content: string): boolean {
  return STRUCTURE_PATTERNS.some((p) => p.test(content));
}

export class MinCharsRule implements DraftRule {
  readonly id = 'min-chars';
  constructor(private readonly minChars: number) {}
  check(_input: DraftInput, signals: DraftCheck['signals']): string | undefined {
    if (signals.chars >= this.minChars) return undefined;
    // 方案允许的第五种形态是"三条你最关键的判断"。这种形态天然比提纲短，
    // 因此只要条数够、且不是一句废话，就按同一标准放行。
    if (signals.keyJudgements >= 3 && signals.chars >= Math.floor(this.minChars / 2)) return undefined;
    return `丑版本只有 ${signals.chars} 字，不足 ${this.minChars} 字。骨架不必好看，但必须能看出你想干什么。`;
  }
}

export class MinMinutesRule implements DraftRule {
  readonly id = 'min-minutes';
  constructor(private readonly minMinutes: number) {}
  check(input: DraftInput): string | undefined {
    if (input.minutesSpent === undefined) return undefined; // 未申报不惩罚，交由结构规则兜底
    if (input.minutesSpent >= this.minMinutes) return undefined;
    return `只投入了 ${input.minutesSpent} 分钟，低于 ${this.minMinutes} 分钟的阈值。若 20 分钟产不出任何东西，说明该先补背景，而不是让 AI 替你完成理解。`;
  }
}

export class StructureOrJudgementRule implements DraftRule {
  readonly id = 'structure-or-judgement';
  check(_input: DraftInput, signals: DraftCheck['signals']): string | undefined {
    if (signals.hasStructure || signals.keyJudgements >= 3) return undefined;
    return '既没有结构（提纲/列表/伪代码/表格），也没有三条以上明确判断。随便写两行不算先手。';
  }
}

export class DraftValidator {
  readonly #rules: readonly DraftRule[];

  constructor(rules: readonly DraftRule[]) {
    this.#rules = rules;
  }

  /** 默认规则集：字符数 80 + 结构或三条判断。分钟数规则默认启用但允许不申报。 */
  static withDefaults(minChars: number, minMinutes: number): DraftValidator {
    return new DraftValidator([
      new MinCharsRule(minChars),
      new MinMinutesRule(minMinutes),
      new StructureOrJudgementRule(),
    ]);
  }

  inspect(input: DraftInput): DraftCheck {
    const content = input.content ?? '';
    const signals = {
      chars: [...content.trim()].length,
      hasStructure: detectStructure(content),
      keyJudgements: (input.keyJudgements ?? []).filter((k) => k.trim().length > 0).length,
    };
    const reasons: string[] = [];
    for (const rule of this.#rules) {
      const reason = rule.check(input, signals);
      if (reason) reasons.push(reason);
    }
    return { ok: reasons.length === 0, reasons, signals };
  }

  /** 校验失败直接抛领域错误，让工具层把原因原样带给模型/用户。 */
  accept(input: DraftInput, now: Date): DraftArtifact {
    const check = this.inspect(input);
    if (!check.ok) {
      throw new DomainError('DRAFT_TOO_THIN', check.reasons.join(' '), '补一个能被看懂的骨架，或明确写出三条最关键的判断。');
    }
    return {
      content: input.content.trim(),
      minutesSpent: input.minutesSpent ?? 0,
      keyJudgements: [...(input.keyJudgements ?? [])],
      createdAt: toIso(now),
    };
  }
}
