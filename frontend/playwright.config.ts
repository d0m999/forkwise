import { defineConfig } from "@playwright/test";
// 系统剪贴板只在有真实窗口的 headed 运行里可读。默认 headless 只跑页面剪贴板四路径用例，
// AC5 系统剪贴板用例显式 skipped（不会用绿灯掩盖未执行的系统侧检查），也不产出 AC5 正式回执。
// 需要 AC5 系统侧证据时用 FORKWISE_SYSTEM_CLIPBOARD=1，此时只跑该 spec、以 headed 窗口执行，
// 由该用例产出 docs/plans/evidence/ 下的回执；原始载荷一律留在 backend/artifacts/。
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
          testMatch: /(canvas-cross-project-copy|canvas-cross-project-cut|canvas-cut)\.spec\.ts/,
          use: { headless: false },
        },
      ]
    : undefined,
  reporter: "list",
});
