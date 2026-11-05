import { Capability, type CapabilityContext } from './Capability.js';
import { windowLabel } from '../domain/recall.js';
import { formatIso } from '../ui/format.js';

/**
 * 到期提醒能力
 *
 * 关键取舍（也是方案里最容易做错的一处）：
 * 定时器不能当作持久化调度。进程一重启 interval 就没了，所以：
 *   - 权威到期时间写在任务的 gates[].scheduledFor 里（随任务落盘）
 *   - 每次挂载时先做一次补扫，把"重启期间到期"的任务补推
 *   - interval 只是同一次会话内的加速器，且必须经 ctx.effect 注册释放
 *
 * 这样"提醒丢了"的最坏后果从"永久丢失"降级为"下次启动补上"。
 */
export class ReminderCapability extends Capability {
  readonly id = 'reminder';
  readonly requires = [] as const;

  #pushed = new Set<string>();

  protected mount(ctx: CapabilityContext): void {
    if (!ctx.config.recall.autoRemind) {
      ctx.logger.info('[xianshou] 到期提醒已按配置关闭');
      return;
    }

    // 启动补扫：异步执行，不阻塞插件挂载。
    void this.#sweep(ctx);

    const minutes = ctx.config.recall.sweepMinutes;
    if (minutes <= 0) return;
    if (!ctx.bridge.lifecycle) {
      ctx.logger.info('[xianshou] 宿主无 ctx.effect，跳过会话内定时扫描（不影响启动补扫）');
      return;
    }
    ctx.bridge.lifecycle.effect(() => {
      const timer = setInterval(
        () => {
          void this.#sweep(ctx);
        },
        Math.max(1, minutes) * 60_000,
      );
      // Node 环境下不阻止进程退出；浏览器/无 unref 环境忽略。
      (timer as unknown as { unref?: () => void }).unref?.();
      return () => clearInterval(timer);
    });
  }

  async #sweep(ctx: CapabilityContext): Promise<void> {
    try {
      const due = await ctx.services.tasks.dueRecalls();
      for (const item of due) {
        for (const gate of item.gates) {
          const key = `${item.task.id}:${gate.window}`;
          if (this.#pushed.has(key)) continue;
          this.#pushed.add(key);
          await ctx.services.notifier.notify({
            id: key,
            tone: item.overdue ? 'critical' : 'attention',
            title: `${windowLabel(gate.window)}到期：${item.task.title}`,
            body: item.overdue
              ? `已逾期。合上材料，用 3 分钟回答三个问题：核心逻辑是什么？最不确定哪一点？被反问靠什么答？答不出来就是没学会。`
              : `应于 ${formatIso(gate.scheduledFor)} 完成一次 3 分钟复述。问题必须具体：核心逻辑 / 不确定点 / 抗反问。`,
            taskId: item.task.id,
            createdAt: new Date().toISOString(),
          });
        }
      }
      if (due.length > 0) ctx.logger.info('[xianshou] 已补推到期回收', { count: due.length });
    } catch (error) {
      // 提醒失败不能影响插件其他能力。
      ctx.logger.warn('[xianshou] 到期扫描失败', { error: String(error) });
    }
  }
}
