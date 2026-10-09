import { parentPort, workerData } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

const packageRoot = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
let task;
try {
  task = getDocument({
    data: workerData.data,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    standardFontDataUrl: join(packageRoot, 'standard_fonts') + '/',
    cMapUrl: join(packageRoot, 'cmaps') + '/',
    cMapPacked: true,
    wasmUrl: join(packageRoot, 'wasm') + '/',
    stopAtErrors: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  let text = '';
  const pages = [],
    regions = [],
    gaps = [];
  for (let number = 1; number <= Math.min(doc.numPages, workerData.pageLimit); number++) {
    const page = await doc.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    let count = 0;
    try {
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || !item.str) continue;
        if (text && !text.endsWith('\n') && !text.endsWith(' ')) text += ' ';
        const start = text.length;
        text += item.str;
        if (text.length > 5_000_000)
          throw Object.assign(new Error('too large'), { name: 'TextLimit' });
        const matrix = Util.transform(viewport.transform, item.transform);
        const height = Math.max(1, Math.hypot(matrix[2], matrix[3]));
        const baseline = Math.max(1, Math.hypot(matrix[0], matrix[1]));
        const u = [matrix[0] / baseline, matrix[1] / baseline];
        const v = [matrix[2] / height, matrix[3] / height];
        const ascent = content.styles[item.fontName]?.ascent ?? 0.8;
        const descent = content.styles[item.fontName]?.descent ?? -0.2;
        const corners = [0, item.width].flatMap((w) =>
          [descent, ascent].map((h) => [
            matrix[4] + u[0] * w + v[0] * height * h,
            matrix[5] + u[1] * w + v[1] * height * h,
          ]),
        );
        const xs = corners.map((p) => p[0]),
          ys = corners.map((p) => p[1]);
        regions.push({
          start,
          end: text.length,
          page: number,
          bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          coordinateSystem: 'viewport-points',
          localization: 'text-layer-estimate',
        });
        count++;
        if (item.hasEOL) text += '\n';
      }
      pages.push({
        page: number,
        width: viewport.width,
        height: viewport.height,
        status: count ? 'text' : 'needs_ocr',
        message: count ? '' : '本页无可读文本层，需要对原页进行多模态转写',
      });
      if (!count) gaps.push(`第 ${number} 页需要 OCR`);
    } catch (error) {
      if (error.name === 'TextLimit') throw error;
      pages.push({
        page: number,
        width: viewport.width,
        height: viewport.height,
        status: 'failed',
        message: '此页文本层无法读取',
      });
      gaps.push(`第 ${number} 页文本提取失败`);
    } finally {
      page.cleanup();
    }
    text += '\n\f\n';
  }
  if (doc.numPages > workerData.pageLimit)
    gaps.push(`本次只处理 ${workerData.pageLimit}/${doc.numPages} 页，剩余页面未处理`);
  parentPort.postMessage({
    ok: true,
    result: {
      text,
      normalizerVersion: 'pdf-text@1',
      pageCount: doc.numPages,
      pages,
      regions,
      status: gaps.length ? 'partial' : 'complete',
      gaps,
    },
  });
} catch (error) {
  parentPort.postMessage({ ok: false, code: error.name ?? 'PDF_ERROR' });
} finally {
  await task?.destroy();
}
