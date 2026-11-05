import { PALETTE, type Palette, type ThemeName, type ToneKey, toneStyle } from './tokens.js';

/**
 * 主题解析
 *
 * 三种模式：light / dark / auto。auto 跟随宿主，宿主不可知时退回浅色
 * （与《先手协议》方案文档的默认纸色一致，避免用户第一次打开就"变黑"）。
 */

export type ThemePreference = 'light' | 'dark' | 'auto';

export class Theme {
  constructor(readonly name: ThemeName) {}

  get palette(): Palette {
    return PALETTE[this.name];
  }

  tone(tone: ToneKey) {
    return toneStyle(this.name, tone);
  }

  get isDark(): boolean {
    return this.name === 'dark';
  }
}

export interface ThemeHostHint {
  /** 宿主报告的界面主题；未知时为 undefined。 */
  readonly prefersDark?: boolean | undefined;
}

export class ThemeResolver {
  constructor(private readonly preference: ThemePreference = 'auto') {}

  resolve(hint: ThemeHostHint = {}): Theme {
    const pref = this.preference;
    if (pref === 'light') return new Theme('light');
    if (pref === 'dark') return new Theme('dark');
    return new Theme(hint.prefersDark === true ? 'dark' : 'light');
  }
}
