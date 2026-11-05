import { join } from 'node:path';
import type { HostBridge } from './ports/host.js';
import { ConfigParser, type XianshouConfig } from './config.js';
import { DefaultThresholdPolicy, PolicyValidationError } from './domain/policy.js';
import { LedgerPolicy } from './domain/ledger.js';
import { TaskService, CompositeEventSink, type DomainEvent } from './application/TaskService.js';
import { TaskCache } from './application/TaskCache.js';
import { createViews } from './application/views.js';
import { RandomIdGenerator, SystemClock, type Clock, type IdGenerator } from './ports/time.js';
import type { Logger, Notifier } from './ports/observability.js';
import { ConsoleLogger } from './adapters/observability/console-logger.js';
import { AdapterRegistry } from './adapters/harness/registry.js';
import { VersionGate } from './adapters/harness/version-gate.js';
import { SessionNotifier } from './adapters/notify/session-notifier.js';
import { SessionStateRepository } from './adapters/storage/session-state.js';
import { JsonFileRepository } from './adapters/storage/file.js';
import { MemoryTaskRepository, MigratingRepository, DEFAULT_MIGRATIONS } from './adapters/storage/memory.js';
import { ResilientRepository } from './adapters/storage/resilient.js';
import { FsArtifactStore } from './adapters/storage/artifacts.js';
import { NodeHasher } from './adapters/hash/sha256.js';
import { FileDocumentStore, SessionDocumentStore } from './adapters/storage/documents.js';
import type { DocumentStore } from './ports/documents.js';
import type { ArtifactStore, Hasher } from './ports/artifacts.js';
import { PLUGIN_VERSION } from './version.js';
import { GuideService } from './application/GuideService.js';
import type { TaskRepository } from './ports/repository.js';
import { GateCapability } from './capabilities/GateCapability.js';
import { ToolsetCapability } from './capabilities/ToolsetCapability.js';
import { ReminderCapability } from './capabilities/ReminderCapability.js';
import type { Capability, CapabilityReport } from './capabilities/Capability.js';
import { methodOf, propOf, safeGet } from './adapters/harness/probe.js';

/**
 * 组合根（Composition Root）
 *
 * 全插件只有这里 new 具体实现。上面所有层都只认接口，因此：
 *   - 测试可以把仓储换成内存、时钟换成手动、宿主换成模拟对象
 *   - 加一条新产品线只改 AdapterRegistry
 *   - 加一个能力只改 CAPABILITIES 列表
 *
 * 这也是"依赖倒置"唯一被允许破例的地方 —— 总得有人知道具体类型。
 */

export const name = 'xianshou';

/** 依赖声明：没有 tools 服务就不加载（Cordis 会挂起等待）。 */
export const inject = ['tools'];

export interface PluginRuntime {
  readonly version: string;
  readonly adapterId: string;
  readonly bridge: HostBridge;
  readonly config: XianshouConfig;
  readonly capabilities: readonly CapabilityReport[];
  readonly repositoryKind: string;
  readonly degraded: readonly string[];
  /** 缓存水合完成。宿主可以忽略，测试与 SDK 场景需要等它。 */
  readonly ready: Promise<void>;
}

export interface MountOptions {
  readonly ctx: unknown;
  readonly config?: unknown;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly logger?: Logger;
  readonly notifier?: Notifier;
  readonly repository?: TaskRepository;
  readonly artifacts?: ArtifactStore;
  readonly hasher?: Hasher;
  readonly documents?: DocumentStore;
}

const CAPABILITIES: readonly Capability[] = [new GateCapability(), new ToolsetCapability(), new ReminderCapability()];

/** 版本探测失败时的基线。取 engines.dsh 的下界，最保守。 */
export const VERSION_FALLBACK = '0.2.1-rc.1';

/**
 * 宿主版本探测
 *
 * 注意：**不能用 `ctx.version` 这种直接属性访问**。Cordis 的 Context 是 Proxy，
 * 读取未 inject 的服务属性会抛 `cannot get property "version" without inject`，
 * 而这个函数在 apply 的最前面执行 —— 抛一次就等于整个插件没激活。
 * 因此全部走 ctx.get()（可选服务的官方姿势）+ 容错读属性。
 */
export function detectHostVersion(ctx: unknown): string {
  const candidates: unknown[] = [
    typeof process !== 'undefined' ? process.env['DSH_VERSION'] : undefined,
    // 两条路径都试，顺序无关紧要，但不能只留一条
    propOf(ctx, 'version'),
    safeGet(ctx, 'version'),
    propOf(propOf(ctx, 'app'), 'version'),
    propOf(safeGet(ctx, 'app'), 'version'),
    propOf(safeGet(ctx, 'harness'), 'version'),
    propOf(safeGet(ctx, 'dsh'), 'version'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^\d+\.\d+\.\d+/.test(candidate)) return candidate;
  }
  return VERSION_FALLBACK;
}

export function apply(ctx: unknown, config?: unknown): void {
  mount({ ctx, ...(config === undefined ? {} : { config }) });
}

