import { copyFile, mkdir } from 'node:fs/promises';

// R2 and the formal application share one licensed source. Only distributable
// build output contains a copy, alongside its notices and license files.
const source = new URL('../../prototype/open-canvas-r2-20261011/vendor/', import.meta.url);
const output = new URL('../dist/search-vendor/', import.meta.url);
for (const file of [
  'opencc-t2cn.js',
  'LICENSE-opencc-js.txt',
  'LICENSE-opencc-data-Apache-2.0.txt',
  'THIRD_PARTY_LICENSES-opencc-js.md',
  'NOTICE-search.txt',
  'jieba/jieba_rs_wasm.js',
  'jieba/jieba_rs_wasm_bg.wasm',
  'jieba/LICENSE.txt',
]) {
  const destination = new URL(file, output);
  await mkdir(new URL('.', destination), { recursive: true });
  await copyFile(new URL(file, source), destination);
}
