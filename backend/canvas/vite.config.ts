import { cpSync, readFile } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const fontDirectory = fileURLToPath(
  new URL('./node_modules/@excalidraw/excalidraw/dist/prod/fonts', import.meta.url),
);

export default defineConfig({
  base: './',
  build: { outDir: '../web/canvas', emptyOutDir: true },
  server: { host: '127.0.0.1' },
  plugins: [
    {
      name: 'local-excalidraw-fonts',
      configureServer(server) {
        server.middlewares.use('/excalidraw/fonts', (request, response, next) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') return next();
          let path;
          try {
            path = decodeURIComponent((request.url ?? '/').split('?')[0]);
            if (path.includes('\0')) throw new Error('无效字体路径');
          } catch {
            response.statusCode = 400;
            response.end();
            return;
          }
          const target = resolve(fontDirectory, '.' + path);
          if (!target.startsWith(fontDirectory + sep) || extname(target) !== '.woff2') {
            response.statusCode = 404;
            response.end();
            return;
          }
          readFile(target, (error, contents) => {
            if (error) {
              response.statusCode = 404;
              response.end();
              return;
            }
            response.setHeader('Content-Type', 'font/woff2');
            response.setHeader('Content-Length', contents.length);
            response.setHeader('Cache-Control', 'no-cache');
            response.end(request.method === 'HEAD' ? undefined : contents);
          });
        });
      },
      writeBundle() {
        cpSync(
          fontDirectory,
          fileURLToPath(new URL('../web/canvas/excalidraw/fonts/', import.meta.url)),
          { recursive: true },
        );
      },
    },
  ],
});
