import type { Notification, Notifier } from '../../ports/observability.js';
import type { HostBridge } from '../../ports/host.js';
import type { Logger } from '../../ports/observability.js';

/**
 * 会话内通知器
 *
 * 通知有两条通道：会话事件（界面可订阅）与日志（无界面时仍可追溯）。
 * 两条都失败也不算致命 —— 通知是提醒，不是账本；账本已经在仓储里了。
 */
export class SessionNotifier implements Notifier {
  constructor(
    private readonly bridge: HostBridge,
    private readonly logger: Logger,
  ) {}

  async notify(notification: Notification): Promise<void> {
    try {
      this.bridge.session?.emit('xianshou/notify', {
        id: notification.id,
        tone: notification.tone,
        title: notification.title,
        body: notification.body,
        ...(notification.taskId ? { taskId: notification.taskId } : {}),
      });
    } catch (error) {
      this.logger.warn('[xianshou] 会话事件发送失败', { error: String(error), id: notification.id });
    }
    if (notification.tone === 'critical') this.logger.warn(`[xianshou] ${notification.title}`, { body: notification.body });
  }
}
