/**
 * 端口 · 时间与身份
 *
 * 把"当前时间"变成依赖注入的接口，是让领域层可测试的最便宜方式：
 * 回收闸门的 24 小时 / 7 天判定不需要 fake timer，只要换一个 Clock。
 */

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** 测试用：可手动推进的时钟。放在 src 而非 test，便于宿主侧集成测试复用。 */
export class ManualClock implements Clock {
  #now: Date;
  constructor(start: Date | string = '2026-11-05T00:00:00.000Z') {
    this.#now = typeof start === 'string' ? new Date(start) : new Date(start.getTime());
  }
  now(): Date {
    return new Date(this.#now.getTime());
  }
  advanceHours(hours: number): void {
    this.#now = new Date(this.#now.getTime() + hours * 3600_000);
  }
  set(date: Date | string): void {
    this.#now = typeof date === 'string' ? new Date(date) : new Date(date.getTime());
  }
}

export interface IdGenerator {
  next(prefix: string): string;
}

/** 无序、可读、无依赖：时间戳 + 随机后缀，足够避免同会话内碰撞。 */
export class RandomIdGenerator implements IdGenerator {
  next(prefix: string): string {
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${stamp}${rand}`;
  }
}

export class SequentialIdGenerator implements IdGenerator {
  #counter = 0;
  next(prefix: string): string {
    this.#counter += 1;
    return `${prefix}-${String(this.#counter).padStart(4, '0')}`;
  }
}
