import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, lstatSync } from "node:fs";
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
async function openWorkspace(page: Page) {
  const accessPath = join(directory, "local-access.json");
  expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  expect(lstatSync(accessPath).isFile()).toBe(true);
  expect(lstatSync(accessPath).mode & 0o777).toBe(0o600);
  // This credential belongs solely to this synthetic test's newly allocated directory.
  const access = JSON.parse(readFileSync(accessPath, "utf8"));
  await page.goto(access.url);
  await expect(page).not.toHaveURL(/#token=/);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
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
  // A separate caller can forge navigation headers but cannot acquire a session.
  const unauthenticated = await browser.newContext();
  const response = await unauthenticated.request.get(origin, {
    headers: { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate" },
  });
  expect(response.headers()["set-cookie"]).toBeUndefined();
  expect(
    (
      await unauthenticated.request.get(origin + "/api/mapping/projects")
    ).status(),
  ).toBe(401);
  expect(
    (
      await unauthenticated.request.post(origin + "/api/session", {
        headers: { Origin: origin, Authorization: "Bearer forged" },
      })
    ).status(),
  ).toBe(401);
  await unauthenticated.close();
  const external: string[] = [];
  page.on("request", (req) => {
    if (!req.url().startsWith(origin)) external.push(req.url());
  });
  await openWorkspace(page);
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
  await openWorkspace(reopened);
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
  await openWorkspace(page);
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
  await openWorkspace(page);
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "卡片", exact: true }),
  ).toBeEnabled();
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

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function newCard(page: Page) {
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "卡片", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "卡片", exact: true }).press("Enter");
  await page.getByLabel("卡片标题", { exact: true }).fill("初始标题");
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.getByRole("button", { name: "编辑正文" }).click();
  return new URL(page.url()).searchParams.get("project")!;
}

test("切项目等待连续三批输入的最新确认，第二批 ACK 不能放行切换", async ({
  page,
}) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const target = new URL(page.url()).searchParams.get("project")!;
  const source = await newCard(page);
  const a = gate(),
    ab = gate(),
    abc = gate();
  const seen = new Set<string>();
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "body.edit") return route.continue();
    const response = await route.fetch(); // Write really succeeds; only the ACK is delayed.
    const value = command.payload.text;
    seen.add(value);
    if (value === "A") await a.promise;
    if (value === "AB") await ab.promise;
    if (value === "ABC") await abc.promise;
    await route.fulfill({ response });
  });
  try {
    await page.getByLabel("卡片正文", { exact: true }).fill("A");
    await page
      .getByRole("tab")
      .filter({ has: page.locator(`small:text-is("${target.slice(0, 6)}")`) })
      .click();
    await expect.poll(() => seen.has("A")).toBe(true);
    await page.getByLabel("卡片正文", { exact: true }).fill("AB");
    a.release();
    await expect.poll(() => seen.has("AB")).toBe(true);
    await page.getByLabel("卡片正文", { exact: true }).fill("ABC");
    ab.release();
    await expect
      .poll(
        () =>
          seen.has("ABC") ||
          new URL(page.url()).searchParams.get("project") === target,
      )
      .toBe(true);
    expect(new URL(page.url()).searchParams.get("project")).toBe(source);
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue(
      "ABC",
    );
    abc.release();
    await expect(page).toHaveURL(new RegExp(`project=${target}`));
    const persisted = await page.evaluate(
      async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
      source,
    );
    expect(persisted.cards[0].body.blocks[0].text).toBe("ABC");
  } finally {
    a.release();
    ab.release();
    abc.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("标题成功 ACK 在途时继续改标题并转到已开正文，两字段最新输入均持久保存", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  await page.getByRole("button", { name: "初始标题", exact: true }).click();
  const ack = gate();
  let written = false;
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (
      command.type === "thought.title" &&
      command.payload.title === "标题 A"
    ) {
      const response = await route.fetch();
      written = true;
      await ack.promise;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await page.getByLabel("卡片标题", { exact: true }).fill("标题 A");
    await expect.poll(() => written).toBe(true);
    await page.getByLabel("卡片标题", { exact: true }).fill("标题 AB 应当保留");
    await page.getByLabel("卡片正文", { exact: true }).fill("正文也需要保存");
    ack.release();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const persisted = await page.evaluate(
      async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
      projectId,
    );
    expect(persisted.cards[0].title).toBe("标题 AB 应当保留");
    expect(persisted.cards[0].body.blocks[0].text).toBe("正文也需要保存");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "标题 AB 应当保留", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "编辑正文" }).click();
    await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue(
      "正文也需要保存",
    );
    await page.screenshot({
      path: testInfo.outputPath("both-fields-reopened.png"),
    });
  } finally {
    ack.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("等待目标项目读取时仍接收正文输入，完成保存后才交接项目", async ({
  page,
}) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const target = new URL(page.url()).searchParams.get("project")!;
  const source = await newCard(page);
  const loaded = gate();
  let reading = false;
  await page.route(`**/api/mapping/projects/${target}`, async (route) => {
    const response = await route.fetch();
    reading = true;
    await loaded.promise;
    await route.fulfill({ response });
  });
  try {
    await page
      .getByRole("tab")
      .filter({ has: page.locator(`small:text-is("${target.slice(0, 6)}")`) })
      .click();
    await expect.poll(() => reading).toBe(true);
    await page.getByLabel("卡片正文", { exact: true }).fill("交接前的最后输入");
    loaded.release();
    await expect(page).toHaveURL(new RegExp(`project=${target}`));
    const persisted = await page.evaluate(
      async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
      source,
    );
    expect(persisted.cards[0].body.blocks[0].text).toBe("交接前的最后输入");
  } finally {
    loaded.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
