import { createHash } from 'node:crypto';
import type { Hasher } from '../../ports/artifacts.js';

/** 归档盖章用。固定 UTF-8，保证同一内容在不同机器上哈希一致。 */
export class NodeHasher implements Hasher {
  sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }
}

/** 测试用：可预测、无需 crypto，但不用于生产（碰撞不设防）。 */
export class Fnv1aHasher implements Hasher {
  sha256(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0').repeat(8);
  }
}
