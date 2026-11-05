import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const SOURCE_URL = new URL('../client/client.js', import.meta.url);
const source = readFileSync(SOURCE_URL, 'utf8');
const css = /const CSS = `([\s\S]*?)`;/.exec(source)[1];

test('加载契约：客户端半边只依赖 react，不引 node 内置模块或其它依赖', () => {
  const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(requires)], ['react'], '多文件 require 会依赖宿主打包器，必须保持单文件');
  assert.ok(!/from\s+['"]node:/.test(source));
});

test('加载契约：模块导出 name / inject / apply，符合 Cordis 模块形态', () => {
  assert.match(source, /const name = 'xianshou-console'/);
  // 不声明服务依赖：Cordis 的 inject 未满足时插件会静默 pending，"没有入口"就变得不可排查
  assert.match(source, /const inject = \[\];/);
  assert.match(source, /function apply\(ctx\)/);
  assert.match(source, /module\.exports = \{\s*name,\s*inject,\s*apply/);
});

test('样式：只消费宿主令牌，且每个令牌都有兜底值（宿主换肤不会变白屏）', () => {
  const tokenUses = [...css.matchAll(/var\((--dsw-[a-z0-9-]+)\s*,\s*([^)]+)\)/g)];
  assert.ok(tokenUses.length >= 12, `令牌使用过少：${tokenUses.length}`);
  for (const [, token, fallback] of tokenUses) {
    assert.ok(fallback.trim().length > 0, `${token} 缺少兜底值`);
  }
  // 直接写死颜色的地方必须极其有限：只允许在 CSS 变量定义与按钮前景
  const hardCoded = [...css.matchAll(/(?<!-)\b(?:text-)?#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)];
  assert.ok(hardCoded.length <= 12, `硬编码颜色过多：${hardCoded.length}`);
});

test('样式：注入的 style 带 data-plugin，避免被宿主的无主样式清扫回收', () => {
  assert.match(source, /setAttribute\('data-plugin', PLUGIN_TAG\)/);
});

test('布局：三个断点齐备，窄屏改为顶部横向导航而不是挤压内容', () => {
  assert.match(css, /@media \(max-width:900px\)/);
  assert.match(css, /@media \(max-width:560px\)/);
  assert.match(css, /flex-direction:row/);
  assert.match(css, /grid-template-columns:1fr/, '窄屏必须退化为单列');
});

test('布局：主容器不使用固定像素宽度，允许在任意视口内自适应', () => {
  assert.ok(!/\.xs-main\{[^}]*width:\s*\d+px/.test(css), '主区不能锁死像素宽度');
  assert.ok(!/\.xs-shell[^}]*min-width:\s*\d{3,}px/.test(css), '外层不能设最小宽度');
  assert.ok(!/position:\s*fixed/.test(css), '不能使用 fixed，避免覆盖宿主标题栏与侧边栏');
});

test('可访问性：动效可关闭、焦点可见、图标不朗读', () => {
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(css, /:focus-visible\{outline:2px solid var\(--xs-ring/);
  const iconBlocks = [...source.matchAll(/'aria-hidden':\s*'true'/g)];
  assert.ok(iconBlocks.length >= 2, '所有图标都应 aria-hidden');
  assert.match(source, /['"]aria-label['"]:\s*'先手协议模块'/);
  assert.match(source, /aria-current/);
  assert.match(source, /aria-pressed/);
});

test('交互：不使用 eval / document.write / innerHTML，避免注入与回流风险', () => {
  assert.ok(!/\beval\(/.test(source));
  assert.ok(!/document\.write/.test(source));
  assert.ok(!/dangerouslySetInnerHTML/.test(source));
});

test('体积：单文件客户端不超过 80KB（gzip 后约 15KB），冷启动成本可控', () => {
  const size = statSync(SOURCE_URL).size;
  assert.ok(size < 80 * 1024, `客户端过大：${size} 字节`);
});

test('兼容：不使用 :has() 作为唯一布局手段，老内核仍可读', () => {
  const hasRules = [...css.matchAll(/:has\(/g)];
  assert.ok(hasRules.length <= 2, `:has() 使用过多：${hasRules.length}`);
  assert.ok(!/:is\([^)]*\)\s*\{/.test(css), '关键布局不应依赖 :is()');
});

test('兼容：CSS 只使用主流浏览器普遍支持的属性', () => {
  const risky = ['container-type', ':where(', 'color-mix(', 'aspect-ratio', 'inset:'];
  for (const feature of risky) {
    const count = [...css.matchAll(new RegExp(feature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].length;
    assert.equal(count, 0, `出现了需要降级的特性：${feature}`);
  }
});
