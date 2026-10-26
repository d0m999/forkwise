import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('旧后端画布从独立包构建，入口资源和完整本地字体可用', () => {
  const backend = fileURLToPath(new URL('../', import.meta.url));
  execFileSync('npm', ['run', 'build:canvas'], { cwd: backend, timeout: 60000, stdio: 'pipe' });
  const output = join(backend, 'web/canvas');
  const html = readFileSync(join(output, 'index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map((match) => match[1]);
  expect(assets.length).toBeGreaterThan(0);
  for (const asset of assets) expect(existsSync(join(output, asset))).toBe(true);
  const fonts = join(backend, 'canvas/node_modules/@excalidraw/excalidraw/dist/prod/fonts');
  const files = readdirSync(fonts, { recursive: true }).filter((name) => name.endsWith('.woff2'));
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    expect(readFileSync(join(output, 'excalidraw/fonts', name))).toEqual(
      readFileSync(join(fonts, name)),
    );
  }
}, 65000);
