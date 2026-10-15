import type { Block } from '../../backend/src/mapping/contracts';
import { validListStructure, withListParent } from '../../backend/src/mapping/list-structure';
import { editableBlock } from '../../backend/src/mapping/general-blocks';

export function independentBlocks(blocks: Block[], parentId?: string): Block[] {
  const identities = new Map(blocks.map((block) => [block.id, crypto.randomUUID()]));
  return structuredClone(blocks).map((block) => ({
    ...(editableBlock(block)
      ? withListParent(
          block,
          typeof block.parentId === 'string' && identities.has(block.parentId)
            ? identities.get(block.parentId)
            : parentId,
        )
      : block),
    id: identities.get(block.id)!,
    ...(block.inlineId ? { inlineId: crypto.randomUUID() } : {}),
  }));
}
export async function writeBlocks(blocks: Block[]) {
  const text = blocks.map((block) => block.text ?? `[${block.type}]`).join('\n');
  const data = encodeURIComponent(
    JSON.stringify({ format: 'forkwise-body-blocks-v1', blocks }),
  );
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/plain': new Blob([text], { type: 'text/plain' }),
      'text/html': new Blob(
        [
          `<div data-forkwise-blocks="${data}">${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div>`,
        ],
        { type: 'text/html' },
      ),
    }),
  ]);
}
export function clipboardBlocks(html: string): Block[] | null {
  const encoded = html.match(/data-forkwise-blocks="([^"]+)"/)?.[1];
  if (!encoded) return null;
  const value = JSON.parse(decodeURIComponent(encoded));
  if (
    value.format !== 'forkwise-body-blocks-v1' ||
    !Array.isArray(value.blocks) ||
    !value.blocks.length ||
    !value.blocks.every(
      (b: Block) => b && typeof b.id === 'string' && typeof b.type === 'string',
    ) ||
    new Set(value.blocks.map((b: Block) => b.id)).size !== value.blocks.length
  )
    throw new Error('无效的块剪贴板');
  const blocks = independentBlocks(value.blocks);
  if (
    !validListStructure(
      blocks.map((b) => (editableBlock(b) ? b : { id: b.id, type: 'opaque' })),
    )
  )
    throw new Error('无效的块层级');
  return value.blocks;
}
