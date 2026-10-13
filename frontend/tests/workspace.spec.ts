import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

let directory: string, server: ChildProcess, origin: string;
async function start() {
  server = spawn(process.execPath, ["dist/src/workspace-server.js"], {
    cwd: resolve("../backend"),
    env: {
      ...process.env,
      FORKWISE_DATA_DIR: directory,
      FORKWISE_PORT: new URL(origin).port,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 10000);
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`服务退出 ${code}`));
    });
    server.stdout!.on("data", (chunk) => {
      if (String(chunk).includes("开放工作台")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr!.on("data", (chunk) => process.stderr.write(chunk));
  });
}
async function stop() {
  if (server?.exitCode === null) {
    const ended = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await ended;
  }
}
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "forkwise-ui-"));
  const port = await new Promise<number>((resolve) => {
    const socket = createServer();
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address() as { port: number };
      socket.close(() => resolve(address.port));
    });
  });
  origin = `http://127.0.0.1:${port}`;
  await start();
});
test.afterAll(async () => {
  await stop();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
test("真实 React Flow 卡片经服务重启和新浏览器上下文保持项目、身份及正文", async ({
  page,
  browser,
}, testInfo) => {
  const external: string[] = [];
  page.on("request", (req) => {
    if (!req.url().startsWith(origin)) external.push(req.url());
  });
  await page.goto(origin);
  expect(
    (
      await page.request.post(origin + "/api/mapping/execute", {
        headers: { Origin: "https://outside.invalid" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("tab", { name: /未命名研究/ })).toBeVisible();
  await page.getByRole("button", { name: "重命名当前项目" }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("芯片研究");
  await page.getByRole("button", { name: "保存名称" }).click();
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 350, y: 240 } });
  await page.getByLabel("卡片标题", { exact: true }).fill("独立标题");
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "编辑正文" }).click();
  await page
    .getByLabel("卡片正文", { exact: true })
    .fill("正文第一行\n正文第二行，保持原文。");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const initial = await page.evaluate(async () => {
    const projects = await (await fetch("/api/mapping/projects")).json();
    return (await fetch("/api/mapping/projects/" + projects[0].id)).json();
  });
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.getByRole("tab", { name: /芯片研究/ }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("before-restart.png") });
  await stop();
  await start();
  // A new browser context has no localStorage, IndexedDB, cookies, or prototype archives.
  const context = await browser.newContext();
  const reopened = await context.newPage();
  await reopened.goto(origin);
  await reopened.getByRole("tab", { name: /芯片研究/ }).click();
  await expect(reopened.locator(".react-flow__node")).toContainText("独立标题");
  await reopened.getByRole("button", { name: "编辑正文" }).click();
  await expect(reopened.getByLabel("卡片正文")).toHaveValue(
    "正文第一行\n正文第二行，保持原文。",
  );
  const restored = await reopened.evaluate(
    async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
    initial.project.id,
  );
  expect(restored).toEqual(initial);
  expect(external).toEqual([]);
  await reopened.screenshot({ path: testInfo.outputPath("after-restart.png") });
  await testInfo.attach("persisted-state", {
    body: JSON.stringify(restored),
    contentType: "application/json",
  });
  await context.close();
});
test("项目创建失败保留当前项目，明确重试后只新增一次", async ({ page }) => {
  await page.goto(origin);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const tabs = await page.getByRole("tab").count();
  await page.route(
    "**/api/mapping/execute",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "测试服务暂时不可用" }),
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("测试服务暂时不可用");
  await expect(page.getByRole("tab")).toHaveCount(tabs);
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByRole("tab")).toHaveCount(tabs + 1);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
});
test("键盘建空卡后持续输入正文仍定期保存，不等到停止输入", async ({ page }) => {
  await page.goto(origin);
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("button", { name: "卡片", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "卡片", exact: true }).focus();
  await page.getByRole("button", { name: "卡片", exact: true }).press("Enter");
  await page.getByLabel("卡片标题", { exact: true }).press("Escape");
  await expect(
    page.getByRole("button", { name: "未命名卡片", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "编辑正文" }).click();
  const typing = page
    .getByLabel("卡片正文")
    .pressSequentially(
      "连续输入需要在尚未停顿时就保存到本机数据库，这段输入刻意保持足够长的时间。",
      { delay: 120 },
    );
  try {
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const id = new URLSearchParams(location.search).get("project");
            const state = await (
              await fetch("/api/mapping/projects/" + id)
            ).json();
            return state.cards[0].body.blocks[0].text.length;
          }),
        { timeout: 3300 },
      )
      .toBeGreaterThan(0);
  } finally {
    await typing;
  }
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
});
