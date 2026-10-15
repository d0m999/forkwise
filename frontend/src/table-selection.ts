import type { Block } from '../../backend/src/mapping/contracts';
import type { InlineMark, TableCell } from '../../backend/src/mapping/general-blocks';
import type { BlockPoint } from './general-block-dom';

export function cellBlock(table: Block, cell: string | undefined): Block | null {
  if (table.type !== 'table' || !cell) return null;
  const [row, column] = cell.split(',').map(Number);
  const value = (table.rows as TableCell[][])[row!]?.[column!];
  return value ? { id: table.id, type: 'text', ...value } : null;
}
export function withCell(table: Block, cell: string, value: Block): Block {
  const [row, column] = cell.split(',').map(Number);
  const rows = structuredClone(table.rows as TableCell[][]);
  rows[row!]![column!] = {
    text: value.text!,
    ...(value.marks ? { marks: value.marks as InlineMark[] } : {}),
  };
  return { ...table, rows };
}
export function sameCell(start: BlockPoint, end: BlockPoint): boolean {
  return start.blockId === end.blockId && start.cell === end.cell;
}
