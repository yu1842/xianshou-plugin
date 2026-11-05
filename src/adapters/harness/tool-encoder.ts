import type { ToolDefinitionLike } from '../../ports/host.js';
import { cardFromValue, type XianshouTool } from '../../application/tool-base.js';
import type { CardRenderer } from '../../ui/renderer.js';

/**
 * 工具定义编码器 · 宿主形状的唯一翻译点
 *
 * 所有"宿主长什么样"的知识（ToolDefinition 字段名、output.schema/render 的分工、
 * 哪些字段会泄漏给模型）都集中在 encode() 里。
 *
 * 这里刻意不使用 presentCall / presentResult：
 * 它们的返回结构（ToolCallView / ToolResultView）在 0.2.x 内仍是 pre-stable，
 * 而 output.render 的契约（args + value → ContentBlock[]）更稳定。
 * 少一个炫技的挂点，换一个能跨版本活下来的实现。
 */
export class ToolDefinitionEncoder {
  constructor(
    private readonly renderer: CardRenderer,
    private readonly verbose = false,
  ) {}

  encode(tool: XianshouTool): ToolDefinitionLike {
    const description = this.verbose
      ? `${tool.description}\n\n[debug] timeoutMs=${tool.timeoutMs}; output=ok+card+payload`
      : tool.description;

    return {
      name: tool.name,
      description,
      parameters: tool.parameters,
      output: {
        schema: tool.outputSchema,
        render: (_args: unknown, value: unknown) => this.renderer.render(cardFromValue(value)),
      },
      timeoutMs: tool.timeoutMs,
      isConcurrencySafe: (args: unknown) => tool.isConcurrencySafe(args),
      execute: async (args: unknown, exec: unknown) => {
        const signal = (exec as { signal?: AbortSignal } | undefined)?.signal;
        const result = await tool.invoke(args, signal ? { signal } : {});
        return result.value;
      },
    };
  }
}
