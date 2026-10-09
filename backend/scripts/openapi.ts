import { writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { createApplication } from '../src/app.js';

const app = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
try {
  const spec = app.app.getOpenAPIDocument({
    openapi: '3.0.0',
    info: { title: '见岔（Forkwise）本机研究 API', version: '0.1.0' },
    security: [{ LocalSession: [] }],
  });
  writeFileSync(new URL('../openapi.yaml', import.meta.url), stringify(spec));
} finally {
  app.db.close();
}