/** 测试与 SDK 场景的入口：返回运行时报文，便于断言能力安装结果。 */
export function mount(options: MountOptions): PluginRuntime {
  const logger = options.logger ?? new ConsoleLogger();
  const parsed = new ConfigParser().parse(options.config);
  for (const issue of parsed.issues) logger.warn(`[xianshou] 配置问题：${issue}`);
  const config = parsed.config;

  const version = detectHostVersion(options.ctx);
  if (version === VERSION_FALLBACK) {
    logger.warn('[xianshou] 未能从宿主读到版本号（服务需 inject 才可直接读），按基线版本处理', {
      version,
      hint: '可用环境变量 DSH_VERSION 覆盖，或在报告问题时附上宿主版本',
    });
  }
  const gate = new VersionGate({ engineRange: config.compat.engineRange, allowUnverified: config.compat.allowUnverified });
  const gateResult = gate.assertOrThrow(version, logger);

  const adapter = new AdapterRegistry().select(version, logger);
  const resolved = adapter.resolve(options.ctx, version);
  const bridge = resolved.bridge;

  const policy = buildPolicy(config, logger);
  const cache = new TaskCache();
  const repository = options.repository ?? buildRepository(config, bridge, logger);
  const notifier = options.notifier ?? new SessionNotifier(bridge, logger);
  const artifacts =
    options.artifacts ??
    new FsArtifactStore(config.archive.directory ?? join(resolveCwd(), 'xianshou-export'), logger);
  const hasher = options.hasher ?? new NodeHasher();
  const documents =
    options.documents ??
    (SessionDocumentStore.isAvailable(bridge)
      ? new SessionDocumentStore(bridge, logger)
      : new FileDocumentStore(join(resolveCwd(), '.xianshou', 'state'), logger));

  const sessionSink = {
    publish(event: DomainEvent): void {
      bridge.session?.emit('xianshou/domain-event', event);
    },
  };

  // 时钟提成变量：任务服务与教程服务必须共享同一个时间源，否则测试里推时钟只推进一半。
  const clock = options.clock ?? new SystemClock();

  const tasks = new TaskService({
    repository,
    clock,
    ids: options.ids ?? new RandomIdGenerator(),
    policy,
    logger,
    events: new CompositeEventSink([cache, sessionSink]),
  });

  // 水合缓存：守卫读的是这份镜像，因此挂载后必须尽快填满。
  const ready = tasks
    .list()
    .then((all) => cache.hydrate(all))
    .catch((error: unknown) => {
      logger.warn('[xianshou] 缓存水合失败', { error: String(error) });
    });

  const guide = new GuideService({ documents, clock });

  const services = {
    tasks,
    cache,
    views: createViews(policy),
    ledgerPolicy: new LedgerPolicy(policy),
    notifier,
    artifacts,
    hasher,
    pluginVersion: PLUGIN_VERSION,
    documents,
    guide,
  };

  const capabilityCtx = { bridge, config, logger, services };
  const reports = CAPABILITIES.map((capability) => capability.install(capabilityCtx));

  const summary = {
    version,
    adapter: adapter.id,
    verdict: gateResult.verdict,
    repository: repository.kind,
    archiveDir: artifacts.directory,
    documents: documents.kind,
    capabilities: reports.map((r) => `${r.id}:${r.status}`).join(' '),
  };
  logger.info('[xianshou] 已挂载', summary);
  bridge.session?.emit('xianshou/ready', summary);

  return {
    version,
    adapterId: adapter.id,
    bridge,
    config,
    capabilities: reports,
    repositoryKind: repository.kind,
    degraded: resolved.downgraded,
    ready,
  };
}

function buildPolicy(config: XianshouConfig, logger: Logger): DefaultThresholdPolicy {
  try {
    return new DefaultThresholdPolicy(config.thresholds);
  } catch (error) {
    // 阈值自相矛盾时拒绝启动会让用户完全没法用；回落默认值 + 明确告警更合理。
    if (error instanceof PolicyValidationError) {
      logger.error('[xianshou] 阈值配置自相矛盾，已回落默认值', { issues: error.issues });
      return new DefaultThresholdPolicy();
    }
    throw error;
  }
}

function buildRepository(config: XianshouConfig, bridge: HostBridge, logger: Logger): TaskRepository {
  const mode = config.storage.mode;
  const sessionRepo = () =>
    SessionStateRepository.isAvailable(bridge)
      ? new SessionStateRepository(bridge, logger)
      : undefined;
  const fileRepo = () => {
    const dir = config.storage.directory ?? join(resolveCwd(), '.xianshou', 'tasks');
    return new JsonFileRepository(dir, logger);
  };

  let base: TaskRepository;
  if (mode === 'memory') {
    base = new MemoryTaskRepository();
  } else if (mode === 'session') {
    const repo = sessionRepo();
    if (!repo) {
      logger.warn('[xianshou] 指定 session 存储但宿主无会话状态接缝，降级为文件存储');
      base = fileRepo();
    } else base = repo;
  } else if (mode === 'file') {
    base = fileRepo();
  } else {
    base = sessionRepo() ?? fileRepo();
  }

  const migrating = new MigratingRepository(base, DEFAULT_MIGRATIONS);
  return mode === 'memory' ? migrating : new ResilientRepository(migrating, logger);
}

function resolveCwd(): string {
  const cwd = propOf(globalThis, 'process');
  const getCwd = methodOf(cwd, 'cwd');
  if (typeof getCwd === 'function') {
    try {
      return String(getCwd.call(cwd));
    } catch {
      /* fall through */
    }
  }
  return '.';
}
