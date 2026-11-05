import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GUIDE_CHAPTERS, GUIDE_TRACKS } from '../dist/domain/guide.js';

/**
 * 构建步：把教程内容从领域层注入客户端半边。
 *
 * 为什么不上单独的 guide-data.js 让客户端 require：
 *   客户端半边只保证 require('react') 可用，相对路径 require 依赖宿主的加载器实现，
 *   多一个依赖就多一个"装了没入口"的可能。单文件内联没有这个风险。
 *
 * 为什么不是手写两份：
 *   两份内容必然漂移，而且漂移的是"文档说 xianshou_camp，实际叫 xianshou_probe"这类
 *   最容易让人放弃使用的细节。所以领域层是唯一真源，这里只做搬运，
 *   并由 test/guide.test.js 断言内联块与领域层逐字段一致。
 */
const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'client', 'client.js');

const payload = {
  chapters: GUIDE_CHAPTERS,
  tracks: GUIDE_TRACKS,
};

const block = [
  '// <guide-data:begin> 由 scripts/gen-guide.mjs 从 src/domain/guide.ts 生成，请勿手工编辑',
  `const GUIDE_DATA = ${JSON.stringify(payload, null, 2)};`,
  '// <guide-data:end>',
].join('\n');

const source = readFileSync(clientPath, 'utf8');
const pattern = /\/\/ <guide-data:begin>[\s\S]*?\/\/ <guide-data:end>/;
if (!pattern.test(source)) {
  console.error('未找到 guide-data 标记块，client/client.js 可能被改坏了');
  process.exit(1);
}
writeFileSync(clientPath, source.replace(pattern, block), 'utf8');

const chapterCount = payload.chapters.length;
const bytes = Buffer.byteLength(block, 'utf8');
console.log(`已注入 ${chapterCount} 章教程到 client/client.js（${(bytes / 1024).toFixed(1)} KB）`);
