import type { HostBridge, HostCapabilities } from '../ports/host.js';
import type { Logger, Notifier } from '../ports/observability.js';
import type { XianshouConfig } from '../config.js';
import type { TaskService } from '../application/TaskService.js';
import type { TaskCache } from '../application/TaskCache.js';
import type { ToolViews } from '../application/views.js';
import type { LedgerPolicy } from '../domain/ledger.js';
import type { ArtifactStore, Hasher } from '../ports/artifacts.js';

/**
 * 能力（Capability）
 *
 * 插件不是一个大 apply()，而是若干个独立安装的能力单元。
 * 每个能力声明自己依赖哪些宿主接缝；缺依赖时只降级自己，不牵连其他能力。
 * 这就是"接口隔离 + 单一职责"在插件层面的落法。
 */

export type CapabilityStatus = 'applied' | 'degraded' | 'skipped';

export interface CapabilityReport {
  readonly id: string;
  readonly status: CapabilityStatus;
  readonly requires: readonly string[];
  readonly reason?: string;
}

export interface CapabilityServices {
  readonly tasks: TaskService;
  readonly cache: TaskCache;
  readonly views: ToolViews;
  readonly ledgerPolicy: LedgerPolicy;
  readonly notifier: Notifier;
  readonly artifacts: ArtifactStore;
  readonly hasher: Hasher;
  readonly pluginVersion: string;
}

export interface CapabilityContext {
  readonly bridge: HostBridge;
  readonly config: XianshouConfig;
  readonly logger: Logger;
  readonly services: CapabilityServices;
}

export abstract class Capability {
  abstract readonly id: string;
  /** 依赖的宿主能力；任一缺失即降级。 */
  abstract readonly requires: readonly (keyof HostCapabilities)[];

  #status: CapabilityStatus = 'skipped';
  #reason: string | undefined;

  /** 子类实现安装逻辑；抛错由 install() 统一转成 degraded，不影响其他能力。 */
  protected abstract mount(ctx: CapabilityContext): void;

  install(ctx: CapabilityContext): CapabilityReport {
    const missing = this.requires.filter((key) => ctx.bridge.capabilities[key] !== true);
    if (missing.length > 0) {
      this.#status = 'skipped';
      this.#reason = `宿主缺少接缝：${missing.join(', ')}`;
      ctx.logger.warn(`[xianshou] 能力 ${this.id} 已跳过`, { missing });
      return this.report();
    }
    try {
      this.mount(ctx);
      this.#status = 'applied';
      this.#reason = undefined;
    } catch (error) {
      this.#status = 'degraded';
      this.#reason = error instanceof Error ? error.message : String(error);
      ctx.logger.error(`[xianshou] 能力 ${this.id} 安装失败，已降级`, { error: this.#reason });
    }
    return this.report();
  }

  report(): CapabilityReport {
    return {
      id: this.id,
      status: this.#status,
      requires: [...this.requires],
      ...(this.#reason === undefined ? {} : { reason: this.#reason }),
    };
  }
}
