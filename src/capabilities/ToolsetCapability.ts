import { Capability, type CapabilityContext } from './Capability.js';
import { ToolDefinitionEncoder } from '../adapters/harness/tool-encoder.js';
import { MarkdownCardRenderer } from '../ui/renderer.js';
import { ThemeResolver } from '../ui/theme.js';
import { AuditLedgerTool, DeliverTool, MarkSegmentTool } from '../application/tools/ledger-tools.js';
import { HealthTool, RecallTool, RefusalTool } from '../application/tools/review-tools.js';
import { StartTaskTool, SubmitDraftTool, TaskStatusTool } from '../application/tools/task-tools.js';
import type { XianshouTool } from '../application/tool-base.js';

/**
 * 工具集能力
 *
 * 九个工具按方案的动作清单一一对应（建档 / 落稿 / 标来源 / 比例 / 交付 / 回收 / 拒绝率 / 健康度 / 状态）。
 * 每个工具只依赖应用服务与视图，不直接接触宿主 —— 宿主形状的翻译集中在 ToolDefinitionEncoder，
 * 这样宿主换一版工具定义时只改一个文件。
 */
export class ToolsetCapability extends Capability {
  readonly id = 'toolset';
  readonly requires = ['toolRegister'] as const;

  protected mount(ctx: CapabilityContext): void {
    const { bridge, config } = ctx;
    if (!bridge.tools) throw new Error('toolRegister 能力声称可用但 tools 接缝缺失');

    const theme = new ThemeResolver(config.ui.theme).resolve();
    const encoder = new ToolDefinitionEncoder(new MarkdownCardRenderer(theme), config.ui.verbose);

    const tools = this.#tools(ctx);
    for (const tool of tools) bridge.tools.register(encoder.encode(tool));
    ctx.logger.info(`[xianshou] 已注册 ${tools.length} 个工具`, { tools: tools.map((t) => t.name) });
  }

  /** 工具清单集中在一处，便于快照测试直接断言"工具集没有意外增减"。 */
  #tools(ctx: CapabilityContext): readonly XianshouTool[] {
    const { services } = ctx;
    return [
      new StartTaskTool(services.tasks, services.views),
      new TaskStatusTool(services.tasks, services.views),
      new SubmitDraftTool(services.tasks, services.views),
      new MarkSegmentTool(services.tasks, services.views, services.ledgerPolicy),
      new AuditLedgerTool(services.tasks, services.views, services.ledgerPolicy),
      new DeliverTool(services.tasks, services.ledgerPolicy),
      new RecallTool(services.tasks, services.views),
      new RefusalTool(services.tasks, services.views),
      new HealthTool(services.tasks, services.views),
    ];
  }
}
