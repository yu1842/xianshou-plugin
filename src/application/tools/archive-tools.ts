import {
  booleanProp,
  enumProp,
  optBool,
  optStr,
  schemaObject,
  str,
  stringProp,
  type Args,
} from '../args.js';
import { XianshouTool } from '../tool-base.js';
import type { TaskService, ToolResult } from '../TaskService.js';
import type { ToolViews } from '../views.js';
import type { ArtifactStore, Hasher } from '../../ports/artifacts.js';
import { DomainError } from '../../domain/model.js';
import { createBundle, parseBundle, planMerge, serializeBundle, type MergePolicy } from '../../domain/archive.js';
import { HealthReportBuilder } from '../../domain/health.js';
import { buildMarkdownReport } from '../report.js';
import type { TaskSnapshot } from '../../domain/task.js';

/**
 * 归档两件套：导出 / 恢复
 *
 * 设计取舍：
 *  - 导出默认**不覆盖**：备份文件的常见事故是"第二次导出把第一次冲掉"
 *  - 恢复默认 **dry-run**：先给"会发生什么"，确认后才写；写之前不需要额外命令
 *  - 恢复只增不删：不会因为恢复一份旧备份而抹掉当前账本里的任务
 */

const FORMATS = ['markdown', 'json', 'both'] as const;
const MODES = ['dry-run', 'merge', 'overwrite'] as const;

export interface ArchiveToolDeps {
  readonly tasks: TaskService;
  readonly views: ToolViews;
  readonly artifacts: ArtifactStore;
  readonly hasher: Hasher;
  readonly pluginVersion: string;
}

export class ExportTool extends XianshouTool {
  readonly name = 'xianshou_export';
  readonly description =
    '把账本导出成文件：markdown=可外发的周报，json=可恢复的完整备份，both=两份都写。' +
    '默认写到归档目录，同名文件不会覆盖（要覆盖显式传 overwrite=true）。' +
    '含先手稿与回收答案原文；要外发时传 redact=true 先脱敏。' +
    '用户说"导出/备份/出周报/给我一份记录"时使用。';
  readonly parameters = schemaObject(
    {
      format: enumProp('导出格式，默认 markdown', ['markdown', 'json', 'both']),
      name: stringProp('文件名（不含扩展名），默认按时间生成；只允许字母数字点下划线连字符'),
      redact: booleanProp('是否脱敏（去掉先手稿正文与回收答案，保留结构与指标），默认 false'),
      overwrite: booleanProp('同名文件是否覆盖，默认 false'),
    },
    [],
  );

  constructor(private readonly deps: ArchiveToolDeps) {
    super();
  }

  protected async run(args: Args): Promise<ToolResult> {
    const format = pickFormat(args);
    const redact = optBool(args, 'redact') ?? false;
    const overwrite = optBool(args, 'overwrite') ?? false;
    const now = this.deps.tasks.clock.now();
    const base = optStr(args, 'name') ?? `xianshou-${stamp(now)}`;

    const records = await this.deps.tasks.list();
    const snapshots = records.map((task) => task.toSnapshot());
    const bundle = createBundle(snapshots, { now, pluginVersion: this.deps.pluginVersion, redact });
    const json = serializeBundle(bundle);
    const checksum = this.deps.hasher.sha256(json);

    const written: { path: string; bytes: number }[] = [];
    if (format === 'json' || format === 'both') {
      written.push(await this.deps.artifacts.write(`${base}.json`, json, { overwrite }));
    }
    if (format === 'markdown' || format === 'both') {
      const health = new HealthReportBuilder(this.deps.tasks.policy).build(records, now);
      const markdown = buildMarkdownReport(snapshots, {
        generatedAt: now,
        pluginVersion: this.deps.pluginVersion,
        checksum,
        health,
      });
      written.push(await this.deps.artifacts.write(`${base}.md`, markdown, { overwrite }));
      // 只导 markdown 时也把 json 尺寸告知，避免用户以为"纯报表就是备份"
    }

    return {
      value: {
        ok: true,
        files: written,
        directory: this.deps.artifacts.directory,
        tasks: snapshots.length,
        checksum,
        redaction: bundle.redaction,
        note:
          format === 'markdown'
            ? '只导出了报表，不是可恢复的备份；要备份请用 format=json 或 both。'
            : '备份可用 xianshou_import 恢复。',
      },
      card: this.deps.views.archive.exported(written, {
        tasks: snapshots.length,
        checksum,
        redaction: bundle.redaction,
        directory: this.deps.artifacts.directory,
      }),
    };
  }
}

export class ImportTool extends XianshouTool {
  readonly name = 'xianshou_import';
  readonly description =
    '从 json 备份恢复任务。默认 mode=dry-run，只报告"会新增/覆盖/跳过几条"，不改账本；' +
    '确认后传 mode=merge（只补缺失）或 mode=overwrite（备份优先）。' +
    '恢复只增不删：不会删除当前账本里的任何任务。' +
    '文件可以写归档目录里的文件名，也可以写绝对路径。';
  readonly parameters = schemaObject(
    {
      file: stringProp('备份文件名（归档目录内）或绝对路径'),
      mode: enumProp('恢复模式，默认 dry-run', ['dry-run', 'merge', 'overwrite']),
    },
    ['file'],
  );

  constructor(private readonly deps: ArchiveToolDeps) {
    super();
  }

  protected async run(args: Args): Promise<ToolResult> {
    const file = str(args, 'file');
    const mode = pickMode(args);

    const text = await this.deps.artifacts.read(file);
    const bundle = parseBundle(text);

    const existing = (await this.deps.tasks.list()).map((task) => task.toSnapshot());
    const plan = planMerge(existing, bundle.tasks, mode);

    const applied = mode !== 'dry-run';
    if (applied) {
      const byId = new Map<string, TaskSnapshot>(bundle.tasks.map((task) => [task.id, task]));
      for (const item of plan.items) {
        if (item.action === 'skip') continue;
        const snapshot = byId.get(item.id);
        if (!snapshot) continue;
        await this.deps.tasks.importSnapshot(snapshot);
      }
    }

    return {
      value: {
        ok: true,
        mode,
        applied,
        inserted: plan.inserted,
        replaced: plan.replaced,
        skipped: plan.skipped,
        exportedAt: bundle.exportedAt,
        redaction: bundle.redaction,
        items: plan.items,
      },
      card: this.deps.views.archive.imported(plan, applied),
    };
  }
}

function pickFormat(args: Args): (typeof FORMATS)[number] {
  const value = optStr(args, 'format') ?? 'markdown';
  if (!(FORMATS as readonly string[]).includes(value)) {
    throw new DomainError('INVALID_ARGUMENT', `format 只能是 ${FORMATS.join(' / ')}，收到 ${value}。`);
  }
  return value as (typeof FORMATS)[number];
}

function pickMode(args: Args): MergePolicy {
  const value = optStr(args, 'mode') ?? 'dry-run';
  if (!(MODES as readonly string[]).includes(value)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `mode 只能是 ${MODES.join(' / ')}，收到 ${value}。`,
      'dry-run 只报告不写入，建议先跑它。',
    );
  }
  return value as MergePolicy;
}

/** 文件名只能含安全字符，所以时间戳用紧凑格式。 */
function stamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
