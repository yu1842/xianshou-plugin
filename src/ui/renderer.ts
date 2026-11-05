import type { CardModel, CardNode, ContentBlockModel } from './card.js';
import type { Theme } from './theme.js';

/**
 * 卡片渲染器
 *
 * 唯一职责：CardModel → 宿主可直接显示的内容块。所有排版规则（缩进、分隔线、
 * 计量条宽度、标签格式）集中在这里，视图类不允许自己拼字符串。
 *
 * 之所以用 Markdown 而不是结构化块：会话内渲染 Markdown 是宿主最稳定的能力，
 * 而自定义块形状随版本变动。文本永远是兼容的。
 */

export interface CardRenderer {
  render(card: CardModel): ContentBlockModel[];
  toText(card: CardModel): string;
}

const METER_WIDTH = 12;
const INDENT = '  ';

export class MarkdownCardRenderer implements CardRenderer {
  constructor(private readonly theme: Theme) {}

  render(card: CardModel): ContentBlockModel[] {
    return [{ type: 'text', text: this.toText(card) }];
  }

  toText(card: CardModel): string {
    const glyph = this.theme.tone(card.tone).glyph;
    const lines: string[] = [`${glyph} ${card.title}`];
    if (card.subtitle) lines.push(`${INDENT}${card.subtitle}`);
    lines.push('');

    for (const node of card.nodes) {
      lines.push(...this.#node(node));
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  }

  #node(node: CardNode): string[] {
    switch (node.kind) {
      case 'heading':
        return [`▸ ${node.text}`, ''];
      case 'label':
        return [`${node.text}`, ''];
      case 'paragraph':
        return [node.text, ''];
      case 'badge':
        return [`[${node.text}]`, ''];
      case 'kv':
        return [`${INDENT}${node.label}　${node.value}`];
      case 'meter': {
        const filled = Math.round(Math.min(1, Math.max(0, node.value)) * METER_WIDTH);
        const filledCells = '▓'.repeat(filled);
        const emptyCells = '░'.repeat(METER_WIDTH - filled);
        const percent = `${Math.round(node.value * 100)}%`;
        const caption = node.caption ? `　${node.caption}` : '';
        return [`${INDENT}${node.label}　${filledCells}${emptyCells} ${percent}${caption}`];
      }
      case 'list':
        return node.items.flatMap((item, index) => {
          const bullet = node.ordered ? `${index + 1}.` : '·';
          return [`${INDENT}${bullet} ${item}`];
        }).concat('');
      case 'callout': {
        const style = this.theme.tone(node.tone);
        const head = node.title ? `${style.glyph} ${node.title}　` : `${style.glyph} `;
        return [`${head}${node.text}`, ''];
      }
      case 'divider':
        return ['────', ''];
      case 'footnote':
        return [node.text];
    }
  }
}

/** 给日志/测试用的无排版渲染：不缩进、不带符号，只保留语义。 */
export class PlainCardRenderer implements CardRenderer {
  render(card: CardModel): ContentBlockModel[] {
    return [{ type: 'text', text: this.toText(card) }];
  }

  toText(card: CardModel): string {
    const parts: string[] = [card.title];
    if (card.subtitle) parts.push(card.subtitle);
    for (const node of card.nodes) {
      if ('text' in node && typeof node.text === 'string') parts.push(node.text);
      else if (node.kind === 'kv') parts.push(`${node.label}=${node.value}`);
      else if (node.kind === 'meter') parts.push(`${node.label}=${Math.round(node.value * 100)}%`);
      else if (node.kind === 'list') parts.push(node.items.join(' / '));
    }
    return parts.join(' | ');
  }
}
