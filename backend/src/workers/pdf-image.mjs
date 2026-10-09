import { parentPort, workerData } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
const root = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
let task;
try {
  task = getDocument({
    data: workerData.data,
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    standardFontDataUrl: join(root, 'standard_fonts') + '/',
    cMapUrl: join(root, 'cmaps') + '/',
    cMapPacked: true,
    wasmUrl: join(root, 'wasm') + '/',
    verbosity: 0,
  });
  const doc = await task.promise;
  if (workerData.page > doc.numPages) throw new Error('page out of range');
  const page = await doc.getPage(workerData.page),
    original = page.getViewport({ scale: 1 });
  const scale = Math.min(2, 2400 / Math.max(original.width, original.height)),
    viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width),
    height = Math.ceil(viewport.height);
  if (width * height > 6_000_000) throw new Error('page too large');
  const canvas = createCanvas(width, height),
    context = canvas.getContext('2d');
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  parentPort.postMessage({
    ok: true,
    result: {
      base64: canvas.toBuffer('image/png').toString('base64'),
      page: workerData.page,
      pageCount: doc.numPages,
      width,
      height,
    },
  });
} catch {
  parentPort.postMessage({ ok: false });
} finally {
  await task?.destroy();
}
