import { card, type CardModel, type CardNode } from '../card.js';
import {
  GUIDE_TRACKS,
  nextChapter,
  summarize,
  trackChapters,
  type GuideChapter,
  type GuideProgress,
  type GuideTrack,
} from '../../domain/guide.js';

/**
 * 教程卡片
 *
 * 排版上的三条规矩：
 *   1. 目录必须能一眼看出"读到哪了"，所以用计量条 + 逐章前缀，而不是一堆并列的标题；
 *   2. 每一步都要带可抄的调用示例，用 code 节点而不是行内反引号 —— 教程里最容易失效的
 *      就是"看懂了但抄错参数"；
 *   3. 每章结尾必须有自检问题。没有自检的教程，读者只会觉得自己懂了。
 */
export class GuideCard {
  /** 目录：进度 + 章节清单 + 下一步。没有参数时返回这个。 */
  outline(progress: GuideProgress): CardModel {
    const summary = summarize(progress);
    const chapters = trackChapters(progress.track);
    const nodes: CardNode[] = [];

    if (summary.done) {
      nodes.push(
        { kind: 'badge', text: `已读完 ${summary.trackLabel} 路径`, tone: 'success' },
        {
          kind: 'meter',
          label: '进度',
          value: 1,
          tone: 'success',
          caption: `${summary.total}/${summary.total} 章`,
        },
        { kind: 'divider' },
        { kind: 'paragraph', text: '这条路径上的章节都读过了。接下来只能靠做，不能靠读。' },
        {
          kind: 'callout',
          tone: 'teal',
          title: '接下来做一件具体的事',
          text: '用 xianshou_start 建一个真实的红区任务，走完一次"先手 → 交付"。学过的东西不在任务里走一遍，两周后会全部消失。',
        },
      );
    } else {
      const next = nextChapter(progress) as GuideChapter;
      nodes.push(
        { kind: 'badge', text: summary.trackLabel, tone: 'accent' },
        {
          kind: 'meter',
          label: '进度',
          value: summary.percent,
          tone: summary.percent >= 0.99 ? 'success' : 'accent',
          caption: `${summary.readCount}/${summary.total} 章 · 剩余约 ${summary.remainingMinutes} 分钟`,
        },
        { kind: 'divider' },
        { kind: 'heading', text: '目录' },
        {
          kind: 'list',
          ordered: true,
          items: chapters.map((chapter) => {
            const done = progress.read.includes(chapter.id);
            return `【${done ? '已读' : '未读'}】${chapter.title}（${chapter.minutes} 分钟）— ${chapter.oneLine}`;
          }),
        },
        { kind: 'divider' },
        {
          kind: 'callout',
          tone: 'accent',
          title: `下一步：${next.title}`,
          text: `约 ${next.minutes} 分钟。${next.oneLine}`,
        },
        {
          kind: 'code',
          text: `xianshou_guide(chapter="${next.id}")`,
        },
      );
    }

    nodes.push(
      { kind: 'heading', text: '换一条路径' },
      {
        kind: 'list',
        items: (Object.keys(GUIDE_TRACKS) as GuideTrack[]).map((id) => {
          const track = GUIDE_TRACKS[id];
          const current = id === progress.track ? '（当前）' : '';
          return `${track.label}${current}：${track.oneLine} 共 ${trackChapters(id).length} 章。`;
        }),
      },
      {
        kind: 'code',
        text: 'xianshou_guide(track="measure")   # quick=先能用 / full=完整走一遍 / measure=看效果',
      },
      {
        kind: 'footnote',
        text: '换路径不会清空已读记录。章节可以跳着看：xianshou_guide chapter="trouble" 直接查排障。',
      },
    );

    return card(summary.done ? 'success' : 'accent', '使用教程', nodes, `${summary.trackLabel} · v0.5 教程`);
  }

  /** 单章正文。 */
  chapter(chapter: GuideChapter, progress: GuideProgress): CardModel {
    const order = trackChapters(progress.track).map((c) => c.id);
    const indexInTrack = order.indexOf(chapter.id);
    const position = indexInTrack >= 0 ? `第 ${indexInTrack + 1}/${order.length} 章` : '补充章节';
    const nodes: CardNode[] = [
      { kind: 'badge', text: `约 ${chapter.minutes} 分钟`, tone: 'accent' },
      { kind: 'paragraph', text: `适合谁读：${chapter.forWhom}` },
      { kind: 'divider' },
      { kind: 'heading', text: '怎么做' },
    ];

    chapter.steps.forEach((step, index) => {
      nodes.push({ kind: 'paragraph', text: `${index + 1}. ${step.text}` });
      if (step.call) nodes.push({ kind: 'code', text: step.call });
    });

    nodes.push(
      { kind: 'heading', text: '做对了长什么样' },
      { kind: 'list', items: chapter.good, tone: 'success' },
      { kind: 'heading', text: '常见错法' },
      { kind: 'list', items: chapter.bad, tone: 'danger' },
      { kind: 'heading', text: '自检' },
      {
        kind: 'list',
        items: chapter.check,
        ordered: true,
      },
      {
        kind: 'callout',
        tone: 'teal',
        title: '自检答不上来怎么办',
        text: '回到上面"怎么做"，挑一步在真实任务里做一遍。教程不能替代那十分钟。',
      },
    );

    const next = nextChapter(markReadLocal(progress, chapter));
    nodes.push(
      { kind: 'divider' },
      next
        ? { kind: 'code', text: `xianshou_guide(chapter="${next.id}")   # 下一章：${next.title}` }
        : { kind: 'code', text: 'xianshou_guide()   # 这条路径读完了，看目录' },
      { kind: 'footnote', text: `${position} · 打开这一章已计入阅读进度；xianshou_guide() 可随时看目录` },
    );

    return card('accent', chapter.title, nodes);
  }

  /** 换路径的回执：明确说清"已读没被清掉"，否则用户不敢换。 */
  trackChanged(progress: GuideProgress, previous: GuideTrack): CardModel {
    const summary = summarize(progress);
    const chapters = trackChapters(progress.track);
    return card(
      'teal',
      '已切换学习路径',
      [
        {
          kind: 'kv',
          label: '路径',
          value: `${GUIDE_TRACKS[previous].label} → ${summary.trackLabel}`,
        },
        { kind: 'kv', label: '这一条包含', value: chapters.map((c) => c.title).join(' / ') },
        {
          kind: 'meter',
          label: '进度',
          value: summary.percent,
          tone: 'teal',
          caption: `${summary.readCount}/${summary.total} 章（之前读过的仍算已读）`,
        },
        { kind: 'divider' },
        {
          kind: 'callout',
          tone: 'teal',
          title: '下一步',
          text: summary.nextChapterId
            ? `从「${nextChapter(progress)?.title}」继续。`
            : '这条路径上的章节都已读过，直接去建任务。',
        },
        summary.nextChapterId ? { kind: 'code', text: `xianshou_guide(chapter="${summary.nextChapterId}")` } : { kind: 'divider' },
      ],
      GUIDE_TRACKS[progress.track].oneLine,
    );
  }
}

/**
 * 本文件内部用：只为了算"读完这章之后下一章是谁"，不改外部状态。
 * 真正的进度写入由工具层负责 —— 渲染必须是纯函数。
 */
function markReadLocal(progress: GuideProgress, chapter: GuideChapter): GuideProgress {
  if (progress.read.includes(chapter.id)) return progress;
  return { ...progress, read: [...progress.read, chapter.id] };
}
