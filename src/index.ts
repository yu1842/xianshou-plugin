/**
 * 公共 API 表面
 *
 * 只导出"外部真的会用"的东西：插件入口、领域策略（供二次开发与课程化定制）、
 * 以及测试替身（供宿主侧集成测试复用）。
 * 内部实现（具体工具类、适配器细节）不做默认导出，避免被当成稳定契约。
 */

export {
  apply,
  mount,
  name,
  inject,
  detectHostVersion,
  VERSION_FALLBACK,
  type PluginRuntime,
  type MountOptions,
} from './plugin.js';

export { ConfigParser, DEFAULT_CONFIG, ENGINE_RANGE, type XianshouConfig } from './config.js';

export { DefaultThresholdPolicy, PolicyValidationError, type ThresholdPolicy, type PolicyOverrides } from './domain/policy.js';
export { ZoneClassifier, type ZoneSignals, type ZoneDecision, type ZoneRule } from './domain/zone.js';
export { SourceLedger, LedgerPolicy, type LedgerTally, type LedgerVerdict, type LedgerSegment } from './domain/ledger.js';
export { DraftValidator, type DraftInput, type DraftArtifact } from './domain/draft.js';
export { RECALL_QUESTIONS, RecallPolicy, buildRecallGates, windowLabel, type RecallAttempt, type RecallGate } from './domain/recall.js';
export { RefusalPanel, type RefusalTally, type RefusalDecision } from './domain/refusal.js';
export { HealthReportBuilder, type HealthReport, type Metric } from './domain/health.js';
export { TaskRecord, TASK_SCHEMA_VERSION, type TaskSnapshot } from './domain/task.js';
export { DomainError, asTaskId, type Zone, type SourceTag, type TaskId } from './domain/model.js';

export { TaskService, NoopEventSink, CompositeEventSink, type DomainEvent, type EventSink } from './application/TaskService.js';
export { TaskCache } from './application/TaskCache.js';

export { SystemClock, ManualClock, RandomIdGenerator, SequentialIdGenerator, type Clock, type IdGenerator } from './ports/time.js';
export { MemoryLogger, MemoryNotifier, NullLogger, type Logger, type Notifier } from './ports/observability.js';
export type { HostBridge, HostCapabilities, ToolExecutionLike, PreToolDecision } from './ports/host.js';
export type { TaskRepository, StateStore } from './ports/repository.js';

export { MemoryTaskRepository, MemoryStateStore, MigratingRepository, DEFAULT_MIGRATIONS } from './adapters/storage/memory.js';
export { JsonFileRepository } from './adapters/storage/file.js';
export { SessionStateRepository } from './adapters/storage/session-state.js';
export { ResilientRepository } from './adapters/storage/resilient.js';
export { ConsoleLogger } from './adapters/observability/console-logger.js';

export { PLUGIN_VERSION } from './version.js';

export {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  createBundle,
  parseBundle,
  planMerge,
  serializeBundle,
  type ArchiveBundle,
  type MergePolicy,
  type MergePlan,
} from './domain/archive.js';
export { buildMarkdownReport } from './application/report.js';
export {
  CAMP_DOC_KEY,
  createCamp,
  evaluateCamp,
  recordProbe,
  isCamp,
  dayOf,
  type CampRecord,
  type CampEvaluation,
  type CampPhase,
  type CampVerdict,
  type ProbeRecord,
} from './domain/camp.js';
export { MemoryDocumentStore, SessionDocumentStore, FileDocumentStore } from './adapters/storage/documents.js';
export type { DocumentStore } from './ports/documents.js';
export { FsArtifactStore, MemoryArtifactStore } from './adapters/storage/artifacts.js';
export { NodeHasher, Fnv1aHasher } from './adapters/hash/sha256.js';
export type { ArtifactStore, Hasher, WriteResult } from './ports/artifacts.js';

export { VersionGate, type GateResult, type GateVerdict } from './adapters/harness/version-gate.js';
export { AdapterRegistry } from './adapters/harness/registry.js';
export { HarnessAdapter, AdapterV0201, AdapterV0300 } from './adapters/harness/adapter.js';
export { SUPPORT_MATRIX, lookupTier, type SupportTier } from './adapters/harness/support-matrix.js';
export { compareSemVer, parseSemVer, satisfies, releaseLine, isPrerelease } from './adapters/harness/version.js';

export { card, type CardModel, type CardNode, type CardTone } from './ui/card.js';
export { PALETTE, TYPOGRAPHY, SPACING, RADIUS, BORDER, toneStyle, tokensToCss, tokensCssDocument } from './ui/tokens.js';
export { Theme, ThemeResolver, type ThemePreference } from './ui/theme.js';
export { MarkdownCardRenderer, PlainCardRenderer, type CardRenderer } from './ui/renderer.js';
