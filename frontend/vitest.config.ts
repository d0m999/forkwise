import { defineConfig } from "vitest/config";

// Unit tests live beside the modules they cover. Playwright owns `tests/`.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
