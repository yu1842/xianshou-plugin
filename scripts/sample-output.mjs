import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeHarness } from '../test/helpers/harness.mjs';

/**
 * 生成真实卡片样例
 *
 * 作用有两个：一是给用户看"装上之后到底长什么样"，
 * 二是让每张卡片都必须真的能渲染出来 —— 文档里的样例不是画的，是跑出来的。
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const harness = new FakeHarness();
const runtime = harness.mount({
  storage: { mode: 'memory' },
  gate: { mode: 'ask', tools: ['write'], requireTask: false },
  recall: { autoRemind: false, sweepMinutes: 0 },
});
await runtime.ready;
harness.addHostTool('write');

const blocks = [];
const push = (title, text) => {
  blocks.push(`### ${title}`, '', '```text', text, '```', '');
};

const start = await harness.dispatch('xianshou_start', {
  title: '重构订单模块',
  repeatable: true,
  within_competence: true,
  growth_relevant: true,
});
push('① 建档：判成红区，给出下一步', start.text);
const taskId = start.value.task_id;

const blocked = await harness.dispatch('write', { path: 'order.ts' });
push('② 闸门拦下一次工具调用（宿主会据此弹审批）', blocked.decision.reason ?? '');

const draft = await harness.dispatch('xianshou_draft', {
  task_id: taskId,
  content:
    '一、问题：订单与库存强耦合，任何改动都要同时改三处，回归面太大。\n' +
    '二、判断：因为库存扣减是外部契约，所以先做防腐层，把契约固定在适配器里。\n' +
    '三、路径：先拆领域模型，再迁移状态机，最后补集成测试。风险在迁移顺序。',
  minutes_spent: 23,
});
push('③ 落稿通过，闸门放行', draft.text);

await harness.dispatch('xianshou_mark', { task_id: taskId, segment_id: '引言的背景', tag: 'self', weight: 320 });
const marked = await harness.dispatch('xianshou_mark', { task_id: taskId, segment_id: '第四节 迁移方案', tag: 'ai', weight: 420 });
push('④ 标一段 [AI]，比例立刻变化', marked.text);

const audit = await harness.dispatch('xianshou_audit', { task_id: taskId });
push('⑤ 审计：> 60% 打回重做（状态真的被改了）', audit.text);

const rework = await harness.dispatch('xianshou_draft', {
  task_id: taskId,
  content:
    '重做版：\n一、先自己写迁移顺序的三个方案，并说明各自的前提。\n二、因为方案 B 的前提是"库存只有单一来源"，所以先验证这一条。\n三、结论：验证不通过就退回方案 A，风险边界写在这里。',
  minutes_spent: 26,
});
push('⑥ 重做先手，再次落稿', rework.text);

await harness.dispatch('xianshou_mark', { task_id: taskId, segment_id: '重做版提纲', tag: 'self', weight: 600 });
await harness.dispatch('xianshou_mark', { task_id: taskId, segment_id: '实现细节', tag: 'revised', weight: 300 });
const deliver = await harness.dispatch('xianshou_deliver', { task_id: taskId });
push('⑦ 交付：回收闸门已上膛', deliver.text);

harness.clock.advanceHours(25);
const recall = await harness.dispatch('xianshou_recall', {
  task_id: taskId,
  window: 'd24h',
  answers: ['核心是把风险前置到验证阶段，先证伪方案 B 的前提。', '最不确定的是库存多来源的边界。', '靠上周那次迁移失败的回滚记录。'],
  self_report: [2, 1, 1],
});
push('⑧ 回收测试：没到 80%，打回黄区', recall.text);

const refusal = await harness.dispatch('xianshou_refusal', {
  task_id: taskId,
  suggestion_id: 'sug-1',
  decision: 'rejected',
  note: '它建议直接改状态机，但我确认过库存契约不允许。',
});
push('⑨ 拒绝率面板', refusal.text);

const health = await harness.dispatch('xianshou_health', {});
push('⑩ 健康度：四个指标一起看', health.text);

const doc = [
  '# 卡片样式样例（真实渲染输出）',
  '',
  '> 本文件由 `npm run sample` 从插件真实执行路径生成，不是手绘。',
  '> 渲染目标为会话内 Markdown；配色与排版令牌见 `docs/ui-tokens.css`。',
  '',
  ...blocks,
].join('\n');

writeFileSync(join(root, 'docs', 'SAMPLE-OUTPUT.md'), `${doc}\n`, 'utf8');
console.log('已生成 docs/SAMPLE-OUTPUT.md');
