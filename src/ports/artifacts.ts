/**
 * 端口 · 归档产物
 *
 * 为什么不直接让工具用 fs：导出是"会写用户磁盘"的动作，必须能被测试替换，
 * 也必须把路径安全收敛在一个实现里（文件名白名单、禁止穿越、默认不覆盖）。
 */

export interface WriteResult {
  readonly path: string;
  readonly bytes: number;
}

export interface ArtifactStore {
  readonly kind: string;
  /** 对用户可见的目录说明，写进工具返回值里，避免"文件到底存哪了"。 */
  readonly directory: string;
  write(name: string, content: string, options?: { readonly overwrite?: boolean }): Promise<WriteResult>;
  read(reference: string): Promise<string>;
  exists(reference: string): Promise<boolean>;
  list(): Promise<readonly string[]>;
}

export interface Hasher {
  /** 用于给导出文件盖章：同一份内容在任何机器上算出同一个值。 */
  sha256(text: string): string;
}
