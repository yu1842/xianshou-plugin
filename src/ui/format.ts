/**
 * 展示层格式化
 *
 * 只做"给人看"的格式化。刻意不引入时区库：卡片显示的是用户本机本地时间，
 * 用 toLocaleString 就是最接近用户预期的结果；跨机器一致性由领域层的 ISO 字段保证。
 */

export function formatIso(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatRelative(iso: string, now: Date): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return iso;
  const diffHours = Math.round((target - now.getTime()) / 3600_000);
  if (Math.abs(diffHours) < 1) return '约 1 小时内';
  if (diffHours > 0) return `${diffHours} 小时后`;
  return `${Math.abs(diffHours)} 小时前`;
}
