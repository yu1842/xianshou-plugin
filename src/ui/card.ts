/**
 * UI 层 · 卡片中间表示（Card IR）
 *
 * 为什么不直接产出宿主的 ContentBlock？
 * 因为宿主的内容模型是 pre-stable 的（0.2.x 明确标注），一旦它改字段，
 * 我们希望只有 renderer 一处要改，而不是每个工具里散落的字符串拼接。
 *
 * 这一层的另一个收益是：同一份卡片可以渲染成 Markdown（会话内）、
 * 纯文本（日志/测试断言）、或 DOM（未来的 Web 面板），而不改业务代码。
 */

export type CardTone = 'neutral' | 'accent' | 'teal' | 'danger' | 'success';

export type CardNode =
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'label'; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'badge'; readonly text: string; readonly tone: CardTone }
  | { readonly kind: 'kv'; readonly label: string; readonly value: string; readonly tone?: CardTone }
  | { readonly kind: 'meter'; readonly label: string; readonly value: number; readonly tone: CardTone; readonly caption?: string }
  | { readonly kind: 'list'; readonly items: readonly string[]; readonly tone?: CardTone; readonly ordered?: boolean }
  | { readonly kind: 'callout'; readonly tone: CardTone; readonly text: string; readonly title?: string }
  /**
   * 原样可抄的片段（工具调用、配置片段、命令）。
   * 教程类内容必须用它而不是段落：一段带反引号的散文，抄下来十次要错八次。
   */
  | { readonly kind: 'code'; readonly text: string; readonly language?: string }
  | { readonly kind: 'divider' }
  | { readonly kind: 'footnote'; readonly text: string };

export interface CardModel {
  readonly tone: CardTone;
  readonly title: string;
  readonly subtitle?: string;
  readonly nodes: readonly CardNode[];
}

/** 宿主内容块的最小投影。刻意只支持 text：结构信息保留在 CardModel 里。 */
export interface ContentBlockModel {
  readonly type: 'text';
  readonly text: string;
}

export function card(tone: CardTone, title: string, nodes: readonly CardNode[], subtitle?: string): CardModel {
  return subtitle === undefined ? { tone, title, nodes } : { tone, title, subtitle, nodes };
}
