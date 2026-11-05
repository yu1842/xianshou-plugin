import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

import {
  GUIDE_CHAPTERS,
  GUIDE_DOC_KEY,
  GUIDE_TRACKS,
  GuideService,
  MemoryDocumentStore,
  ManualClock,
  DomainError,
  emptyProgress,
  findChapter,
  isGuideProgress,
  markRead,
  nextChapter,
  readingTime,
  setTrack,
  summarize,
  trackChapters,
} from '../dist/index.js';
import { FakeHarness } from './helpers/harness.mjs';

/**
 * 教程测试
 *
 * 重点不在"文案写得对不对"，而在三件会随时间腐坏的事：
 *   1. 教程里写的工具名必须真的存在（否则用户照着抄会得到 unknown tool）；
 *   2. 面板内联的副本必须与领域层一致（否则两处说法会分叉）；
 *   3. 进度状态机不能因为坏数据或换路径而把已读记录弄丢。
 */

const FIXED = { storage: { mode: 'memory' }, recall: { autoRemind: false, sweepMinutes: 0 } };

// ── 内容完整性 ───────────────────────────────────────

test('教程：每章都有可执行步骤、对错示例与自检问题', () => {
  assert.equal(GUIDE_CHAPTERS.length, 9, '章节数变了就要同步面板与文档');
  assert.equal(new Set(GUIDE_CHAPTERS.map((c) => c.id)).size, GUIDE_CHAPTERS.length, '章节 id 不能重复');
  for (const chapter of GUIDE_CHAPTERS) {
    assert.ok(chapter.title.length > 0 && chapter.oneLine.length > 0, `${chapter.id} 缺标题或摘要`);
    assert.ok(chapter.minutes > 0 && chapter.minutes <= 15, `${chapter.id} 的时长不合常理`);
    assert.ok(chapter.steps.length >= 3, `${chapter.id} 步骤太少，起不到教程作用`);
    assert.ok(chapter.good.length >= 2, `${chapter.id} 缺"做对了长什么样"`);
    assert.ok(chapter.bad.length >= 2, `${chapter.id} 缺"常见错法"`);
    assert.ok(chapter.check.length >= 2, `${chapter.id} 缺自检问题`);
    for (const step of chapter.steps) {
      assert.ok(step.text.trim().length > 10, `${chapter.id} 有空洞的步骤描述`);
    }
  }
});

test('教程：三条路径的首章都是 start，且引用的章节 id 全部存在', () => {
  for (const [trackId, meta] of Object.entries(GUIDE_TRACKS)) {
    assert.ok(meta.chapters.length >= 3, `${trackId} 路径太短`);
    const first = meta.chapters[0];
    assert.equal(first, 'start', `${trackId} 没有从"五分钟上手"开始，新人会卡住`);
    for (const id of meta.chapters) {
      assert.ok(findChapter(id), `${trackId} 引用了不存在的章节 ${id}`);
    }
    assert.equal(trackChapters(trackId).length, meta.chapters.length);
  }
  // 看效果这条路必须包含训练营，否则它就没有意义
  assert.ok(GUIDE_TRACKS.measure.chapters.includes('camp'));
});

