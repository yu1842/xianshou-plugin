/**
 * 版本协商 · 不依赖第三方 semver 包
 *
 * 为什么自己实现：插件的兼容判定是"加载前的第一道门"，它不能在宿主里
 * 引入额外的运行时依赖，也不该因为依赖包的解析差异导致同一个版本被两套规则判断。
 * 因此这里只实现 node-semver 中与本插件相关的子集，并对预发布版本做完整排序。
 */

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
  readonly raw: string;
}

export type Comparator = { readonly op: '>=' | '>' | '<=' | '<' | '='; readonly version: SemVer };

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemVer(raw: string): SemVer | null {
  const match = SEMVER_RE.exec(raw.trim());
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  const prerelease = pre
    ? pre.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease,
    raw: raw.trim(),
  };
}

export function formatSemVer(v: SemVer): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length === 0 ? base : `${base}-${v.prerelease.join('.')}`;
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  // 有预发布标识的版本低于同号正式版：1.0.0-rc.1 < 1.0.0
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNum = typeof left === 'number';
    const rightNum = typeof right === 'number';
    if (leftNum && rightNum) return (left as number) < (right as number) ? -1 : 1;
    // 数字标识符优先级低于字母标识符
    if (leftNum) return -1;
    if (rightNum) return 1;
    return (left as string) < (right as string) ? -1 : 1;
  }
  return 0;
}

/**
 * 解析范围表达式。支持：
 *   ">=0.2.1-rc.1 <0.3.0"、"^0.2.1"、"~0.2.1"、"0.2.1"、">=0.2.1-rc.1"、"a || b"
 */
export function parseRange(range: string): Comparator[][] {
  return range
    .split('||')
    .map((alt) => alt.trim())
    .filter((alt) => alt.length > 0)
    .map((alt) => parseAlternative(alt));
}

function parseAlternative(alt: string): Comparator[] {
  // 一次性匹配"操作符 + 版本"，而不是按空白切分：
  // 否则 ">=1.2.3 <2.0.0" 会被切成 [">=", "1.2.3", "<", "2.0.0"]，前两段无法单独解析。
  const pattern = /(\^|~|>=|<=|>|<|=)?\s*([0-9][0-9A-Za-z.+-]*)/g;
  const out: Comparator[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(alt)) !== null) {
    const op = match[1] ?? '=';
    const versionText = match[2] ?? '';
    const v = parseSemVer(versionText);
    if (!v) throw new Error(`无法解析版本范围片段：${versionText}`);
    if (op === '^') {
      // node-semver 的 caret 对 0.x 是"锁 minor"：^0.2.1 上界是 0.3.0，不是 1.0.0。
      const upper =
        v.major > 0
          ? { ...v, major: v.major + 1, minor: 0, patch: 0, prerelease: [], raw: '' }
          : v.minor > 0
            ? { ...v, minor: v.minor + 1, patch: 0, prerelease: [], raw: '' }
            : { ...v, patch: v.patch + 1, prerelease: [], raw: '' };
      out.push({ op: '>=', version: v });
      out.push({ op: '<', version: upper });
    } else if (op === '~') {
      out.push({ op: '>=', version: v });
      out.push({ op: '<', version: { ...v, major: v.major, minor: v.minor + 1, patch: 0, prerelease: [], raw: '' } });
    } else {
      out.push({ op: op as Comparator['op'], version: v });
    }
  }
  if (out.length === 0) throw new Error(`无法解析版本范围：${alt}`);
  return out;
}

export function satisfies(version: string | SemVer, range: string): boolean {
  const v = typeof version === 'string' ? parseSemVer(version) : version;
  if (!v) return false;
  const alternatives = parseRange(range);
  return alternatives.some((comparators) => comparators.every((c) => testComparator(v, c)));
}

function testComparator(v: SemVer, c: Comparator): boolean {
  const order = compareSemVer(v, c.version);
  switch (c.op) {
    case '>=':
      return order >= 0;
    case '>':
      return order > 0;
    case '<=':
      return order <= 0;
    case '<':
      return order < 0;
    case '=':
      return order === 0;
  }
}

/** 判定宿主版本属于哪条产品线（用于选择适配器）：'0.2' / '0.3' / ... */
export function releaseLine(version: string): string {
  const v = parseSemVer(version);
  return v ? `${v.major}.${v.minor}` : 'unknown';
}

export function isPrerelease(version: string): boolean {
  const v = parseSemVer(version);
  return v !== null && v.prerelease.length > 0;
}
