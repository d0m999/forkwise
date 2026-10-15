import type { Block } from '../../backend/src/mapping/contracts';
import { validListStructure, withListParent } from '../../backend/src/mapping/list-structure';
import { editableBlock } from '../../backend/src/mapping/general-blocks';

export function independentBlocks(
  blocks: Block[],
  parentId?: string,
  readonlyIds: string[] = [],
): Block[] {
  const identities = new Map(blocks.map((block) => [block.id, crypto.randomUUID()]));
  return structuredClone(blocks).map((block) => ({
    ...(editableBlock(block) && !readonlyIds.includes(block.id)
      ? withListParent(
          block,
          block.type === 'listItem'
            ? typeof block.parentId === 'string' && identities.has(block.parentId)
              ? identities.get(block.parentId)
              : parentId
            : undefined,
        )
      : block),
    id: identities.get(block.id)!,
    ...(block.inlineId ? { inlineId: crypto.randomUUID() } : {}),
  }));
}
export async function writeBlocks(blocks: Block[], readonlyIds: string[] = []) {
  const text = blocks.map((block) => block.text ?? `[${block.type}]`).join('\n');
  const data = encodeURIComponent(
    JSON.stringify({
      format: 'forkwise-body-blocks-v1',
      blocks,
      readonlyIds: readonlyIds.filter((id) => blocks.some((b) => b.id === id)),
    }),
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
export function clipboardBlocks(
  html: string,
): { blocks: Block[]; readonlyIds: string[] } | null {
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
  const readonlyIds: unknown = value.readonlyIds ?? [];
  if (
    !Array.isArray(readonlyIds) ||
    !readonlyIds.every(
      (id) => typeof id === 'string' && value.blocks.some((b: Block) => b.id === id),
    )
  )
    throw new Error('无效的原件范围');
  const blocks = independentBlocks(value.blocks, undefined, readonlyIds);
  if (
    !validListStructure(
      blocks.map((b, i) =>
        editableBlock(b) && !readonlyIds.includes(value.blocks[i].id)
          ? b
          : { id: b.id, type: 'opaque' },
      ),
    )
  )
    throw new Error('无效的块层级');
  return { blocks: value.blocks, readonlyIds };
}
