import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const client = require('../client/client.js');

const { ConsolePage, CSS } = client.__internals;
const h = React.createElement;

/**
 * 生成响应式对照页
 *
 * 目的：把"不同分辨率下入口显示与功能加载正常"从口头承诺变成可查看的产物。
 * 每个分栏是一份真实渲染的完整面板，宽度固定为该断点，内容与线上同一套代码。
 */

const EVENTS = [
  { type: 'xianshou/domain-event', payload: { type: 'task.created', taskId: 'xs-7f21', zone: 'red', title: '重构订单模块' } },
  { type: 'xianshou/domain-event', payload: { type: 'draft.accepted', taskId: 'xs-7f21', chars: 186 } },
  { type: 'xianshou/domain-event', payload: { type: 'segment.marked', taskId: 'xs-7f21', tag: 'ai', aiRatio: 0.62 } },
  {
    type: 'xianshou/domain-event',
    payload: {
      type: 'task.delivered',
      taskId: 'xs-7f21',
      gates: [
        { window: 'd24h', scheduledFor: '2026-11-06T09:00:00Z' },
        { window: 'd7d', scheduledFor: '2026-11-12T09:00:00Z' },
      ],
    },
  },
  { type: 'xianshou/domain-event', payload: { type: 'task.created', taskId: 'xs-8c03', zone: 'yellow', title: '整理竞品定价页' } },
  { type: 'xianshou/domain-event', payload: { type: 'task.created', taskId: 'xs-9a12', zone: 'green', title: '把周报转成英文' } },
  { type: 'xianshou/domain-event', payload: { type: 'refusal.recorded', taskId: 'xs-7f21', decision: 'rejected' } },
  { type: 'xianshou/domain-event', payload: { type: 'refusal.recorded', taskId: 'xs-7f21', decision: 'accepted' } },
  { type: 'xianshou/domain-event', payload: { type: 'refusal.recorded', taskId: 'xs-7f21', decision: 'partial' } },
  { type: 'xianshou/domain-event', payload: { type: 'recall.failed', taskId: 'xs-8c03', score: 0.67 } },
  { type: 'xianshou/gate-denied', payload: { taskId: 'xs-7f21', tool: 'write' } },
  { type: 'xianshou/notify', payload: { id: 'n-1', title: '24 小时回收到期' } },
];

const DARK_OVERRIDES = `
.xs-root{
  background:#14181d;
  --xs-fg:#e8eaed;
  --xs-fg-soft:#b3bcc7;
  --xs-fg-faint:#7d8896;
  --xs-surface-2:rgba(255,255,255,.06);
  --xs-line:rgba(255,255,255,.14);
  --xs-accent:#e0a061;
  --xs-danger:#e2706f;
  --xs-success:#74b98a;
  --xs-teal:#5cbcb1;
}
`;

function innerDoc(route, dark) {
  const markup = renderToStaticMarkup(
    h(ConsolePage, {
      feedOptions: { initialEvents: EVENTS },
      initialRoute: { module: route, id: route === 'tasks' ? 'xs-7f21' : null, query: {} },
    }),
  );
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;height:100%;background:${dark ? '#14181d' : '#fbf9f5'};color:${dark ? '#e8eaed' : '#1c2430'};
font-family:"Source Han Serif SC","Songti SC","Noto Serif CJK SC",Georgia,system-ui,sans-serif}
#root{height:100%}
</style>
<style>${CSS}</style>
${dark ? `<style>${DARK_OVERRIDES}</style>` : ''}
</head><body><div id="root">${markup}</div></body></html>`;
}

function escapeAttr(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

const VARIANTS = [
  { width: 1280, route: 'overview', label: '1280 px · 桌面全宽', note: '侧栏 190px + 内容区，卡片三列' },
  { width: 1024, route: 'tasks', label: '1024 px · 笔记本', note: '任务选中态与详情' },
  { width: 900, route: 'ledger', label: '900 px · 断点边界', note: '导航转为顶部横向，内容单列' },
  { width: 768, route: 'recalls', label: '768 px · 平板竖屏', note: '三个回收问题纵向排列' },
  { width: 560, route: 'health', label: '560 px · 窄窗', note: '卡片两列，指标不截断' },
  { width: 375, route: 'settings', label: '375 px · 手机宽 · 深色', note: '单列，诊断信息可换行' },
];

const frames = VARIANTS.map((variant) => {
  const doc = innerDoc(variant.route, variant.label.includes('深色'));
  return `<figure class="frame">
  <figcaption><strong>${variant.label}</strong><span>${variant.note}</span></figcaption>
  <div class="viewport" style="width:${variant.width}px">
    <iframe title="${variant.label}" width="${variant.width}" height="640" style="width:${variant.width}px" srcdoc="${escapeAttr(doc)}"></iframe>
  </div>
  <p class="path">#xianshou/${variant.route}</p>
