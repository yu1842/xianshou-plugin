import { DomainError, toIso, type Iso8601 } from './model.js';
import { TASK_SCHEMA_VERSION, type TaskSnapshot } from './task.js';

/**
 * 归档领域 · 备份包的构造、校验与合并
 *
 * 一条原则贯穿全文件：**归档是可被外部编辑的文件，必须当作不可信输入处理**。
 * 所以校验不做"尽量兼容"，而是"版本不符就拒绝、结构不符就报出具体字段"——
 * 一个悄悄丢掉字段的恢复，比恢复失败危险得多。
 */

export const ARCHIVE_FORMAT = 'xianshou-archive';
export const ARCHIVE_VERSION = 1;

export interface ArchiveBundle {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly version: number;
  readonly exportedAt: Iso8601;
  readonly pluginVersion: string;
  readonly tasks: readonly TaskSnapshot[];
  /** 可选：导出时对正文做的脱敏说明，恢复时原样保留，便于判断这份备份能不能外发。 */
  readonly redaction: 'none' | 'drafts-and-answers';
}

export interface BuildBundleOptions {
  readonly now: Date;
  readonly pluginVersion: string;
  readonly redact: boolean;
}

export type MergePolicy = 'dry-run' | 'skip-existing' | 'overwrite-existing';

export interface MergePlanItem {
  readonly id: string;
  readonly action: 'insert' | 'replace' | 'skip';
  readonly title: string;
}

export interface MergePlan {
  readonly policy: MergePolicy;
  readonly items: readonly MergePlanItem[];
  readonly inserted: number;
  readonly replaced: number;
  readonly skipped: number;
}

/** 脱敏：只去掉正文类内容（丑版本原文、回收答案），保留结构与指标。 */
function redactSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
  return {
    ...snapshot,
    draft: snapshot.draft === null ? null : { ...snapshot.draft, content: '（已脱敏）', keyJudgements: [] },
    recalls: snapshot.recalls.map((attempt) => ({ ...attempt, answers: attempt.answers.map(() => '（已脱敏）') })),
    segments: snapshot.segments.map((segment) => ({ ...segment, label: segment.label })),
  };
}

export function createBundle(tasks: readonly TaskSnapshot[], options: BuildBundleOptions): ArchiveBundle {
  const redaction: ArchiveBundle['redaction'] = options.redact ? 'drafts-and-answers' : 'none';
  const prepared = options.redact ? tasks.map(redactSnapshot) : tasks.map((task) => ({ ...task }));
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: toIso(options.now),
    pluginVersion: options.pluginVersion,
    tasks: prepared.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    redaction,
  };
}

export function serializeBundle(bundle: ArchiveBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** 校验并解析。所有失败都给字段级原因，便于用户自己修文件。 */
export function parseBundle(text: string): ArchiveBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new DomainError('INVALID_ARGUMENT', `不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DomainError('INVALID_ARGUMENT', '备份文件根节点必须是对象（不能是数组或标量）。');
  }
  const record = raw as Record<string, unknown>;
  if (record['format'] !== ARCHIVE_FORMAT) {
    throw new DomainError('INVALID_ARGUMENT', `不是先手协议备份：format=${String(record['format'])}（期望 ${ARCHIVE_FORMAT}）`);
  }
  const version = record['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new DomainError('INVALID_ARGUMENT', `备份版本非法：${String(version)}`);
  }
  if (version > ARCHIVE_VERSION) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `备份版本 ${version} 高于当前插件支持的 ${ARCHIVE_VERSION}，拒绝猜着读入。`,
      '请升级插件后再恢复。',
    );
  }
  const tasks = record['tasks'];
  if (!Array.isArray(tasks)) throw new DomainError('INVALID_ARGUMENT', '备份里缺少 tasks 数组。');

  const normalized: TaskSnapshot[] = tasks.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new DomainError('INVALID_ARGUMENT', `tasks[${index}] 必须是对象。`);
    }
    const task = item as Record<string, unknown>;
    if (typeof task['id'] !== 'string' || task['id'].length === 0) {
      throw new DomainError('INVALID_ARGUMENT', `tasks[${index}].id 缺失或不是字符串。`);
    }
    const schemaVersion = typeof task['schemaVersion'] === 'number' ? task['schemaVersion'] : 1;
    if (schemaVersion > TASK_SCHEMA_VERSION) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `tasks[${index}]（${task['id']}）的数据版本 ${schemaVersion} 高于插件支持的 ${TASK_SCHEMA_VERSION}。`,
      );
    }
    return { ...(task as unknown as TaskSnapshot), schemaVersion };
  });

  return {
    format: ARCHIVE_FORMAT,
    version,
    exportedAt: typeof record['exportedAt'] === 'string' ? record['exportedAt'] : toIso(new Date(0)),
    pluginVersion: typeof record['pluginVersion'] === 'string' ? record['pluginVersion'] : 'unknown',
    tasks: normalized,
    redaction: record['redaction'] === 'drafts-and-answers' ? 'drafts-and-answers' : 'none',
  };
}

/**
 * 合并计划：只计算"会发生什么"，不执行任何写入。
 * dry-run 与真跑走同一条代码路径，避免"预演说 3 条、真跑改了 5 条"。
 */
export function planMerge(existing: readonly TaskSnapshot[], incoming: readonly TaskSnapshot[], policy: MergePolicy): MergePlan {
  const byId = new Map(existing.map((task) => [task.id, task]));
  const items: MergePlanItem[] = [];
  let inserted = 0;
  let replaced = 0;
  let skipped = 0;

  for (const task of incoming) {
    const current = byId.get(task.id);
    if (!current) {
      items.push({ id: task.id, action: 'insert', title: task.title });
      inserted += 1;
      continue;
    }
    const incomingNewer = String(task.updatedAt) > String(current.updatedAt);
    if (policy === 'overwrite-existing') {
      items.push({ id: task.id, action: 'replace', title: task.title });
      replaced += 1;
    } else if (policy === 'skip-existing') {
      items.push({ id: task.id, action: 'skip', title: task.title });
      skipped += 1;
    } else {
      // dry-run 也要如实告诉用户"真跑会怎样"
      items.push({ id: task.id, action: incomingNewer ? 'replace' : 'skip', title: task.title });
      if (incomingNewer) replaced += 1;
      else skipped += 1;
    }
  }

  return { policy, items, inserted, replaced, skipped };
}

/** dry-run 的替换规则与 overwrite 不同：只在"备份里的更新"时才替换。 */
export function effectivePolicy(policy: MergePolicy): 'insert-only' | 'newer-wins' | 'overwrite' {
  if (policy === 'dry-run') return 'newer-wins';
  if (policy === 'skip-existing') return 'insert-only';
  return 'overwrite';
}
