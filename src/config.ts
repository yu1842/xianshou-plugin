import type { PolicyOverrides } from './domain/policy.js';
import type { ThemePreference } from './ui/theme.js';

/**
 * 插件配置
 *
 * 设计取向：所有开关都有安全默认值，非法输入只降级不崩溃。
 * 理由很实际 —— 配置错误导致插件"整块不加载"，用户会把问题归到插件坏了，
 * 而不是归到那一行写错的 yaml。因此这里收集 issues 并回落到默认值。
 */

export type GateMode = 'advisory' | 'ask' | 'deny';

export type StorageMode = 'auto' | 'session' | 'file' | 'memory';

export interface GateConfig {
  /** advisory 只记录不拦；ask 走审批（默认）；deny 直接拒绝。 */
  readonly mode: GateMode;
  /** 受到闸门约束的工具名。默认覆盖常见写入类工具。 */
  readonly tools: readonly string[];
  /** true 时没有活跃任务也拦截（适合训练营，不适合日常使用）。 */
  readonly requireTask: boolean;
}

export interface StorageConfig {
  readonly mode: StorageMode;
  /** file 模式下的目录；缺省时用 `<cwd>/.xianshou/tasks`。 */
  readonly directory?: string;
}

export interface CompatConfig {
  readonly allowUnverified: boolean;
  readonly engineRange: string;
}

export interface UiConfig {
  readonly theme: ThemePreference;
  /** true 时卡片附带判据 ID、阈值等调试信息。 */
  readonly verbose: boolean;
}

export interface RecallConfig {
  /** 是否在本会话内主动推送到期提醒。 */
  readonly autoRemind: boolean;
  /** 扫描间隔（分钟）；0 表示只在会话事件与启动时扫描。 */
  readonly sweepMinutes: number;
}

export interface ExportConfig {
  /** 归档目录；缺省时用 `<cwd>/xianshou-export`。 */
  readonly directory?: string;
  /** 导出时是否默认脱敏（去掉先手稿正文与回收答案）。 */
  readonly redact: boolean;
}

export interface XianshouConfig {
  readonly gate: GateConfig;
  readonly thresholds: PolicyOverrides;
  readonly storage: StorageConfig;
  readonly compat: CompatConfig;
  readonly ui: UiConfig;
  readonly recall: RecallConfig;
  readonly archive: ExportConfig;
}

export const ENGINE_RANGE = '>=0.2.1-rc.1 <0.3.0';

export const DEFAULT_TOOL_NAMES: readonly string[] = Object.freeze([
  'write',
  'edit',
  'multi_edit',
  'apply_patch',
  'str_replace',
  'create_file',
  'write_file',
]);

export const DEFAULT_CONFIG: XianshouConfig = Object.freeze({
  gate: Object.freeze({ mode: 'ask', tools: DEFAULT_TOOL_NAMES, requireTask: false }),
  thresholds: Object.freeze({}),
  storage: Object.freeze({ mode: 'auto' }),
  compat: Object.freeze({ allowUnverified: false, engineRange: ENGINE_RANGE }),
  ui: Object.freeze({ theme: 'auto', verbose: false }),
  recall: Object.freeze({ autoRemind: true, sweepMinutes: 0 }),
  archive: Object.freeze({ redact: false }),
});

export interface ConfigParseResult {
  readonly config: XianshouConfig;
  readonly issues: readonly string[];
}

