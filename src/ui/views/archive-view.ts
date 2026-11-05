import { card, type CardModel, type CardNode } from '../card.js';
import type { MergePlan } from '../../domain/archive.js';

/**
 * 归档卡片
 *
 * 导出/恢复都是"改动磁盘或账本"的动作，卡片必须回答三个问题：
 * 写到哪了、写了什么、能不能撤销。缺一项用户就不敢点第二次。
 */

export interface WrittenFile {
  readonly path: string;
  readonly bytes: number;
}

export class ArchiveCard {
  exported(files: readonly WrittenFile[], summary: { tasks: number; checksum: string; redaction: string; directory: string }): CardModel {
    const nodes: CardNode[] = [
      { kind: 'badge', text: `${files.length} 个文件`, tone: 'success' },
      { kind: 'paragraph', text: `已导出 ${summary.tasks} 个任务。` },
      { kind: 'divider' },
      ...files.map((file) => ({
        kind: 'kv' as const,
        label: file.path.split(/[\\/]/).pop() ?? file.path,
        value: `${(file.bytes / 1024).toFixed(1)} KB`,
        tone: 'teal' as const,
      })),
      { kind: 'paragraph', text: `目录：${summary.directory}` },
      { kind: 'heading', text: '校验值' },
      { kind: 'paragraph', text: `sha256(archive.json) = ${summary.checksum.slice(0, 32)}…` },
    ];
    if (summary.redaction !== 'none') {
      nodes.push({ kind: 'callout', tone: 'accent', title: '已脱敏', text: '备份里的先手稿正文与回收答案被替换为占位符，结构、比例、判定保持不变。' });
    } else {
      nodes.push({ kind: 'callout', tone: 'accent', title: '含原文', text: '备份包含先手稿与回收答案的原文。外发前请确认可以分享这些内容。' });
    }
    nodes.push({ kind: 'footnote', text: '默认不覆盖同名文件；需要覆盖时显式传 overwrite=true。' });
    return card('success', '归档已写出', nodes);
  }

  imported(plan: MergePlan, applied: boolean): CardModel {
    const tone = plan.replaced > 0 ? 'accent' : 'teal';
    const nodes: CardNode[] = [
      { kind: 'badge', text: applied ? '已写入' : '预演（未写入）', tone: applied ? 'teal' : 'neutral' },
      { kind: 'paragraph', text: applied ? '备份已合并进当前账本。' : '这是 dry-run 的结果：账本没有被改动。' },
      { kind: 'divider' },
      { kind: 'kv', label: '新增', value: `${plan.inserted} 个任务` },
      { kind: 'kv', label: '覆盖', value: `${plan.replaced} 个任务`, tone: plan.replaced > 0 ? 'accent' : 'neutral' },
      { kind: 'kv', label: '跳过', value: `${plan.skipped} 个任务` },
    ];
    if (plan.items.length > 0) {
      nodes.push({ kind: 'heading', text: '逐条结果' });
      nodes.push({
        kind: 'list',
        items: plan.items.slice(0, 12).map((item) => `${actionLabel(item.action)}　${item.title}（${item.id}）`),
      });
      if (plan.items.length > 12) nodes.push({ kind: 'footnote', text: `还有 ${plan.items.length - 12} 条未列出。` });
    }
    nodes.push({
      kind: 'callout',
      tone: applied ? 'teal' : 'accent',
      title: applied ? '下一步' : '确认无误后再执行',
      text: applied
        ? '建议用 xianshou_status 或控制台核对一眼任务数。恢复不会删除当前账本里的任何任务。'
        : '把 mode 改成 merge（只补缺失）或 overwrite（备份优先）再执行一次。',
    });
    return card(tone, applied ? '恢复完成' : '恢复预演', nodes);
  }
}

function actionLabel(action: string): string {
  if (action === 'insert') return '＋ 新增';
  if (action === 'replace') return '↻ 覆盖';
  return '＝ 跳过';
}