test('教程：示例里出现的工具名都真实存在（照抄不会撞 unknown tool）', async () => {
  const harness = new FakeHarness();
  harness.mount(FIXED);
  await harness.runtime.ready;
  const registered = new Set(harness.toolNames());

  const referenced = new Set();
  for (const chapter of GUIDE_CHAPTERS) {
    for (const step of chapter.steps) {
      if (!step.call) continue;
      for (const match of step.call.matchAll(/\b(xianshou_[a-z_]+)\s*\(/g)) {
        referenced.add(match[1]);
      }
    }
  }
  assert.ok(referenced.size >= 8, `教程只提到 ${referenced.size} 个工具，覆盖不足`);
  for (const name of referenced) {
    assert.ok(registered.has(name), `教程提到了不存在的工具 ${name}`);
  }
});

test('教程：示例里的参数名都在该工具的参数表里（抄下来不会 INVALID_ARGUMENT）', async () => {
  const harness = new FakeHarness();
  harness.mount(FIXED);
  await harness.runtime.ready;

  let checked = 0;
  for (const chapter of GUIDE_CHAPTERS) {
    for (const step of chapter.steps) {
      if (!step.call) continue;
      const call = /^\s*(xianshou_[a-z_]+)\(([\s\S]*)\)\s*$/.exec(step.call);
      if (!call) continue;
      const [, name, argText] = call;
      const tool = harness.tools.get(name);
      assert.ok(tool, `找不到工具 ${name}`);
      const allowed = new Set(Object.keys(tool.parameters.properties ?? {}));
      // 只校验位置参数形式的 a=...，跳过字符串内部内容
      const args = argText
        .replace(/"[^"]*"/g, '""')
        .split(',')
        .map((chunk) => chunk.split('=')[0].trim())
        .filter((key) => /^[a-z_]+$/.test(key));
      for (const key of args) {
        assert.ok(allowed.has(key), `${name} 没有参数 ${key}（教程示例会失败）`);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 15, `只校验了 ${checked} 个参数，说明示例解析失效了`);
});

// ── 进度状态机 ───────────────────────────────────────

const now = new Date('2026-11-06T09:00:00.000Z');

test('进度：标记已读是幂等的，且顺序跟随路径而不是阅读顺序', () => {
  let progress = emptyProgress(now, 'full');
  progress = markRead(progress, 'gate', now);
  progress = markRead(progress, 'start', now);
  assert.deepEqual(progress.read, ['start', 'gate'], '顺序应按路径排列');
  const again = markRead(progress, 'start', now);
  assert.equal(again, progress, '重复标记不应产生新对象（避免无意义写盘）');
});

test('进度：nextChapter 依次推进，读完返回 null', () => {
  let progress = emptyProgress(now, 'quick');
  assert.equal(nextChapter(progress)?.id, 'start');
  for (const id of GUIDE_TRACKS.quick.chapters) {
    progress = markRead(progress, id, now);
  }
  assert.equal(nextChapter(progress), null);
  const summary = summarize(progress);
  assert.equal(summary.done, true);
  assert.equal(summary.percent, 1);
  assert.equal(summary.remainingMinutes, 0);
});

test('进度：换路径保留已读，并且剩余时长按新路径重算', () => {
  let progress = emptyProgress(now, 'quick');
  progress = markRead(progress, 'start', now);
  progress = markRead(progress, 'zone', now);
  const switched = setTrack(progress, 'measure', now);
  assert.equal(switched.track, 'measure');
  assert.deepEqual(switched.read, ['start', 'zone'], '换路径不能清空已读');
  const summary = summarize(switched);
  assert.equal(summary.total, GUIDE_TRACKS.measure.chapters.length);
  assert.equal(summary.nextChapterId, 'camp', 'measure 路径里 start 已读，下一章应是 camp');
  assert.equal(setTrack(switched, 'measure', now), switched, '同路径切换不产生新对象');
});

test('进度：坏数据一律当作没读过，不半信半疑地解析', () => {
  const bad = [
    null,
    [],
    'guide',
    {},
    { track: 'quick', read: [] },
    { track: 'nope', read: [], updatedAt: 'x' },
    { track: 'quick', read: ['不存在的章节'], updatedAt: 'x' },
    { track: 'quick', read: ['start'], updatedAt: 123 },
  ];
  for (const raw of bad) {
    assert.equal(isGuideProgress(raw), false, `应拒绝：${JSON.stringify(raw)}`);
  }
  assert.equal(isGuideProgress(emptyProgress(now, 'full')), true);
});

test('进度：阅读时长是各章之和，不是拍出来的', () => {
  const total = readingTime(trackChapters('full'));
  assert.equal(
    total,
    trackChapters('full').reduce((sum, c) => sum + c.minutes, 0),
  );
  assert.ok(total > 20 && total < 120, `full 路径总时长 ${total} 分钟，与"一次坐下就能读完"不符`);
});

// ── 服务层 ───────────────────────────────────────────

function makeService() {
  const documents = new MemoryDocumentStore();
  const clock = new ManualClock('2026-11-06T09:00:00.000Z');
  return { documents, clock, service: new GuideService({ documents, clock }) };
}

test('服务：存储里是坏数据时回落到默认进度，不抛错', async () => {
  const { documents, service } = makeService();
  await documents.write(GUIDE_DOC_KEY, { track: 'unknown', read: 'x' });
  const progress = await service.current();
  assert.equal(progress.track, 'quick');
  assert.deepEqual(progress.read, []);
});

test('服务：打开一章会落库，并在摘要里推进下一步', async () => {
  const { documents, service } = makeService();
  const opened = await service.open('start');
  assert.equal(opened.chapter.id, 'start');
  assert.equal(opened.summary.nextChapterId, 'zone');
  const stored = await documents.read(GUIDE_DOC_KEY);
  assert.equal(isGuideProgress(stored), true);
  assert.deepEqual(stored.read, ['start'], '进度必须真的写进去，否则跨会话就丢了');
});

test('服务：next 取下一章；读完后明确拒绝而不是返回空', async () => {
  const { service } = makeService();
  const first = await service.open('next');
  assert.equal(first.chapter.id, 'start');
  for (const id of GUIDE_TRACKS.quick.chapters.slice(1)) {
    await service.open(id);
  }
  await assert.rejects(
    () => service.open('next'),
    (error) => error instanceof DomainError && /都读完了/.test(error.message),
  );
});

test('服务：未知章节报错并列出可用 id（模型能自我修正）', async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.open('nope'),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.hint, /start/);
      assert.match(error.hint, /trouble/);
      return true;
    },
  );
});

// ── 工具链路 ─────────────────────────────────────────

