import { it, expect } from 'vitest';
import { parsePdf } from '../src/services/pdf-parser.js';
import { renderPdfPage } from '../src/services/pdf-image.js';

function pdf(lines: string[]) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${lines.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${lines.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  lines.forEach((line, i) => {
    const stream = `BT /F1 18 Tf 50 700 Td (${line}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  let text = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(text.length);
    text += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = text.length;
  text +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((o) => String(o).padStart(10, '0') + ' 00000 n \n')
      .join('');
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(text);
}
it('真实 PDF 字节在独立 worker 提取两页文本，字符锚点与页面坐标对应', async () => {
  const bytes = pdf(['Revenue 12', 'Cash 15']);
  const result = await parsePdf(bytes, new AbortController().signal);
  expect(result.status).toBe('complete');
  expect(result.pageCount).toBe(2);
  expect(result.regions.map((r) => result.text.slice(r.start, r.end))).toEqual([
    'Revenue 12',
    'Cash 15',
  ]);
  expect(result.regions.map((r) => r.page)).toEqual([1, 2]);
  expect(result.regions[0]?.bbox[0]).toBeCloseTo(50, 1);
  expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
}, 15_000);
it('真实 PDF 页图在独立 worker 生成为有尺寸的 PNG，错误页码明确失败', async () => {
  const image = await renderPdfPage(pdf(['Page one', 'Page two']), 2, new AbortController().signal);
  expect(image.page).toBe(2);
  expect(image.pageCount).toBe(2);
  expect(image.width).toBe(1224);
  expect(image.height).toBe(1584);
  expect(Buffer.from(image.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
  await expect(renderPdfPage(pdf(['One']), 2, new AbortController().signal)).rejects.toThrow(
    '此页不存在',
  );
}, 15_000);
it('页数受限明确部分完成，损坏文件或取消不报告完整读取', async () => {
  const result = await parsePdf(pdf(['One', 'Two']), new AbortController().signal, 1);
  expect(result.status).toBe('partial');
  expect(result.gaps.join('')).toContain('1/2');
  await expect(parsePdf(Buffer.from('not a pdf'), new AbortController().signal)).rejects.toThrow(
    '损坏',
  );
  const abort = new AbortController();
  abort.abort();
  expect(() => parsePdf(pdf(['One']), abort.signal)).toThrow();
}, 15_000);
