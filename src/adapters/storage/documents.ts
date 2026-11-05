import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DocumentStore } from '../../ports/documents.js';
import type { HostBridge } from '../../ports/host.js';
import type { Logger } from '../../ports/observability.js';

/** 内存实现：测试与预览用。 */
export class MemoryDocumentStore implements DocumentStore {
  readonly kind = 'memory-docs';
  readonly values = new Map<string, unknown>();

  async read(key: string): Promise<unknown> {
    return this.values.get(key) ?? null;
  }
  async write(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

/**
 * 会话状态文档存储：优先使用宿主提供的 state 接缝。
 * 好处是随会话/profile 走；代价是 profile 换了数据就不在。
 */
export class SessionDocumentStore implements DocumentStore {
  readonly kind = 'session-docs';
  constructor(
    private readonly bridge: HostBridge,
    private readonly logger: Logger,
  ) {}

  static isAvailable(bridge: HostBridge): boolean {
    return bridge.capabilities.sessionState && bridge.state !== undefined;
  }

  async read(key: string): Promise<unknown> {
    if (!this.bridge.state) return null;
    try {
      return (await this.bridge.state.read(key)) ?? null;
    } catch (error) {
      this.logger.warn('[xianshou] 读取会话文档失败', { key, error: String(error) });
      return null;
    }
  }

  async write(key: string, value: unknown): Promise<void> {
    if (!this.bridge.state) throw new Error('会话状态接缝不可用');
    await this.bridge.state.write(key, value);
  }

  async remove(key: string): Promise<void> {
    if (!this.bridge.state) return;
    await this.bridge.state.write(key, null);
  }
}

/**
 * 文件文档存储：宿主没有 state 接缝时兜底。
 * 一键一文件，原子写；损坏的文件按"不存在"处理并告警 ——
 * 训练营进度丢了可以重开一轮，但绝不能让插件因此启动失败。
 */
export class FileDocumentStore implements DocumentStore {
  readonly kind = 'file-docs';
  constructor(
    private readonly directory: string,
    private readonly logger: Logger,
  ) {}

  async read(key: string): Promise<unknown> {
    try {
      const text = await readFile(this.#path(key), 'utf8');
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (isNotFound(error)) return null;
      this.logger.warn('[xianshou] 文档读取失败，按不存在处理', { key, error: String(error) });
      return null;
    }
  }

  async write(key: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.#path(key);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmp, target);
  }

  async remove(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  #path(key: string): string {
    const safe = key.replace(/[^A-Za-z0-9._-]/g, '_');
    return join(this.directory, `${safe}.json`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}
