import type { TaskSnapshot } from '../domain/task.js';
import type { HealthReportBuilder } from '../domain/health.js';
import { pct } from '../domain/ledger.js';
import { windowLabel } from '../domain/recall.js';

/**
 * Markdown 报表
 *
 * 定位：可外发、可存档的一份"账"。因此有三个刻意设计：
 *  1. 指标在前，明细在后 —— 报表是给不熟悉机制的人看的，先给结论
 *  2. 每个数字都带口径 —— 只给比例不给含义，读者会自行误读
 *  3. 末尾附校验值 —— 归档文件可以被修改，凭据让"这份报表没被改过"可验证
 */

const ZONE_LABEL: Record<string, string> = { red: '红区（必须先手）', yellow: '黄区（可先问）', green: '绿区（放开用）' };
const STATUS_LABEL: Record<string, string> = { open: '进行中', delivered: '已交付', rework: '需重做' };

export interface ReportOptions {
  readonly generatedAt: Date;
  readonly pluginVersion: string;
  readonly checksum: string;
  readonly health: ReturnType<HealthReportBuilder['build']>;
}

export function buildMarkdownReport(tasks: readonly TaskSnapshot[], options: ReportOptions): string {
  const { health } = options;
  const byZone = { red: 0, yellow: 0, green: 0 } as Record<string, number>;
  for (const task of tasks) byZone[task.zone] = (byZone[task.zone] ?? 0) + 1;

  const lines: string[] = [];
  lines.push('# 先手协议 · 认知债报表');
  lines.push('');
  lines.push(`生成时间：${formatTime(options.generatedAt.toISOString())}`);
  lines.push(`覆盖任务：${tasks.length} 个（红 ${byZone['red'] ?? 0} / 黄 ${byZone['yellow'] ?? 0} / 绿 ${byZone['green'] ?? 0}）`);
  lines.push(`插件版本：${options.pluginVersion}`);
  lines.push('');
  lines.push('> 这份报表描述的是"你用 AI 的方式"，不是"你产出了多少"。');
  lines.push('> 指标口径见文末；阈值为工程取值，需按场景校准。');
  lines.push('');

  lines.push('## 一、四个指标');
  lines.push('');
  lines.push('| 指标 | 当前 | 目标 | 判定 |');
  lines.push('| --- | --- | --- | --- |');
  for (const metric of health.metrics) {
    lines.push(`| ${metric.label} | ${metric.display} | ${metric.target} | ${bandLabel(metric.band)} |`);
  }
  lines.push('');
  if (health.topConcern) {
    lines.push(`**最需要处理的一项**：${health.topConcern}`);
    lines.push('');
  }

  lines.push('## 二、任务明细');
  lines.push('');
  if (tasks.length === 0) {
    lines.push('_还没有任何任务。_');
    lines.push('');
  }
  for (const task of tasks) {
    const tally = tallyOf(task);
    const band = tally.total === 0 ? '未留痕' : tally.aiRatio > 0.6 ? '需重做' : tally.aiRatio >= 0.3 ? '需回收' : '正常';
    lines.push(`### ${task.title} · \`${task.id}\``);
    lines.push('');
    lines.push(`- 分区：${ZONE_LABEL[task.zone] ?? task.zone}`);
    lines.push(`- 状态：${STATUS_LABEL[task.status] ?? task.status}`);
    lines.push(
      `- 先手稿：${task.draft === null ? '未落稿' : `${[...task.draft.content].length} 字 / ${task.draft.minutesSpent} 分钟`}`,
    );
    lines.push(
      `- [AI] 占比：${tally.total === 0 ? '未留痕' : `${pct(tally.aiRatio)}（[自] ${pct(tally.selfRatio)}）→ ${band}`}`,
    );
    lines.push(`- 回收：${recallLine(task)}`);
    lines.push(`- 拒绝：采纳 ${task.refusals.filter((r) => r.decision === 'accepted').length} / 否决 ${task.refusals.filter((r) => r.decision === 'rejected').length} / 部分 ${task.refusals.filter((r) => r.decision === 'partial').length}`);
    lines.push(`- 最近更新：${formatTime(task.updatedAt)}`);
    lines.push('');
  }

  lines.push('## 三、任务一览');
  lines.push('');
  lines.push('| 任务 | 分区 | 状态 | [AI] | 回收 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const task of tasks) {
    const tally = tallyOf(task);
    lines.push(
      `| ${escapeCell(task.title)} | ${task.zone} | ${STATUS_LABEL[task.status] ?? task.status} | ${tally.total === 0 ? '—' : pct(tally.aiRatio)} | ${recallShort(task)} |`,
    );
  }
  lines.push('');

  lines.push('## 四、可验证凭据');
  lines.push('');
  lines.push('```');
  lines.push(`sha256(archive.json) = ${options.checksum}`);
  lines.push('```');
  lines.push('');
  lines.push('校验方式：对同名的 `.json` 备份文件计算 SHA-256，应与此值一致。不一致说明文件被改过。');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('指标口径：复述测记忆，首版自主率测建构参与，拒绝率测判断力，迁移率测能力是否沉淀成资产。');
  lines.push('阈值（20 分钟、30%/60%、15%–40%）为工程取值，不是实验结果。');
  lines.push('');

  return lines.join('\n');
}

function tallyOf(task: TaskSnapshot): { self: number; ai: number; revised: number; total: number; aiRatio: number; selfRatio: number } {
  const sums = { self: 0, ai: 0, revised: 0 };
  for (const segment of task.segments) sums[segment.tag] += segment.weight;
  const total = sums.self + sums.ai + sums.revised;
  return {
    ...sums,
    total,
    aiRatio: total === 0 ? 0 : sums.ai / total,
    selfRatio: total === 0 ? 0 : sums.self / total,
  };
}

function recallLine(task: TaskSnapshot): string {
  if (task.gates.length === 0) return '未生成（未交付）';
  return task.gates
    .map((gate) => {
      const attempt = task.recalls.find((r) => r.window === gate.window);
      if (!attempt) return `${windowLabel(gate.window)} 未答`;
      return `${windowLabel(gate.window)} ${pct(attempt.score)}（${attempt.verdict === 'pass' ? '通过' : '未通过'}）`;
    })
    .join(' / ');
}

function recallShort(task: TaskSnapshot): string {
  if (task.gates.length === 0) return '—';
  const answered = task.recalls.length;
  return `${answered}/${task.gates.length} 已答`;
}

function bandLabel(band: string): string {
  if (band === 'good') return '达标';
  if (band === 'warn') return '需注意';
  if (band === 'bad') return '危险';
  return '样本不足';
}

function escapeCell(value: string): string {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
