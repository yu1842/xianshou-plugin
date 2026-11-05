/**
 * UI 设计令牌 · 唯一真源
 *
 * 取值直接继承《先手协议》HTML 方案的版式语言（墨色正文 + 赭石强调 + 青灰辅色），
 * 目的是让插件卡片和用户已经看过的方案文档在视觉上是同一套东西。
 *
 * 约束：tokens 里不出现具体组件的语义（如 "卡片边框"），只出现可复用的原子；
 * 组件语义在 primitives 里组合，避免令牌表膨胀成样式垃圾场。
 */

export type ThemeName = 'light' | 'dark';

export interface Palette {
  readonly bg: string;
  readonly paper: string;
  readonly line: string;
  readonly lineStrong: string;
  readonly ink: string;
  readonly ink2: string;
  readonly ink3: string;
  readonly accent: string;
  readonly accentSoft: string;
  readonly teal: string;
  readonly tealSoft: string;
  readonly danger: string;
  readonly dangerSoft: string;
  readonly success: string;
  readonly successSoft: string;
}

export const PALETTE: Readonly<Record<ThemeName, Palette>> = Object.freeze({
  light: {
    bg: '#fbf9f5',
    paper: '#ffffff',
    line: '#e2ded6',
    lineStrong: '#1c2430',
    ink: '#1c2430',
    ink2: '#3d4a5c',
    ink3: '#6b7889',
    accent: '#b45309',
    accentSoft: '#fdf3e7',
    teal: '#0f766e',
    tealSoft: '#eef7f5',
    danger: '#b91c1c',
    dangerSoft: '#fdf0ef',
    success: '#166534',
    successSoft: '#f0f7f1',
  },
  dark: {
    bg: '#14181d',
    paper: '#1b2129',
    line: '#2c3540',
    lineStrong: '#e8eaed',
    ink: '#e8eaed',
    ink2: '#b3bcc7',
    ink3: '#7d8896',
    accent: '#e0a061',
    accentSoft: '#2a2118',
    teal: '#5cbcb1',
    tealSoft: '#16292a',
    danger: '#e2706f',
    dangerSoft: '#2c1b1b',
    success: '#74b98a',
    successSoft: '#17251b',
  },
});

export const TYPOGRAPHY = Object.freeze({
  reading: '"Source Han Serif SC","Songti SC","Noto Serif CJK SC",Georgia,serif',
  label: 'ui-sans-serif,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
  mono: 'ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace',
  scale: Object.freeze({ display: 22, title: 17, body: 15, label: 12, caption: 11 }),
  lineHeight: Object.freeze({ reading: 1.75, compact: 1.45 }),
  tracking: Object.freeze({ label: '0.12em', body: '0.01em' }),
});

export const SPACING = Object.freeze({ xxs: 2, xs: 4, sm: 8, md: 12, lg: 18, xl: 26 });
export const RADIUS = Object.freeze({ none: 0, sm: 2, md: 4, pill: 999 });
export const BORDER = Object.freeze({ hair: 1, rule: 2, accent: 4 });

/** 语义色映射：组件只说 tone，不直接说颜色。 */
export type ToneKey = 'neutral' | 'accent' | 'teal' | 'danger' | 'success';

export interface ToneStyle {
  readonly fg: string;
  readonly bg: string;
  readonly border: string;
  /** 文本场景的前缀符号，保证在纯文本/终端里也能区分（无色可用时）。 */
  readonly glyph: string;
}

export function toneStyle(theme: ThemeName, tone: ToneKey): ToneStyle {
  const p = PALETTE[theme];
  switch (tone) {
    case 'accent':
      return { fg: p.accent, bg: p.accentSoft, border: p.accent, glyph: '◆' };
    case 'teal':
      return { fg: p.teal, bg: p.tealSoft, border: p.teal, glyph: '◇' };
    case 'danger':
      return { fg: p.danger, bg: p.dangerSoft, border: p.danger, glyph: '▲' };
    case 'success':
      return { fg: p.success, bg: p.successSoft, border: p.success, glyph: '✓' };
    case 'neutral':
      return { fg: p.ink2, bg: p.paper, border: p.line, glyph: '·' };
  }
}

export function tokensToCss(theme: ThemeName): string {
  const p = PALETTE[theme];
  return Object.entries(p)
    .map(([key, value]) => `  --xs-${kebab(key)}: ${value};`)
    .join('\n');
}

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([a-zA-Z])([0-9])/g, '$1-$2').toLowerCase();
}

/**
 * 生成可交付的 CSS 变量文件（docs/ui-tokens.css）
 *
 * 令牌是唯一真源，CSS 是派生物 —— 因此这个函数既被构建脚本使用，
 * 也被测试用来断言"交付出去的 CSS 与令牌没有漂移"。
 */
export function tokensCssDocument(): string {
  const block = (theme: ThemeName, selector: string): string => {
    const p = PALETTE[theme];
    const lines = Object.entries(p).map(([key, value]) => `  --xs-${kebab(key)}: ${value};`);
    lines.push(`  --xs-font-reading: ${TYPOGRAPHY.reading};`);
    lines.push(`  --xs-font-label: ${TYPOGRAPHY.label};`);
    lines.push(`  --xs-font-mono: ${TYPOGRAPHY.mono};`);
    lines.push(`  --xs-space-md: ${SPACING.md}px;`);
    lines.push(`  --xs-radius-md: ${RADIUS.md}px;`);
    return `${selector} {\n${lines.join('\n')}\n}`;
  };
  return [
    '/* 本文件由 src/ui/tokens.ts 生成，请勿手工编辑。 */',
    '/* 生成命令：npm run tokens */',
    '',
    block('light', ':root,\n:root[data-theme="light"]'),
    '',
    block('dark', ':root[data-theme="dark"]'),
    '',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) {',
    ...Object.entries(PALETTE.dark).map(([key, value]) => `    --xs-${kebab(key)}: ${value};`),
    '  }',
    '}',
    '',
  ].join('\n');
}
