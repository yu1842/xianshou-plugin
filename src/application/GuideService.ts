import type { Clock } from '../ports/time.js';
import type { DocumentStore } from '../ports/documents.js';
import { DomainError } from '../domain/model.js';
import {
  GUIDE_CHAPTERS,
  GUIDE_DOC_KEY,
  isGuideProgress,
  markRead,
  nextChapter,
  setTrack,
  summarize,
  type GuideChapter,
  type GuideProgress,
  type GuideSummary,
  type GuideTrack,
} from '../domain/guide.js';

/**
 * 教程服务 · 应用层
 *
 * 只做三件事：读出进度（坏数据当作没读过）、打开一章（顺带记已读）、换路径。
 * 它不生成卡片 —— 卡片由视图层决定，这样同一份进度可以渲染成会话卡片或 Web 面板。
 */
export interface GuideServiceDeps {
  readonly documents: DocumentStore;
  readonly clock: Clock;
}

export interface OpenedChapter {
  readonly chapter: GuideChapter;
  readonly progress: GuideProgress;
  readonly summary: GuideSummary;
}

export class GuideService {
  constructor(private readonly deps: GuideServiceDeps) {}

  /**
   * 读进度。存储里的形状不对（旧版本、被手改、写坏了）一律当作"没读过"，
   * 而不是尽量解析 —— 教程进度丢了只是重看一遍，用半个坏对象去算进度才会让人困惑。
   */
  async current(): Promise<GuideProgress> {
    const raw = await this.deps.documents.read(GUIDE_DOC_KEY);
    if (!isGuideProgress(raw)) return { track: 'quick', read: [], updatedAt: this.deps.clock.now().toISOString() };
    return raw;
  }

  async summary(): Promise<GuideSummary> {
    return summarize(await this.current());
  }

  /** 打开一章；id 支持 'next'（当前路径的下一章）与章节 id。 */
  async open(id: string): Promise<OpenedChapter> {
    const before = await this.current();
    const chapter = id === 'next' ? nextChapter(before) : GUIDE_CHAPTERS.find((c) => c.id === id);

    if (chapter === null) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        '当前路径上的章节都读完了，没有"下一章"。',
        'xianshou_guide() 看目录，或用 xianshou_guide(track="full") 换一条更长的路径。',
      );
    }
    if (chapter === undefined) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `没有这一章：${id}。`,
        `可用章节：${GUIDE_CHAPTERS.map((c) => c.id).join(' / ')}（也可用 next）。`,
      );
    }

    const after = markRead(before, chapter.id, this.deps.clock.now());
    if (after !== before) await this.deps.documents.write(GUIDE_DOC_KEY, after);

    return { chapter, progress: after, summary: summarize(after) };
  }

  /** 换路径。已读记录保留：读过的章节不会因为换了目的而作废。 */
  async switchTrack(track: GuideTrack): Promise<{ previous: GuideTrack; progress: GuideProgress }> {
    const before = await this.current();
    const after = setTrack(before, track, this.deps.clock.now());
    if (after !== before) await this.deps.documents.write(GUIDE_DOC_KEY, after);
    return { previous: before.track, progress: after };
  }
}
