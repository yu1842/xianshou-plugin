import type { PreToolDecision, ToolExecutionLike } from '../ports/host.js';
import { Capability, type CapabilityContext } from './Capability.js';
import type { TaskRecord } from '../domain/task.js';

/**
 * 先手闸门能力
 *
 * 对应方案的功能 01「先手门槛」，但落点比原文更靠后：原文是在表单上加必填项，
 * 这里是在工具调用的接缝上加策略。两者等价，而后者无法被"换个输入框"绕过。
 *
 * 三种模式必须分清，混用会让两个机制互相抵消：
 *   advisory —— 只记录不拦（对应铁律 02「让跳过可见，而不是禁止跳过」）
 *   ask      —— 走宿主审批（默认；把"自觉"变成"结构"，但用户仍可临时放行）
 *   deny     —— 直接拒绝 + 单调守卫（训练营等强约束场景）
 *
 * 守卫只在 deny 模式安装：ask 模式下装守卫会让审批变成摆设。
 */
export class GateCapability extends Capability {
  readonly id = 'gate';
  readonly requires = ['toolRegister', 'preExecute'] as const;

  protected mount(ctx: CapabilityContext): void {
    const { bridge, config, logger, services } = ctx;
    const gateTools = new Set(config.gate.tools);
    const minutes = services.tasks.policy.draftMinutes;

    bridge.policy?.onPreExecute(async (exec, next) => {
      if (!gateTools.has(exec.name)) return next();

      const pending = await this.#findPending(ctx);
      if (!pending) return next();

      if (config.gate.mode === 'advisory') {
        bridge.session?.emit('xianshou/gate-bypassed', {
          taskId: pending.id,
          tool: exec.name,
          note: '先手稿未落稿，按"可见但不拦"记录',
        });
        logger.info('[xianshou] 闸门放行并记账（advisory）', { task: pending.id, tool: exec.name });
        return next();
      }

      const reason = `红区任务「${pending.title}」还没有先手稿。先花 ${minutes} 分钟写一个丑版本，再用 xianshou_draft 落稿。`;

      if (config.gate.mode === 'deny') {
        bridge.session?.emit('xianshou/gate-denied', { taskId: pending.id, tool: exec.name });
        return { kind: 'deny', reason };
      }

      return {
        kind: 'ask',
        reason,
        displayReason: {
          en: `Xianshou gate: "${pending.title}" is a red-zone task without a draft. Write a 20-minute rough version first.`,
          zh: `先手闸门：红区任务「${pending.title}」还没有初稿。先花 20 分钟写一个丑版本，再让 AI 介入。`,
        },
      };
    });

    if (config.gate.mode === 'deny') this.#installGuard(ctx);
  }

  /**
   * 单调守卫：pre-execute 是可重排的水位线，不是最终安全边界。
   * 只有 guard 能保证"后续监听器无法把拒绝改回允许"。
   */
  #installGuard(ctx: CapabilityContext): void {
    const { bridge, logger, services } = ctx;
    if (!bridge.capabilities.toolGuard || !bridge.guards) {
      logger.warn('[xianshou] deny 模式需要 ctx.tools.guard，宿主不支持；仅保留 pre-execute 拦截');
      return;
    }
    const gateTools = new Set(ctx.config.gate.tools);
    bridge.guards.guard((exec) => {
      if (!gateTools.has(exec.name)) return undefined;
      const pending = services.cache.pendingDraft();
      if (!pending) return undefined;
      return `[xianshou] 红区任务 ${pending.id} 缺先手稿；本次调用被单调守卫拒绝（不可被后续监听器改回允许）。`;
    });
  }

  async #findPending(ctx: CapabilityContext): Promise<TaskRecord | undefined> {
    const { config, services } = ctx;
    // 先看同步缓存（便宜），命中后回仓储取权威对象；缓存未命中且未开启 requireTask 时直接放行。
    const cached = services.cache.pendingDraft();
    if (cached) {
      try {
        return await services.tasks.load(cached.id);
      } catch {
        return undefined;
      }
    }
    if (!config.gate.requireTask) return undefined;
    const all = await services.tasks.list();
    return all.find((t) => t.zone === 'red' && !t.hasDraft && t.status !== 'delivered');
  }
}

/** 便于外部对决策形状做断言。 */
export type GateDecisionShape = PreToolDecision;
export type GateToolExecution = Readonly<ToolExecutionLike>;
