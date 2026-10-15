import type { Block } from '../../backend/src/mapping/contracts';
import type { TableCell } from '../../backend/src/mapping/general-blocks';

export function TableTools({
  table,
  cell,
  onChange,
  onParagraph,
}: {
  table: Block;
  cell: string;
  onChange: (table: Block, cell: string) => void;
  onParagraph: () => void;
}) {
  const rows = table.rows as TableCell[][];
  const [row = 0, column = 0] = cell.split(',').map(Number);
  return (
    <div
      className="table-tools"
      role="group"
      aria-label="表格操作"
      onMouseDown={(e) => {
        if (e.target instanceof HTMLButtonElement) e.preventDefault();
      }}
    >
      <span>
        {rows.length} 行 × {rows[0]!.length} 列 · 第 {row + 1} 行第 {column + 1} 列
      </span>
      <button
        type="button"
        onClick={() => {
          const next = structuredClone(rows);
          next.splice(
            row + 1,
            0,
            rows[0]!.map(() => ({ text: '' })),
          );
          onChange({ ...table, rows: next }, `${row + 1},${column}`);
        }}
      >
        在下方增加行
      </button>
      <button
        type="button"
        onClick={() => {
          const widths = [
            ...((table.columnWidths as number[] | undefined) ?? rows[0]!.map(() => 160)),
          ];
          widths.splice(column + 1, 0, 160);
          onChange(
            {
              ...table,
              rows: rows.map((r) => [
                ...r.slice(0, column + 1),
                { text: '' },
                ...r.slice(column + 1),
              ]),
              columnWidths: widths,
            },
            `${row},${column + 1}`,
          );
        }}
      >
        在右侧增加列
      </button>
      <button
        type="button"
        disabled={rows.length === 1}
        onClick={() =>
          onChange(
            { ...table, rows: rows.filter((_, i) => i !== row) },
            `${Math.min(row, rows.length - 2)},${column}`,
          )
        }
      >
        删除第 {row + 1} 行（{rows[0]!.length} 个单元格）
      </button>
      <button
        type="button"
        disabled={rows[0]!.length === 1}
        onClick={() =>
          onChange(
            {
              ...table,
              rows: rows.map((r) => r.filter((_, i) => i !== column)),
              ...(table.columnWidths
                ? {
                    columnWidths: (table.columnWidths as number[]).filter((_, i) => i !== column),
                  }
                : {}),
            },
            `${row},${Math.min(column, rows[0]!.length - 2)}`,
          )
        }
      >
        删除第 {column + 1} 列（{rows.length} 个单元格）
      </button>
      <button
        type="button"
        aria-pressed={!!table.header}
        onClick={() => onChange({ ...table, header: !table.header }, cell)}
      >
        首行表头
      </button>
      <form
        key={`${column}:${JSON.stringify(table.columnWidths)}`}
        onSubmit={(event) => {
          event.preventDefault();
          const width = Number(new FormData(event.currentTarget).get('width'));
          if (!Number.isFinite(width) || width < 48 || width > 2000) return;
          const widths = [
            ...((table.columnWidths as number[] | undefined) ?? rows[0]!.map(() => 160)),
          ];
          widths[column] = width;
          onChange({ ...table, columnWidths: widths }, cell);
        }}
      >
        <label>
          第 {column + 1} 列宽度{' '}
          <input
            aria-label={`第 ${column + 1} 列宽度`}
            name="width"
            type="number"
            min="48"
            max="2000"
            step="any"
            defaultValue={(table.columnWidths as number[] | undefined)?.[column] ?? 160}
          />
        </label>
        <button type="submit">应用列宽</button>
      </form>
      <button type="button" onClick={onParagraph}>
        在表格下方插入段落
      </button>
    </div>
  );
}
