import type { Logger } from '../../ports/observability.js';

/**
 * 控制台日志器
 *
 * 不引入日志库：插件要在宿主进程里跑，输出形式应当可预测。
 * 前缀统一为 [xianshou]，方便用户在 `dsh` 的输出里过滤。
 */
export class ConsoleLogger implements Logger {
  constructor(
    private readonly prefix = '[xianshou]',
    private readonly sink: Pick<Console, 'debug' | 'info' | 'warn' | 'error'> = console,
  ) {}

  debug(message: string, meta?: Record<string, unknown>): void {
    this.#emit('debug', message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.#emit('info', message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.#emit('warn', message, meta);
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.#emit('error', message, meta);
  }

  #emit(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
    const text = message.startsWith(this.prefix) ? message : `${this.prefix} ${message}`;
    if (meta && Object.keys(meta).length > 0) this.sink[level](text, meta);
    else this.sink[level](text);
  }
}
