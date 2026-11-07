import { defineConfig } from "@playwright/test";
// 系统剪贴板只在有真实窗口的 headed 运行里可读：默认 headless 运行仍跑该 spec，但跳过系统侧读取；
// 需要 AC5 的系统侧证据时用 FORKWISE_SYSTEM_CLIPBOARD=1，此时只跑该 spec 且以 headed 窗口执行。
const systemClipboard = process.env.FORKWISE_SYSTEM_CLIPBOARD === "1";
export default defineConfig({
  testDir: "./tests",
  workers: 2,
  timeout: 90000,
  expect: { timeout: 20000 },
  use: {
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
    viewport: { width: 1360, height: 900 },
  },
  projects: systemClipboard
    ? [
        {
          name: "system-clipboard",
          testMatch: /canvas-cross-project-copy\.spec\.ts/,
          use: { headless: false },
        },
      ]
    : undefined,
  reporter: "list",
});