</figure>`;
}).join('\n');

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>先手协议控制台 · 响应式对照</title>
<style>
:root{--ink:#1c2430;--ink2:#3d4a5c;--ink3:#6b7889;--line:#e2ded6;--bg:#fbf9f5;--accent:#b45309}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:"Source Han Serif SC","Songti SC","Noto Serif CJK SC",Georgia,system-ui,sans-serif;line-height:1.7}
.wrap{max-width:1500px;margin:0 auto;padding:40px 28px 80px}
.kicker{font-family:ui-sans-serif,system-ui,sans-serif;font-size:11px;letter-spacing:.2em;text-transform:uppercase;
  color:var(--accent);font-weight:700}
h1{font-size:28px;margin:6px 0 10px;font-weight:700}
.lead{color:var(--ink2);max-width:760px;margin:0 0 8px;font-size:15px}
.meta{font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;color:var(--ink3);
  display:flex;flex-wrap:wrap;gap:6px 18px;margin:14px 0 30px}
.frames{display:flex;flex-direction:column;gap:26px}
.frame{margin:0;border:1px solid var(--line);background:#fff;border-radius:4px;overflow:hidden}
figcaption{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline;padding:12px 16px;border-bottom:1px solid var(--line);
  font-family:ui-sans-serif,system-ui,sans-serif;font-size:13px}
figcaption strong{font-weight:700}
figcaption span{color:var(--ink3);font-size:12px}
.viewport{overflow-x:auto;background:#f2efe9}
iframe{border:0;display:block;max-width:100%}
.path{margin:0;padding:8px 16px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:var(--ink3);
  border-top:1px solid var(--line);background:#faf8f4}
.note{margin-top:34px;padding:16px 20px;border-left:3px solid var(--accent);background:#fdf3e7;font-size:13.5px}
.note b{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">
  <div class="kicker">DeepSeek Harness · 客户端插件</div>
  <h1>先手协议控制台 · 响应式对照</h1>
  <p class="lead">六份真实渲染的面板，宽度分别固定为 1280 / 1024 / 900 / 768 / 560 / 375 px。内容与线上同一套代码，只是注入了示例事件；不是截图，也不是设计稿。</p>
  <div class="meta">
    <span>生成方式：<code>npm run preview</code></span>
    <span>槽位：sidebar.panellist + main</span>
    <span>断点：900 px（导航转横向）/ 560 px（卡片两列）</span>
    <span>最后一份为深色主题</span>
  </div>
  <div class="frames">
${frames}
  </div>
  <div class="note">
    <b>怎么看：</b>把窗口拖窄到 900 px 以下，导航会从左侧竖排变成顶部横排；560 px 以下卡片从三列退到两列、任务行改为纵向堆叠。
    所有尺寸下都不出现横向滚动条，也不出现被裁掉的按钮。
  </div>
</div>
</body>
</html>
`;

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'console-preview.html');
writeFileSync(target, page, 'utf8');
console.log(`已生成 ${target}（${VARIANTS.length} 个分辨率分栏）`);
