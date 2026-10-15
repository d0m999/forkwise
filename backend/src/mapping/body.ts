import type { Block, Card } from './contracts.js';
import { requireThat } from '../domain/errors.js';
import { canonical } from '../domain/canonical.js';

import { plainParagraph } from './body-text.js';
import { editableBlock, unsupportedBlockIds } from './general-blocks.js';
import { validListStructure } from './list-structure.js';
import type Database from 'better-sqlite3';

export function requireBlockOwnership(
  db: Database.Database,
  body: Card['body'],
  blocks: Block[],
) {
  const ids = new Set(blocks.map((b) => b.id));
  const inlineIds = new Map(blocks.filter((b) => b.inlineId).map((b) => [b.inlineId!, b.id]));
  // Immutable versions retain ownership even after deletion/merge and after a
  // block has left the 40-step history. This is a read, not a data migration.
  const rows = db
    .prepare("SELECT id,value FROM mapping_versions WHERE domain='body'")
    .all() as {
    id: string;
    value: string;
  }[];
  for (const row of rows) {
    const previous = JSON.parse(row.value) as Card['body'];
    for (const block of previous.blocks) {
      requireThat(
        row.id === body.id || !ids.has(block.id),
        'BLOCK_ID_CONFLICT',
        '正文块身份已归属另一正文',
        409,
      );
      if (block.inlineId && inlineIds.has(block.inlineId))
        requireThat(
          row.id === body.id && inlineIds.get(block.inlineId) === block.id,
          'BLOCK_ID_CONFLICT',
          '行内身份已归属另一正文块',
          409,
        );
    }
  }
  for (const block of blocks) {
    const previous = body.blocks.find((b) => b.id === block.id);
    if (previous?.inlineId)
      requireThat(
        block.inlineId === previous.inlineId,
        'BLOCK_ID_CONFLICT',
        '既有行内身份须保持稳定',
        409,
      );
  }
}

export function editedBlocks(
  body: Card['body'],
  payload: { text?: string | undefined; blocks?: Block[] | undefined },
  copySources: Block[] = [],
): Block[] {
  if (payload.blocks === undefined) {
    requireThat(
      body.blocks.length === 1 && plainParagraph(body.blocks[0]!),
      'BODY_FORMAT_UNSUPPORTED',
      '此正文须使用完整块编辑，原文已保留',
      409,
    );
    return [{ ...body.blocks[0]!, text: payload.text! }];
  }
  const blocks = structuredClone(payload.blocks);
  const originalIds = unsupportedBlockIds(body.blocks);
  const nextUnsupported = unsupportedBlockIds(blocks);
  const copiedOriginals = new Set(
    blocks
      .filter(
        (block) =>
          !body.blocks.some((old) => old.id === block.id) &&
          nextUnsupported.has(block.id) &&
          copySources.some((source) => sameOriginalContent(source, block)),
      )
      .map((block) => block.id),
  );
  requireThat(
    validListStructure(
      blocks.map((block) =>
        editableBlock(block) && !originalIds.has(block.id) && !copiedOriginals.has(block.id)
          ? block
          : { id: block.id, type: 'opaque' },
      ),
    ),
    'INVALID_LIST_STRUCTURE',
    '列表父项必须在前且后代连续，不能置入自身后代',
    409,
  );
  const ids = new Set<string>(),
    inlineIds = new Set<string>();
  for (const block of blocks) {
    requireThat(!ids.has(block.id), 'BLOCK_ID_CONFLICT', '正文块身份重复', 409);
    ids.add(block.id);
    if (block.inlineId) {
      requireThat(!inlineIds.has(block.inlineId), 'BLOCK_ID_CONFLICT', '正文行内身份重复', 409);
      inlineIds.add(block.inlineId);
    }
    const previous = body.blocks.find((b) => b.id === block.id);
    if (previous?.type === 'divider')
      requireThat(
        block.type === 'divider',
        'BODY_FORMAT_UNSUPPORTED',
        '分隔线不支持文字转换',
        409,
      );
    if (!editableBlock(block) || originalIds.has(block.id) || copiedOriginals.has(block.id))
      requireThat(
        (previous && canonical(previous) === canonical(block)) || copiedOriginals.has(block.id),
        'BODY_FORMAT_UNSUPPORTED',
        '尚不支持的内容须保留原件',
        409,
      );
  }
  for (const block of body.blocks)
    if (originalIds.has(block.id))
      requireThat(
        nextUnsupported.has(block.id) &&
          blocks.some((b) => b.id === block.id && canonical(b) === canonical(block)),
        'BODY_FORMAT_UNSUPPORTED',
        '尚不支持的内容原件不能删除或降级',
        409,
      );
  const originals = body.blocks
    .filter((block) => originalIds.has(block.id))
    .map((block) => block.id);
  requireThat(
    canonical(blocks.filter((block) => originalIds.has(block.id)).map((block) => block.id)) ===
      canonical(originals),
    'BODY_FORMAT_UNSUPPORTED',
    '尚不支持的内容须保留原顺序',
    409,
  );
  return blocks;
}

function sameOriginalContent(a: Block, b: Block): boolean {
  const content = ({ id, inlineId, ...rest }: Block) => rest;
  return canonical(content(a)) === canonical(content(b));
}

// New opaque identities may only reproduce original JSON already held by this
// project. Editing/deleting/reordering its existing originals remains forbidden.
export function originalCopySources(
  db: Database.Database,
  projectId: string,
  body: Card['body'],
  blocks?: Block[],
): Block[] {
  if (!blocks) return [];
  const unsupported = unsupportedBlockIds(blocks);
  if (!blocks.some((b) => unsupported.has(b.id) && !body.blocks.some((old) => old.id === b.id)))
    return [];
  const rows = db
    .prepare("SELECT value FROM mapping_versions WHERE project_id=? AND domain='body'")
    .all(projectId) as { value: string }[];
  return rows.flatMap((row) => (JSON.parse(row.value) as Card['body']).blocks);
}

export function bodyContentUnchanged(before: Block[], after: Block[]): boolean {
  return (
    canonical(before) === canonical(after) ||
    (before.length === after.length &&
      before.every((b, i) => {
        const next = after[i]!;
        return (
          plainParagraph(b) &&
          plainParagraph(next) &&
          b.id === next.id &&
          b.text === next.text &&
          (b.inlineId === undefined || b.inlineId === next.inlineId)
        );
      }))
  );
}
