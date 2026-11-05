import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const client = require('../client/client.cjs');
const { ConsolePage, MODULES } = client.__internals;

const h = React.createElement;

const EVENTS = [
  { type: 'xianshou/domain-event', payload: { type: 'task.created', taskId: 'xs-1', zone: 'red', title: '重构订单模块' } },
  { type: 'xianshou/domain-event', payload: { type: 'draft.accepted', taskId: 'xs-1', chars: 132 } },
  { type: 'xianshou/domain-event', payload: { type: 'segment.marked', taskId: 'xs-1', tag: 'ai', aiRatio: 0.62 } },
  {
    type: 'xianshou/domain-event',
    payload: {
      type: 'task.delivered',
      taskId: 'xs-1',
      gates: [
        { window: 'd24h', scheduledFor: '2026-11-06T09:00:00Z' },
        { window: 'd7d', scheduledFor: '2026-11-12T09:00:00Z' },
      ],
    },
  },
  { type: 'xianshou/domain-event', payload: { type: 'task.created', taskId: 'xs-2', zone: 'green', title: '翻译一段话' } },
  { type: 'xianshou/gate-denied', payload: { taskId: 'xs-1', tool: 'write' } },
];

function render(props = {}) {
  return renderToStaticMarkup(h(ConsolePage, { feedOptions: { initialEvents: EVENTS }, ...props }));
}

test('渲染：面板骨架包含标题、八个模块入口与页脚状态', () => {
  const html = render();
  assert.match(html, /先手协议/);
  assert.match(html, /aria-label="先手协议模块"/);
  for (const module of MODULES) {
    assert.ok(html.includes(module.label), `缺少模块入口：${module.label}`);
  }
  assert.match(html, /class="xs-foot"/);
  assert.match(html, /v0\.2\.0/);
});

test('渲染：概览页展示真实计数，不使用占位数字', () => {
  const html = render({ initialRoute: { module: 'overview', id: null, query: {} } });
  assert.match(html, /红区任务/);
  assert.match(html, /待回收/);
  assert.match(html, /平均 \[AI\] 占比/);
  // 62% 来自事件流，说明数字确实是从数据推导出来的
  assert.match(html, /62%/);
  // 有 2 个待回收窗口
  assert.match(html, />2<\/div>/);
});

test('渲染：数据源未连接时给明确说明，且不出现示例任务', () => {
  const html = renderToStaticMarkup(h(ConsolePage, { feedOptions: { initialEvents: [] }, initialRoute: { module: 'overview' } }));
  assert.match(html, /数据源未连接/);
  assert.ok(!html.includes('重构订单模块'), '不得用示例数据填充');
});

test('渲染：无权限时只渲染拒绝态，不泄露模块内容', () => {
  const html = render({ accessOptions: { access: 'deny' } });
  assert.match(html, /你没有查看这个面板的权限/);
  assert.ok(!html.includes('任务台账'), '拒绝态不应渲染导航与模块');
  assert.ok(!html.includes('重构订单模块'));
});

test('渲染：任务台账按分区筛选，未选中的任务不出现', () => {
  const html = render({
    initialRoute: { module: 'tasks', id: null, query: { zone: 'green' } },
  });
  assert.match(html, /翻译一段话/);
  assert.ok(!html.includes('重构订单模块'), '绿区筛选下不应出现红区任务');
  assert.match(html, /aria-pressed="true"/);
});

test('渲染：选中任务后展开详情，包含分区、先手稿与回收窗口', () => {
  const html = render({ initialRoute: { module: 'tasks', id: 'xs-1', query: {} } });
  assert.match(html, /xs-1/);
  assert.match(html, /红区 · 必须先手/);
  assert.match(html, /已落稿/);
  assert.match(html, /24 小时 \/ 7 天/);
  assert.match(html, /aria-selected="true"/);
});

test('渲染：留痕页把 62% 判为"需重做"，并给出阈值表', () => {
  const html = render({ initialRoute: { module: 'ledger', id: 'xs-1', query: {} } });
  assert.match(html, /需重做/);
  assert.match(html, /&gt; 60%/);
  assert.match(html, /打回红区重做/);
  assert.match(html, /xs-meter-fill/);
});

test('渲染：回收页列出三个具体问题，而不是"来复习一下"', () => {
  const html = render({ initialRoute: { module: 'recalls', id: 'xs-1', query: {} } });
  assert.match(html, /这个结论的核心逻辑是什么/);
  assert.match(html, /我最不确定的是哪一点/);
  assert.match(html, /如果对方反问，我靠什么回答/);
  assert.match(html, /24 小时回收/);
  assert.ok(!/来复习一下/.test(html));
});

test('渲染：只读权限下写按钮被禁用，且 title 说明原因', () => {
  const readOnly = render({ initialRoute: { module: 'recalls', id: 'xs-1', query: {} } });
  assert.match(readOnly, /disabled=""/);
  assert.match(readOnly, /写操作需要 xianshou\.operate|暂存/);

  const operable = render({
    accessOptions: { access: 'operate' },
    initialRoute: { module: 'recalls', id: 'xs-1', query: {} },
  });
  assert.ok(!/disabled=""[^>]*>暂存这次回收/.test(operable), '有操作权限时不应禁用');
});

test('渲染：设置页展示诊断信息，可复制', () => {
  const html = render({ initialRoute: { module: 'settings', id: null, query: {} } });
  assert.match(html, /复制诊断信息/);
  assert.match(html, /访问级别/);
  assert.match(html, /数据源/);
  assert.match(html, /当前路由/);
});

test('渲染：闸门页显示当前会被拦下的任务与最近记录', () => {
  const html = render({ initialRoute: { module: 'gate', id: null, query: {} } });
  assert.match(html, /拦截模式/);
  assert.match(html, /advisory/);
  assert.match(html, /已拒绝/);
});

test('渲染：拒绝率样本不足时不给百分比，也不画计量条', () => {
  const html = render({ initialRoute: { module: 'refusal', id: null, query: {} } });
  assert.match(html, /还没有记录过采纳或否决|样本不足/);
  assert.ok(!html.includes('xs-meter-fill'), '样本不足时不应出现计量条');
});

test('渲染：健康度四项指标齐全，缺数据时写"样本不足"', () => {
  const html = render({ initialRoute: { module: 'health', id: null, query: {} } });
  assert.match(html, /无提示复述准确率/);
  assert.match(html, /首版自主率/);
  assert.match(html, /拒绝率/);
  assert.match(html, /跨任务迁移率/);
  assert.match(html, /样本不足/);
  assert.match(html, /不给总分/);
});

test('渲染：空数据状态下每个模块都不崩（逐页冒烟）', () => {
  for (const module of MODULES) {
    const html = renderToStaticMarkup(
      h(ConsolePage, { feedOptions: { initialEvents: [] }, initialRoute: { module: module.id, id: null, query: {} } }),
    );
    assert.ok(html.length > 200, `${module.id} 渲染结果过短`);
    assert.ok(!html.includes('NaN'), `${module.id} 出现 NaN`);
    assert.ok(!html.includes('undefined'), `${module.id} 出现 undefined`);
  }
});

test('渲染：有数据时每个模块也不出现 NaN / undefined', () => {
  for (const module of MODULES) {
    const html = render({ initialRoute: { module: module.id, id: module.id === 'ledger' || module.id === 'recalls' ? 'xs-1' : null, query: {} } });
    assert.ok(!html.includes('NaN'), `${module.id} 出现 NaN`);
    assert.ok(!html.includes('undefined'), `${module.id} 出现 undefined`);
  }
});
