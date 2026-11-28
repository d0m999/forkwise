import { defineConfig } from "@playwright/test";
// 默认 headless 路径使用浏览器内存剪贴板，三条系统剪贴板专项显式跳过。
// 系统侧用 FORKWISE_SYSTEM_CLIPBOARD=1 和 FORKWISE_CANVAS_CLIPBOARD_GUARD 的绝对路径。
// 专项在隔离工作区以真实窗口运行，默认串行并在首个失败后停止。
// 原值核对或恢复成功后才在 --output 下写回执。
const systemClipboard = process.env.FORKWISE_SYSTEM_CLIPBOARD === "1";
export default defineConfig({
  testDir: "./tests",
  workers: systemClipboard ? 1 : 2,
  maxFailures: systemClipboard ? 1 : 0,
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
          testMatch: /(canvas-cross-project-copy|canvas-cross-project-cut|canvas-cut)\.spec\.ts/,
          use: { headless: false },
        },
      ]
    : undefined,
  reporter: "list",
});