test('工具：不带参数返回目录，含进度与下一步', async () => {
  const harness = new FakeHarness();
  harness.mount(FIXED);
  await harness.runtime.ready;

  const result = await harness.dispatch('xianshou_guide', {});
  assert.match(result.text, /使用教程/);
  assert.match(result.text, /下一步/);
  assert.equal(result.value.total, GUIDE_TRACKS.quick.chapters.length);
  assert.equal(result.value.nextChapterId, 'start');
  assert.equal(result.value.read, 0);
});

test('工具：打开章节返回正文与可抄的调用示例，并记录进度', async () => {
  const harness = new FakeHarness();
  harness.mount(FIXED);
  await harness.runtime.ready;

  const result = await harness.dispatch('xianshou_guide', { chapter: 'camp' });
  assert.match(result.text, /四周训练营/);
  assert.match(result.text, /xianshou_camp\(action="start"/, '调用示例必须原样出现在卡片里');
  assert.match(result.text, /自检/);
  assert.equal(result.value.chapter, 'camp');

  const stored = await harness.documents.read(GUIDE_DOC_KEY);
  assert.ok(stored.read.includes('camp'));

  // 再问目录时进度应反映刚才那一章
  const outline = await harness.dispatch('xianshou_guide', {});
  assert.ok(outline.value.chapters.includes('camp'));
});

test('工具：切换路径返回回执，并说明已读没有丢', async () => {
  const harness = new FakeHarness();
  harness.mount(FIXED);
  await harness.runtime.ready;
  await harness.dispatch('xianshou_guide', { chapter: 'start' });

  const switched = await harness.dispatch('xianshou_guide', { track: 'measure' });
  assert.equal(switched.value.track, 'measure');
  assert.equal(switched.value.previousTrack, 'quick');
  assert.match(switched.text, /已切换学习路径/);
  assert.match(switched.text, /之前读过的仍算已读/);
  assert.equal(switched.value.nextChapterId, 'camp', 'measure 路径里 start 已读，下一章是 camp');
});

test('工具：非法 track 与非法章节都给出可修正的错误', async () => {
  const harness = new FakeHarness();
  harness.mount(FIXED);
  await harness.runtime.ready;

  const badTrack = await harness.dispatch('xianshou_guide', { track: 'turbo' });
  assert.equal(badTrack.value.ok, false);
  assert.equal(badTrack.value.error.code, 'INVALID_ARGUMENT');

  const badChapter = await harness.dispatch('xianshou_guide', { chapter: 'zzz' });
  assert.equal(badChapter.value.ok, false);
  assert.match(badChapter.value.error.hint, /start/);
});

// ── 客户端一致性与渲染 ───────────────────────────────

test('客户端：内联的教程数据与领域层逐字段一致（防两处说法分叉）', () => {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  const block = /const GUIDE_DATA = ([\s\S]*?);\n\/\/ <guide-data:end>/.exec(source);
  assert.ok(block, '客户端里找不到 guide-data 块，可能被手工改坏了');
  const inlined = JSON.parse(block[1]);
  assert.deepEqual(inlined.chapters, JSON.parse(JSON.stringify(GUIDE_CHAPTERS)));
  assert.deepEqual(inlined.tracks, JSON.parse(JSON.stringify(GUIDE_TRACKS)));
});

test('客户端：每个导航模块的图标都真实存在（不靠"画不出来就空着"兜底）', () => {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  const iconBlock = /const paths = \{([\s\S]*?)\n  \};/.exec(source);
  assert.ok(iconBlock, '找不到图标表');
  const known = new Set([...iconBlock[1].matchAll(/^\s{4}([a-z]+):/gm)].map((m) => m[1]));
  const { MODULES } = require('../client/client.js').__internals;
  for (const module of MODULES) {
    assert.ok(known.has(module.icon), `模块 ${module.id} 的图标 ${module.icon} 不存在`);
  }
});

test('客户端：教程模块能渲染出目录与章节正文（服务端渲染真 HTML）', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { GuideView } = require('../client/client.js').__internals;

  const outline = renderToStaticMarkup(
    React.createElement(GuideView, {
      route: { module: 'guide', id: null, query: {} },
      onNavigate: () => {},
      notify: () => {},
    }),
  );
  assert.match(outline, /三条路径/);
  for (const chapter of GUIDE_CHAPTERS) {
    assert.ok(outline.includes(chapter.title), `目录里缺章节：${chapter.title}`);
  }

  const detail = renderToStaticMarkup(
    React.createElement(GuideView, {
      route: { module: 'guide', id: 'draft', query: {} },
      onNavigate: () => {},
      notify: () => {},
    }),
  );
  assert.match(detail, /先手稿/);
  assert.match(detail, /xs-code/, '调用示例必须渲染成代码块，而不是普通段落');
  assert.match(detail, /常见错法/);

  const missing = renderToStaticMarkup(
    React.createElement(GuideView, {
      route: { module: 'guide', id: 'zzz', query: {} },
      onNavigate: () => {},
      notify: () => {},
    }),
  );
  assert.match(missing, /没有这一章/);
});
