import { blockPlainText } from './body-text.js';
import type { Block } from './contracts.js';
import { unsupportedBlockIds } from './general-blocks.js';

export function organizeTextBlocks(blocks: Block[]) {
  const unsupported = unsupportedBlockIds(blocks);
  return blocks.flatMap(block => {
    // 旧文字段落的显式文字字段沿用既有授权，其余块按编辑器的完整正文结构识别。
    if (block.type !== 'text' &&
      (!['heading', 'listItem', 'quote', 'code', 'table'].includes(block.type) || unsupported.has(block.id))) return [];
    const text = blockPlainText(block);
    return text.trim() ? [{ id: block.id, type: block.type, text }] : [];
  });
}
