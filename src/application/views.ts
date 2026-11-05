import type { ThresholdPolicy } from '../domain/policy.js';
import { LedgerCard } from '../ui/views/ledger-view.js';
import { HealthCard } from '../ui/views/health-view.js';
import { RecallCard } from '../ui/views/recall-view.js';
import { RefusalCard } from '../ui/views/refusal-view.js';
import { GateCard, TaskCard, ZoneCard } from '../ui/views/task-view.js';

/**
 * 视图容器
 *
 * 工具不 new 视图，而是从容器里取 —— 这样换主题、换渲染目标、
 * 或在测试里替换成 PlainCardRenderer 的同款视图，都不需要改工具代码。
 */
export interface ToolViews {
  readonly zone: ZoneCard;
  readonly gate: GateCard;
  readonly task: TaskCard;
  readonly ledger: LedgerCard;
  readonly recall: RecallCard;
  readonly refusal: RefusalCard;
  readonly health: HealthCard;
}

export function createViews(policy: ThresholdPolicy): ToolViews {
  return {
    zone: new ZoneCard(policy),
    gate: new GateCard(policy),
    task: new TaskCard(policy),
    ledger: new LedgerCard(),
    recall: new RecallCard(),
    refusal: new RefusalCard(),
    health: new HealthCard(),
  };
}
