import type { Logger } from '../../ports/observability.js';
import { lookupNote, lookupTier, type SupportTier } from './support-matrix.js';
import { satisfies } from './version.js';

/**
 * 版本闸门 · 加载前的第一道判断
 *
 * 原则：默认拒绝，显式放行。
 * 一个"加载成功但行为错乱"的插件，比"加载时明确报错"的插件危险得多 ——
 * 用户会以为闸门在工作，实际上没有。
 */

export type GateVerdict = 'allow' | 'allow-degraded' | 'blocked';

export interface GateResult {
  readonly verdict: GateVerdict;
  readonly tier: SupportTier;
  readonly reason: string;
  readonly hint?: string;
}

export interface GateOptions {
  readonly engineRange: string;
  /** 允许加载未在矩阵中登记的版本（0.3.x 等）。默认 false。 */
  readonly allowUnverified: boolean;
}

export class VersionGate {
  constructor(private readonly options: GateOptions) {}

  check(version: string): GateResult {
    const inRange = satisfies(version, this.options.engineRange);
    const tier = lookupTier(version);
    const note = lookupNote(version);

    if (inRange && tier === 'contract-verified') {
      return { verdict: 'allow', tier, reason: `版本 ${version} 在契约测试矩阵内：${note}` };
    }
    if (inRange && tier === 'declared') {
      return {
        verdict: 'allow-degraded',
        tier,
        reason: `版本 ${version} 在声明范围内但未纳入契约矩阵：${note}`,
        hint: '核心能力可用；表现层是否生效取决于运行时探测结果。',
      };
    }
    if (!inRange && !this.options.allowUnverified) {
      return {
        verdict: 'blocked',
        tier,
        reason: `宿主版本 ${version} 超出 engines.dsh 范围 ${this.options.engineRange}，且未显式放行。`,
        hint: '如确认要在此版本上试运行，请在插件配置中设置 compat.allowUnverified=true。',
      };
    }
    return {
      verdict: 'allow-degraded',
      tier,
      reason: `宿主版本 ${version} 未经验证（${note}），按降级模式加载。`,
      hint: '建议只启用核心功能，并在 docs/COMPATIBILITY.md 的矩阵中补登一条记录。',
    };
  }

  /** 统一处理"拒绝加载"，让错误信息能直接贴进 issue。 */
  assertOrThrow(version: string, logger: Logger): GateResult {
    const result = this.check(version);
    if (result.verdict === 'blocked') {
      logger.error('[xianshou] 版本闸门拒绝加载', { version, reason: result.reason });
      throw new Error(`[xianshou] ${result.reason}${result.hint ? ` ${result.hint}` : ''}`);
    }
    if (result.verdict === 'allow-degraded') {
      logger.warn('[xianshou] 降级加载', { version, reason: result.reason });
    }
    return result;
  }
}
