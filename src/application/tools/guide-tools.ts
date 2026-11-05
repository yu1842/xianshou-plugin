import { optStr, schemaObject, type Args } from '../args.js';
import { XianshouTool } from '../tool-base.js';
import type { ToolResult } from '../TaskService.js';
import type { ToolViews } from '../views.js';
import type { GuideService } from '../GuideService.js';
import { DomainError } from '../../domain/model.js';
import { GUIDE_CHAPTERS, GUIDE_TRACKS, isTrack, type GuideTrack } from '../../domain/guide.js';

/**
 * 教程工具
 *
 * 为什么教程要做成工具而不是把文档链接丢给用户：
 *   1. 用户问"这玩意怎么用"时，模型能直接给出当前该做的那一步，而不是让他去翻 README；
 *   2. 进度存在插件里，跨会话连续 —— 下次打开能从"上次读到哪"继续；
 *   3. 教程里的每条示例都是真实工具调用，可以原样抄进对话，不会出现"文档写的工具名早改了"。
 */
export class GuideTool extends XianshouTool {
  readonly name = 'xianshou_guide';
  readonly description =
    '使用教程：返回目录、某一章正文，或切换学习路径。' +
    '不带参数时返回目录与"下一步该读哪章"；chapter 指定章节 id（或用 next 取下一章）；track 切换路径（quick=先能用 / full=完整走一遍 / measure=看效果）。' +
    '章节里的每条调用示例都可以原样使用。' +
    '用户问"这插件怎么用""从哪开始""我第一次用""训练营怎么开""某个工具怎么调"时，先调这个工具，而不是凭记忆解释。';
  readonly parameters = schemaObject(
    {
      chapter: {
        type: 'string',
        description: `章节 id，或用 next 表示当前路径的下一章。可用：${GUIDE_CHAPTERS.map((c) => c.id).join(' / ')}`,
      },
      track: {
        type: 'string',
        enum: ['quick', 'full', 'measure'],
        description: '学习路径：quick=先能用（4 章）；full=完整走一遍（7 章）；measure=看效果（3 章）',
      },
    },
    [],
  );

  constructor(
    private readonly guide: GuideService,
    private readonly views: ToolViews,
  ) {
    super();
  }

  protected async run(args: Args): Promise<ToolResult> {
    const trackArg = optStr(args, 'track');
    if (trackArg !== undefined && !isTrack(trackArg)) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `track 只能是 quick / full / measure，收到 ${trackArg}。`,
        Object.entries(GUIDE_TRACKS)
          .map(([id, meta]) => `${id}=${meta.label}`)
          .join('；'),
      );
    }
    const chapterId = optStr(args, 'chapter');

    let previousTrack: GuideTrack | null = null;
    if (trackArg !== undefined) {
      const switched = await this.guide.switchTrack(trackArg);
      if (switched.previous !== switched.progress.track) previousTrack = switched.previous;
    }

    if (chapterId !== undefined) {
      const opened = await this.guide.open(chapterId);
      return {
        value: {
          ok: true,
          chapter: opened.chapter.id,
          title: opened.chapter.title,
          track: opened.progress.track,
          read: opened.summary.readCount,
          total: opened.summary.total,
          percent: opened.summary.percent,
          nextChapterId: opened.summary.nextChapterId,
          done: opened.summary.done,
        },
        card: this.views.guide.chapter(opened.chapter, opened.progress),
      };
    }

    const progress = await this.guide.current();
    const summary = await this.guide.summary();

    if (previousTrack !== null) {
      return {
        value: {
          ok: true,
          action: 'switch-track',
          track: progress.track,
          previousTrack,
          read: summary.readCount,
          total: summary.total,
          nextChapterId: summary.nextChapterId,
        },
        card: this.views.guide.trackChanged(progress, previousTrack),
      };
    }

    return {
      value: {
        ok: true,
        action: 'outline',
        track: progress.track,
        read: summary.readCount,
        total: summary.total,
        percent: summary.percent,
        nextChapterId: summary.nextChapterId,
        done: summary.done,
        chapters: GUIDE_CHAPTERS.map((c) => c.id),
      },
      card: this.views.guide.outline(progress),
    };
  }
}
