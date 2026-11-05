/**
 * 端口 · 通知与日志
 *
 * 通知与日志分开，是因为它们的失败语义不同：
 * 通知失败可以吞（推送丢了不影响任务数据），日志失败也不能拖垮主流程，
 * 但两者的去向与采样策略完全不一样。
 */

export type NotificationTone = 'info' | 'attention' | 'critical';

export interface Notification {
  readonly id: string;
  readonly tone: NotificationTone;
  readonly title: string;
  readonly body: string;
  readonly taskId?: string;
  readonly createdAt: string;
}

export interface Notifier {
  notify(notification: Notification): Promise<void>;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** 结构化日志前缀统一在适配层加，领域层不关心日志走 stdout 还是宿主日志面板。 */
export class NullLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

export class MemoryLogger implements Logger {
  readonly entries: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
  debug(message: string, meta?: Record<string, unknown>): void {
    this.entries.push(meta ? { level: 'debug', message, meta } : { level: 'debug', message });
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.entries.push(meta ? { level: 'info', message, meta } : { level: 'info', message });
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.entries.push(meta ? { level: 'warn', message, meta } : { level: 'warn', message });
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.entries.push(meta ? { level: 'error', message, meta } : { level: 'error', message });
  }
}

export class MemoryNotifier implements Notifier {
  readonly sent: Notification[] = [];
  async notify(notification: Notification): Promise<void> {
    this.sent.push(notification);
  }
}
