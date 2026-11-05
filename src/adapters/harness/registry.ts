import type { Logger } from '../../ports/observability.js';
import { AdapterV0201, AdapterV0300, type HarnessAdapter } from './adapter.js';
import { CapabilityProbe } from './probe.js';
import { releaseLine } from './version.js';

/**
 * 适配器注册表
 *
 * 选择策略是"按产品线精确匹配"，匹配不到时退回声明范围最宽的适配器。
 * 注意这里不做版本比较的字符串前缀匹配 —— 那会被 "0.2.10" 与 "0.2.1" 的
 * 前缀关系骗到，是版本判断里最常见的 bug。
 */
export class AdapterRegistry {
  readonly #adapters: readonly HarnessAdapter[];

  constructor(adapters?: readonly HarnessAdapter[]) {
    const probe = new CapabilityProbe();
    this.#adapters = adapters ?? [new AdapterV0300(probe), new AdapterV0201(probe)];
  }

  list(): readonly HarnessAdapter[] {
    return this.#adapters;
  }

  select(version: string, logger?: Logger): HarnessAdapter {
    const line = releaseLine(version);
    for (const adapter of this.#adapters) {
      if (adapter.productLine === line && adapter.supports(version)) return adapter;
    }
    for (const adapter of this.#adapters) {
      if (adapter.supports(version)) {
        logger?.warn('[xianshou] 没有产品线精确匹配的适配器，退回首个范围匹配的适配器', {
          version,
          adapter: adapter.id,
        });
        return adapter;
      }
    }
    // 兜底用最老的适配器：它的探测最保守，能在未知版本上尽量降级而不是崩。
    const fallback = this.#adapters[this.#adapters.length - 1];
    if (!fallback) throw new Error('[xianshou] 适配器注册表为空');
    logger?.warn('[xianshou] 版本无适配器匹配，使用最保守的 0.2.x 适配器', { version });
    return fallback;
  }
}
