/**
 * 兼容性支持矩阵 · 单一真源
 *
 * 三个层级必须分清，否则"兼容"会变成一句营销话：
 *   contract-verified —— 在本仓库的契约测试矩阵里，以模拟宿主逐条跑过
 *                        （挂载 / 卸载 / 放行 / 拦截 / 取消 / 持久化 / 降级 / UI 纯函数性）
 *   declared          —— 版本落在 engines.dsh 范围内，且该产品线无破坏性变更证据；
 *                        允许加载，但只跑"最小冒烟"集
 *   provisional       —— 超出已声明的产品线，必须由用户显式放行才加载
 *
 * 注意：contract-verified 不等于"在真实宿主上人工跑过"。
 * 真实宿主的 smoke 清单见 docs/COMPATIBILITY.md §4，需要在装有 DSH 的机器上执行。
 */

export type SupportTier = 'contract-verified' | 'declared' | 'provisional';

export interface SupportEntry {
  /** 版本或版本前缀，如 "0.2.1-rc.1"、"0.2.2"（前缀匹配到该 minor 线）。 */
  readonly version: string;
  readonly tier: SupportTier;
  readonly note: string;
}

export const SUPPORT_MATRIX: readonly SupportEntry[] = Object.freeze([
  { version: '0.2.1-rc.1', tier: 'contract-verified', note: '基线版本；engines.dsh 下界，五个工具接缝全部可用' },
  { version: '0.2.1-rc.2', tier: 'contract-verified', note: '同为 0.2.1 线，接缝与 rc.1 一致' },
  { version: '0.2.1-rc.3', tier: 'contract-verified', note: '同为 0.2.1 线' },
  { version: '0.2.1-rc.4', tier: 'contract-verified', note: '同为 0.2.1 线' },
  { version: '0.2.1-rc.5', tier: 'contract-verified', note: '0.2.1 线最后一个 rc' },
  { version: '0.2.2-alpha.2', tier: 'declared', note: '预发布；接口未见破坏性变更，但 alpha 不承诺稳定' },
  { version: '0.2.2-alpha.3', tier: 'declared', note: '预发布；同上' },
  { version: '0.2.2-rc.1', tier: 'contract-verified', note: '0.2.2 线 rc；接缝与 0.2.1 一致' },
  { version: '0.2.2', tier: 'declared', note: '正式版尚未发布；发布后按 0.2.2-rc.1 的结论外推，需补一次真机冒烟' },
  { version: '0.2.x', tier: 'declared', note: '0.2 产品线后续补丁版本；保持 engines.dsh 范围' },
  { version: '0.3.x', tier: 'provisional', note: '超出声明范围；需 compat.allowUnverified=true 且只启用核心能力' },
]);

/** 判定顺序：精确匹配 → minor 线匹配 → 产品线通配。 */
export function lookupTier(version: string): SupportTier {
  const exact = SUPPORT_MATRIX.find((e) => e.version === version);
  if (exact) return exact.tier;
  const line = version.split('.').slice(0, 2).join('.');
  const lineEntry = SUPPORT_MATRIX.find((e) => e.version === line);
  if (lineEntry) return lineEntry.tier;
  const wildcard = SUPPORT_MATRIX.find((e) => e.version === `${version.split('.')[0]}.x`);
  if (wildcard) return wildcard.tier;
  return 'provisional';
}

export function lookupNote(version: string): string {
  const exact = SUPPORT_MATRIX.find((e) => e.version === version);
  if (exact) return exact.note;
  const line = version.split('.').slice(0, 2).join('.');
  return SUPPORT_MATRIX.find((e) => e.version === line || e.version === `${version.split('.')[0]}.x`)?.note ?? '未在支持矩阵中登记。';
}
