import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/repositories/schema.ts',
  out: './drizzle',
});