export class ConfigParser {
  parse(input: unknown): ConfigParseResult {
    const issues: string[] = [];
    const root = asObject(input);
    if (input !== undefined && input !== null && root === undefined) {
      issues.push('配置根节点必须是对象；已全部回落默认值。');
    }
    const gate = asObject(root?.['gate']);
    const storage = asObject(root?.['storage']);
    const compat = asObject(root?.['compat']);
    const ui = asObject(root?.['ui']);
    const recall = asObject(root?.['recall']);
    const thresholds = asObject(root?.['thresholds']);

    const mode = pickEnum(gate?.['mode'], ['advisory', 'ask', 'deny'] as const, DEFAULT_CONFIG.gate.mode, 'gate.mode', issues);
    const tools = pickStringArray(gate?.['tools'], DEFAULT_CONFIG.gate.tools, 'gate.tools', issues);
    const requireTask = pickBoolean(gate?.['requireTask'], DEFAULT_CONFIG.gate.requireTask, 'gate.requireTask', issues);

    const storageMode = pickEnum(
      storage?.['mode'],
      ['auto', 'session', 'file', 'memory'] as const,
      DEFAULT_CONFIG.storage.mode,
      'storage.mode',
      issues,
    );
    const directory = pickOptionalString(storage?.['directory'], 'storage.directory', issues);

    const allowUnverified = pickBoolean(compat?.['allowUnverified'], false, 'compat.allowUnverified', issues);
    const engineRange = pickOptionalString(compat?.['engineRange'], 'compat.engineRange', issues) ?? ENGINE_RANGE;

    const theme = pickEnum(ui?.['theme'], ['light', 'dark', 'auto'] as const, DEFAULT_CONFIG.ui.theme, 'ui.theme', issues);
    const verbose = pickBoolean(ui?.['verbose'], false, 'ui.verbose', issues);

    const autoRemind = pickBoolean(recall?.['autoRemind'], true, 'recall.autoRemind', issues);
    const sweepMinutes = pickNumber(recall?.['sweepMinutes'], 0, 'recall.sweepMinutes', issues);
    const archive = asObject(root?.['archive']);
    const archiveDirectory = pickOptionalString(archive?.['directory'], 'archive.directory', issues);
    const archiveRedact = pickBoolean(archive?.['redact'], DEFAULT_CONFIG.archive.redact, 'archive.redact', issues);

    return {
      config: {
        gate: { mode, tools, requireTask },
        thresholds: this.#thresholds(thresholds, issues),
        storage: directory === undefined ? { mode: storageMode } : { mode: storageMode, directory },
        compat: { allowUnverified, engineRange },
        ui: { theme, verbose },
        recall: { autoRemind, sweepMinutes: Math.max(0, sweepMinutes) },
        archive: archiveDirectory === undefined ? { redact: archiveRedact } : { redact: archiveRedact, directory: archiveDirectory },
      },
      issues,
    };
  }

  #thresholds(input: Record<string, unknown> | undefined, issues: string[]): PolicyOverrides {
    if (!input) return {};
    const out: Record<string, number | readonly number[]> = {};
    const numericKeys = [
      'draftMinutes',
      'draftMinChars',
      'aiRatioRecall',
      'aiRatioRework',
      'selfRatioTarget',
      'recallPassScore',
      'recallGraceHours',
      'refusalHealthyMin',
      'refusalHealthyMax',
      'refusalBlindBelow',
      'refusalContrarianAbove',
      'minSamples',
    ] as const;
    for (const key of numericKeys) {
      const value = input[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push(`thresholds.${key} 必须是数字；已忽略。`);
        continue;
      }
      out[key] = value;
    }
    const windows = input['recallWindowsHours'];
    if (windows !== undefined) {
      if (Array.isArray(windows) && windows.every((w) => typeof w === 'number' && w > 0)) {
        out['recallWindowsHours'] = windows as number[];
      } else {
        issues.push('thresholds.recallWindowsHours 必须是正数数组；已忽略。');
      }
    }
    return out as PolicyOverrides;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  path: string,
  issues: string[],
): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  issues.push(`${path} 只能是 ${allowed.join(' / ')}；已回落 ${fallback}。`);
  return fallback;
}

function pickBoolean(value: unknown, fallback: boolean, path: string, issues: string[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  issues.push(`${path} 必须是布尔值；已回落 ${fallback}。`);
  return fallback;
}

function pickNumber(value: unknown, fallback: number, path: string, issues: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  issues.push(`${path} 必须是数字；已回落 ${fallback}。`);
  return fallback;
}

function pickOptionalString(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  issues.push(`${path} 必须是非空字符串；已忽略。`);
  return undefined;
}

function pickStringArray(value: unknown, fallback: readonly string[], path: string, issues: string[]): readonly string[] {
  if (value === undefined) return fallback;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)) return value as string[];
  issues.push(`${path} 必须是非空字符串数组；已回落默认值。`);
  return fallback;
}
