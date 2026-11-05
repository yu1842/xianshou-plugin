import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { ArtifactStore, WriteResult } from '../../ports/artifacts.js';
import { DomainError } from '../../domain/model.js';
import type { Logger } from '../../ports/observability.js';

/**
 * 文件归档实现
 *
 * 三条硬约束：
 *  1. 文件名白名单：只允许 `[A-Za-z0-9._-]`，从根上排除路径穿越
 *  2. 默认不覆盖：重名时要求显式 overwrite，否则报错并给出建议文件名
 *  3. 原子写：先写临时文件再 rename，避免半个 JSON
 */
export class FsArtifactStore implements ArtifactStore {
  readonly kind = 'fs';
  readonly directory: string;
  readonly #logger: Logger;

  constructor(directory: string, logger: Logger) {
    this.directory = resolve(directory);
    this.#logger = logger;
  }

  async write(name: string, content: string, options: { readonly overwrite?: boolean } = {}): Promise<WriteResult> {
    const safe = assertSafeName(name);
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, safe);

    if (!options.overwrite && (await this.exists(safe))) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `文件已存在：${safe}`,
        '换个文件名，或显式传 overwrite=true。默认不覆盖，避免把上一次的备份冲掉。',
      );
    }

    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, target);
    const bytes = Buffer.byteLength(content, 'utf8');
    this.#logger.info('[xianshou] 已写入归档', { file: safe, bytes });
    return { path: target, bytes };
  }

  async read(reference: string): Promise<string> {
    const target = this.#resolveReadable(reference);
    return readFile(target, 'utf8');
  }

  async exists(reference: string): Promise<boolean> {
    try {
      const info = await stat(this.#resolveReadable(reference));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async list(): Promise<readonly string[]> {
    try {
      const entries = await readdir(this.directory);
      return entries.filter((name) => /^[A-Za-z0-9._-]+$/.test(name)).sort();
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** 读取允许两种写法：归档目录内的文件名，或明确的绝对路径（恢复旧备份要用）。 */
  #resolveReadable(reference: string): string {
    if (isAbsolute(reference)) {
      const normalized = resolve(reference);
      if (!normalized.toLowerCase().endsWith('.json') && !normalized.toLowerCase().endsWith('.md')) {
        throw new DomainError('INVALID_ARGUMENT', '只接受 .json 或 .md 归档文件。');
      }
      return normalized;
    }
    const safe = assertSafeName(reference);
    const candidate = join(this.directory, safe);
    const root = this.directory.endsWith(sep) ? this.directory : `${this.directory}${sep}`;
    if (!candidate.startsWith(root) && candidate !== this.directory) {
      throw new DomainError('INVALID_ARGUMENT', `路径越界：${reference}`);
    }
    return candidate;
  }
}

function assertSafeName(name: string): string {
  const trimmed = String(name || '').trim();
  if (trimmed.length === 0) throw new DomainError('INVALID_ARGUMENT', '文件名不能为空。');
  if (trimmed.length > 120) throw new DomainError('INVALID_ARGUMENT', '文件名过长（>120 字符）。');
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new DomainError('INVALID_ARGUMENT', `文件名不能包含路径分隔符或 ..：${trimmed}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new DomainError('INVALID_ARGUMENT', `文件名只允许字母、数字、点、下划线、连字符：${trimmed}`);
  }
  return trimmed;
}

/** 测试与预览用：不落盘，行为与文件实现一致。 */
export class MemoryArtifactStore implements ArtifactStore {
  readonly kind = 'memory';
  readonly directory = '(memory)';
  readonly files = new Map<string, string>();

  async write(name: string, content: string, options: { readonly overwrite?: boolean } = {}): Promise<WriteResult> {
    const safe = assertSafeName(name);
    if (!options.overwrite && this.files.has(safe)) {
      throw new DomainError('INVALID_ARGUMENT', `文件已存在：${safe}`, '换个文件名，或显式传 overwrite=true。');
    }
    this.files.set(safe, content);
    return { path: safe, bytes: Buffer.byteLength(content, 'utf8') };
  }

  async read(reference: string): Promise<string> {
    const value = this.files.get(reference);
    if (value === undefined) throw new DomainError('INVALID_ARGUMENT', `找不到归档文件：${reference}`);
    return value;
  }

  async exists(reference: string): Promise<boolean> {
    return this.files.has(reference);
  }

  async list(): Promise<readonly string[]> {
    return [...this.files.keys()].sort();
  }
}
