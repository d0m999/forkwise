import { blockPlainText } from './body-text.js';
import type { Block } from './contracts.js';
import { editableBlock } from './general-blocks.js';

export function organizeBlockText(block: Block): string {
  // 已有整理任务按段落的显式文字授权，旧段落可能还带有不参与整理的字段。
  if (block.type === 'text') return typeof block.text === 'string' && block.text.trim() ? block.text : '';
  if (!['heading', 'listItem', 'quote', 'code', 'table'].includes(block.type) || !editableBlock(block)) return '';
  const text = blockPlainText(block);
  return text.trim() ? text : '';
}
