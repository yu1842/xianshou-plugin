import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tokensCssDocument } from '../dist/index.js';

/**
 * 构建步：把设计令牌导出为 CSS 变量文件。
 * 令牌只写一次，CSS 与文档都从它派生。
 */
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'docs', 'ui-tokens.css');
writeFileSync(target, tokensCssDocument(), 'utf8');
console.log(`已生成 ${target}`);
