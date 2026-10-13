import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import type { Card } from "../src/api";
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

test("创建回读乱序不能回退已保存正文，后续编辑继续成功", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.fill("旧正文");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const oldRead = gate();
  let captured = false;
  let first = true;
  await page.route(`**/api/mapping/projects/${projectId}`, async (route) => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    captured = true;
    await oldRead.promise;
    await route.fulfill({ response });
  });
  const read = () =>
    page.evaluate(
      async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
      projectId,
    );
  try {
    await page
      .getByRole("button", { name: "卡片", exact: true })
      .press("Enter");
    await expect.poll(() => captured).toBe(true);
    await body.fill("已保存的新正文");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const before = await read();
    expect(before.cards[0].body.blocks[0].text).toBe("已保存的新正文");
    oldRead.release();
    // The new card's title editor appears only after the create action finishes its readback.
    await expect(page.getByLabel("卡片标题", { exact: true })).toBeVisible();
    const after = await read();
    expect(after.cards[0].body.blocks[0].text).toBe("已保存的新正文");
    expect(await body.inputValue()).toBe("已保存的新正文");
    await body.fill("回读乱序后继续输入");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect((await read()).cards[0].body.blocks[0].text).toBe(
      "回读乱序后继续输入",
    );
    await page.screenshot({
      path: testInfo.outputPath("reordered-read-continued-edit.png"),
    });
  } finally {
    oldRead.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("创建回读到达时保留未确认正文的最新草稿，继续输入后正常保存", async ({
  page,
}) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.fill("旧正文");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const oldRead = gate(),
    bodyAck = gate();
  let captured = false,
    written = false,
    first = true;
  await page.route(`**/api/mapping/projects/${projectId}`, async (route) => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    captured = true;
    await oldRead.promise;
    await route.fulfill({ response });
  });
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "body.edit" || command.payload.text !== "正文 A")
      return route.continue();
    const response = await route.fetch();
    written = true;
    await bodyAck.promise;
    await route.fulfill({ response });
  });
  try {
    await page
      .getByRole("button", { name: "卡片", exact: true })
      .press("Enter");
    await expect.poll(() => captured).toBe(true);
    await body.fill("正文 A");
    await expect.poll(() => written).toBe(true);
    await body.fill("尚未确认的正文 AB");
    oldRead.release();
    // Seeing the second card proves that the refresh reached the real rendered UI.
    // The body ACK is still held, so this is not a wait-until-saved workaround.
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(body).toHaveValue("尚未确认的正文 AB");
    await body.press("End");
    await body.pressSequentially("C");
    await expect(body).toHaveValue("尚未确认的正文 ABC");
    bodyAck.release();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await expect(page.getByRole("alert")).toHaveCount(0);
    const persisted = await page.evaluate(
      async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
      projectId,
    );
    expect(persisted.cards[0].body.blocks[0].text).toBe("尚未确认的正文 ABC");
  } finally {
    oldRead.release();
    bodyAck.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("正文请求在途仍可真实拖动，旧正文确认不覆盖布局或后续输入，重开保持", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const read = () =>
    page.evaluate(
      async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
      projectId,
    );
  const before = await read();
  const pending = gate();
  let sending = false;
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === "body.edit" && command.payload.text === "正在写正文") {
      sending = true;
      await pending.promise;
    }
    await route.continue();
  });
  try {
    await page.getByLabel("卡片正文", { exact: true }).fill("正在写正文");
    await expect.poll(() => sending).toBe(true);
    const box = (await page.locator(".thought-card").boundingBox())!;
    await page.mouse.move(box.x + box.width - 15, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 95, box.y + 92, { steps: 12 });
    await page.mouse.up();
    // React Flow starts its drag offset after the activation threshold. Verify
    // the actual visible world position, not an assumed pointer delta.
    const moved = await page.locator(".react-flow__node").evaluate((node) => {
      const matrix = new DOMMatrix(getComputedStyle(node).transform);
      return { x: matrix.m41, y: matrix.m42 };
    });
    expect(moved.y).toBeGreaterThan(before.cards[0].item.pose.y + 60);
    // The visible drag is immediate; its persistent write waits for prior input.
    expect((await read()).cards[0].item.pose).toEqual(
      before.cards[0].item.pose,
    );
    await expect(page.locator(".react-flow__node")).toHaveCSS(
      "transform",
      `matrix(1, 0, 0, 1, ${moved.x}, ${moved.y})`,
    );
    await page
      .getByLabel("卡片正文", { exact: true })
      .fill("正在写正文，继续输入");
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    pending.release();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const after = await read();
    expect(after.cards[0].body.blocks[0].text).toBe("正在写正文，继续输入");
    expect(after.cards[0].item.pose).toMatchObject(moved);
    expect(moved.x).toBeLessThan(before.cards[0].item.pose.x - 60);
    await page.reload();
    await page.getByRole("button", { name: "编辑正文" }).click();
    await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue(
      "正在写正文，继续输入",
    );
    expect((await read()).cards[0]).toEqual(after.cards[0]);
    await page.screenshot({
      path: testInfo.outputPath("body-pose-reopened.png"),
    });
  } finally {
    pending.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("布局回读不替换正文草稿的起始版本，同正文冲突保留双方并明确重试", async ({
  page,
}) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const body = page.getByLabel("卡片正文", { exact: true });
  const before = await page.evaluate(
    async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
    projectId,
  );
  // Synthetic composition events test save coordination; this is not a real IME test.
  await body.dispatchEvent("compositionstart");
  await body.fill("我的待保存正文");
  const external = await page.evaluate(async (id) => {
    const state = await (await fetch("/api/mapping/projects/" + id)).json();
    const card = state.cards[0];
    const response = await fetch("/api/mapping/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        projectId: id,
        type: "body.edit",
        expected: card.body.versionId,
        payload: { id: card.id, text: "另一个调用者的正文" },
      }),
    });
    return { ok: response.ok, version: card.body.versionId };
  }, projectId);
  expect(external.ok).toBe(true);
  await page
    .getByRole("button", { name: "移动卡片：方向键调整位置" })
    .press("ArrowRight");
  await expect(page.locator(".react-flow__node")).toHaveCSS(
    "transform",
    `matrix(1, 0, 0, 1, ${before.cards[0].item.pose.x + 10}, ${before.cards[0].item.pose.y})`,
  );
  expect(
    (
      await page.evaluate(
        async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
        projectId,
      )
    ).cards[0].item.pose,
  ).toEqual(before.cards[0].item.pose);
  await body.dispatchEvent("compositionend");
  await expect(page.getByRole("alert")).toContainText("正文已更新");
  await expect(body).toHaveValue("我的待保存正文");
  await expect(page.getByLabel("已保存的正文")).toHaveValue(
    "另一个调用者的正文",
  );
  await page.getByRole("button", { name: "确认保留我的正文" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const current = await page.evaluate(
    async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
    projectId,
  );
  expect(current.cards[0].body.blocks[0].text).toBe("我的待保存正文");
  expect(current.cards[0].item.pose.x).toBe(before.cards[0].item.pose.x + 10);
  await page.reload();
  await page.getByRole("button", { name: "编辑正文" }).click();
  await expect(body).toHaveValue("我的待保存正文");
});

test("布局竞争显式确认再保存；丢失布局 ACK 重试一次生效且正文继续可写", async ({
  page,
}) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const read = () =>
    page.evaluate(
      async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
      projectId,
    );
  const before = (await read()).cards[0];
  await page.evaluate(
    async ({ id, card }) => {
      await fetch("/api/mapping/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          projectId: id,
          type: "pose.move",
          expected: card.item.versionId,
          payload: { id: card.id, x: 100, y: 100 },
        }),
      });
    },
    { id: projectId, card: before },
  );
  await page
    .getByRole("button", { name: "移动卡片：方向键调整位置" })
    .press("ArrowRight");
  await expect(page.getByRole("alert")).toContainText("布局已更新");
  await expect(page.getByText("已保存位置：100, 100")).toBeVisible();
  await page.getByRole("button", { name: "确认保留本次位置" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect((await read()).cards[0].item.pose.x).toBe(before.item.pose.x + 10);
  let lost = false;
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type === "pose.move" && !lost) {
      await route.fetch();
      lost = true;
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "移动卡片：方向键调整位置" })
    .press("ArrowDown");
  await expect(page.getByRole("alert")).toBeVisible();
  const moved = await read();
  await page
    .getByLabel("卡片正文", { exact: true })
    .fill("布局失败时继续写正文");
  await expect
    .poll(async () => (await read()).cards[0].body.blocks[0].text)
    .toBe("布局失败时继续写正文");
  await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const after = await read();
  expect(after.cards[0].item).toEqual(moved.cards[0].item);
  expect(after.project.revision).toBe(moved.project.revision + 1);
});

for (const field of ["body", "title"] as const) {
  for (const updatedAgain of [false, true]) {
    test(`冲突确认实际保存改回原值的${field}${updatedAgain ? "，再次更新仍须重新确认" : "并重开"}`, async ({
      page,
    }, testInfo) => {
      await openWorkspace(page);
      const projectId = await newCard(page);
      const label = field === "body" ? "正文" : "标题";
      const original = field === "body" ? "原文A" : "初始标题";
      if (field === "title") {
        await page.getByRole("button", { name: original, exact: true }).click();
      }
      const input = page.getByLabel(`卡片${label}`, { exact: true });
      if (field === "body") {
        await input.fill(original);
        await expect(page.getByRole("status")).toHaveText("已保存到本机");
      }
      const read = () =>
        page.evaluate(
          async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
          projectId,
        );
      const value = (card: Card) =>
        field === "body" ? card.body.blocks[0]!.text : card.title;
      const externalSave = (text: string) =>
        page.evaluate(
          async ({ id, field, text }) => {
            const state = await (
              await fetch("/api/mapping/projects/" + id)
            ).json();
            const card = state.cards[0];
            const response = await fetch("/api/mapping/execute", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                commandId: crypto.randomUUID(),
                projectId: id,
                type: field === "body" ? "body.edit" : "thought.title",
                expected:
                  field === "body" ? card.body.versionId : card.versionId,
                payload: {
                  id: card.id,
                  [field === "body" ? "text" : "title"]: text,
                },
              }),
            });
            return response.ok;
          },
          { id: projectId, field, text },
        );
      // Synthetic composition pauses debounce only; it is not a real IME test.
      await input.dispatchEvent("compositionstart");
      await input.fill("我的草稿B");
      expect(await externalSave("外部保存C")).toBe(true);
      await input.dispatchEvent("compositionend");
      await expect(page.getByLabel(`已保存的${label}`)).toHaveValue(
        "外部保存C",
      );
      const remote = (await read()).cards[0];
      await input.fill(original);
      if (updatedAgain) expect(await externalSave("再次保存D")).toBe(true);
      const commands: { expected: string }[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          request.url().endsWith("/api/mapping/execute")
        ) {
          commands.push(request.postDataJSON());
        }
      });
      await page.getByRole("button", { name: `确认保留我的${label}` }).click();
      await page.screenshot({
        path: testInfo.outputPath("after-confirmation.png"),
      });
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]!.expected).toBe(
        field === "body" ? remote.body.versionId : remote.versionId,
      );
      if (updatedAgain) {
        await expect(page.getByLabel(`已保存的${label}`)).toHaveValue(
          "再次保存D",
        );
        expect(value((await read()).cards[0])).toBe("再次保存D");
        if (field === "body") await expect(input).toHaveValue(original);
        else
          await expect(
            page.getByRole("button", { name: original, exact: true }),
          ).toBeVisible();
        await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
        await page
          .getByRole("button", { name: `确认保留我的${label}` })
          .click();
        await expect.poll(() => commands.length).toBe(2);
      }
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
      expect(value((await read()).cards[0])).toBe(original);
      await page.reload();
      if (field === "body")
        await page.getByRole("button", { name: "编辑正文" }).click();
      else
        await page.getByRole("button", { name: original, exact: true }).click();
      await expect(input).toHaveValue(original);
      expect(value((await read()).cards[0])).toBe(original);
      await page.screenshot({
        path: testInfo.outputPath("reopened-choice.png"),
      });
    });
  }
}

test("H4 创建与首次标题一次撤销，空卡和完整标题重做经服务重启保留", async ({
  page,
}) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.getByRole("button", { name: "卡片", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("卡片标题", { exact: true }).fill("库存观察");
  await page.getByLabel("卡片标题", { exact: true }).press("Escape");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await stop();
  await start();
  await openWorkspace(page);
  await page.getByRole("tab").last().click();
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toContainText("库存观察");
  await page.getByRole("button", { name: "库存观察", exact: true }).click();
  await page.getByLabel("卡片标题", { exact: true }).fill("需求观察");
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".react-flow__node")).toContainText("库存观察");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
});
async function historyState(page: Page) {
  return page.evaluate(async () => {
    const id = document
      .querySelector("[role=tab][aria-selected=true]")!
      .getAttribute("title");
    return (await fetch(`/api/mapping/projects/${id}/history`)).json();
  });
}
async function historyCard(page: Page, title = "历史卡") {
  await expect(
    page.getByRole("button", { name: "卡片", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "卡片", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("卡片标题", { exact: true }).fill(title);
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
}
test("H4 连续正文跨两秒落盘仍一步撤销，停顿和选区改变分组", async ({
  page,
}) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await historyCard(page);
  await page.getByRole("button", { name: "编辑正文" }).click();
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.pressSequentially("abcdefghi", { delay: 310 });
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect((await historyState(page)).undo).toHaveLength(2);
  await body.press("Meta+z");
  await expect(body).toHaveValue("");
  await body.press("Meta+Shift+z");
  await expect(body).toHaveValue("abcdefghi");
  await body.press("End");
  await body.pressSequentially("j");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  // The next edit changes selection and must not merge, even inside one save batch.
  await body.press("Home");
  await body.pressSequentially("X");
  await body.press("Meta+z");
  await expect(body).toHaveValue("abcdefghij");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
});
test("H4 编辑中标题只走文本撤销，synthetic composition 不触发项目撤销", async ({
  page,
}) => {
  await openWorkspace(page);
  await newCard(page);
  await page.getByRole("button", { name: "初始标题", exact: true }).click();
  const title = page.getByLabel("卡片标题", { exact: true });
  await title.press("End");
  await title.pressSequentially("AB");
  await title.press("ArrowLeft");
  await title.press("ArrowRight");
  await title.pressSequentially("C");
  await title.press("Meta+z");
  await expect(title).toHaveValue("初始标题AB");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  const before = await historyState(page);
  await title.dispatchEvent("compositionstart");
  await title.dispatchEvent("keydown", {
    key: "z",
    code: "KeyZ",
    metaKey: true,
    isComposing: true,
  });
  await title.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  await expect(title).toBeVisible();
  expect(await historyState(page)).toEqual(before);
  await title.dispatchEvent("compositionend");
  await title.press("Escape");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".react-flow__node")).toContainText("初始标题");
});
test("H4 跨卡撤销提示实际目标，保留当前正文面板及项目独立历史", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  await page.getByRole("button", { name: "关闭正文" }).click();
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 120, y: 200 } });
  await page.getByLabel("卡片标题", { exact: true }).fill("当前卡B");
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "当前卡B" })
    .getByRole("button", { name: "编辑正文" })
    .click();
  await page.evaluate(async (id) => {
    const s = await (await fetch("/api/mapping/projects/" + id)).json();
    const card = s.cards[0];
    await fetch("/api/mapping/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        projectId: id,
        type: "body.edit",
        expected: card.body.versionId,
        payload: { id: card.id, text: "另一调用者编辑A" },
      }),
    });
  }, projectId);
  await page.getByLabel("卡片正文", { exact: true }).press("Meta+z");
  await expect(page.locator(".history-notice")).toHaveText("已撤销：初始标题");
  await expect(page.locator(".body-editor h2")).toHaveText("当前卡B");
  await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue("");
  const originalHistory = await historyState(page);
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await historyCard(page, "独立项目卡");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.locator(`[role=tab][title="${projectId}"]`).click();
  await expect(
    page.locator(`[role=tab][title="${projectId}"]`),
  ).toHaveAttribute("aria-selected", "true");
  expect(await historyState(page)).toEqual(originalHistory);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(
    page.locator(".react-flow__node").filter({ hasText: "初始标题" }),
  ).toContainText("另一调用者编辑A");
  await page.screenshot({
    path: testInfo.outputPath("history-cross-card.png"),
  });
});
test("H4 在途正文确认后才撤销且不复活，布局待确认按同一时间线撤销", async ({
  page,
}) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const body = page.getByLabel("卡片正文", { exact: true });
  const ack = gate();
  let written = false;
  let historyRequests = 0;
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type.startsWith("history.")) historyRequests++;
    if (command.type !== "body.edit") return route.continue();
    const response = await route.fetch();
    written = true;
    await ack.promise;
    await route.fulfill({ response });
  });
  try {
    await body.fill("等待确认的正文");
    await expect.poll(() => written).toBe(true);
    await body.press("Meta+z");
    await expect(body).toHaveAttribute("readonly", "");
    expect(historyRequests).toBe(0);
    ack.release();
    await expect(body).toHaveValue("");
    await expect(body).not.toHaveAttribute("readonly", "");
    expect(historyRequests).toBe(1);
    expect((await historyState(page)).redo).toHaveLength(1);
  } finally {
    ack.release();
    await page.unrouteAll({ behavior: "wait" });
  }
  const moveAck = gate();
  let moved = false;
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type !== "pose.move")
      return route.continue();
    const response = await route.fetch();
    moved = true;
    await moveAck.promise;
    await route.fulfill({ response });
  });
  const node = page.locator(".react-flow__node");
  const original = await node.getAttribute("style");
  try {
    await page
      .getByRole("button", { name: "移动卡片：方向键调整位置" })
      .press("ArrowRight");
    await expect.poll(() => moved).toBe(true);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    moveAck.release();
    await expect(
      page.getByRole("button", { name: "撤销", exact: true }),
    ).toBeEnabled();
    await expect(node).toHaveAttribute("style", original!);
    const s = await page.evaluate(
      async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
      projectId,
    );
    expect(s.cards[0].body.blocks[0].text).toBe("");
  } finally {
    moveAck.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
test("H4 撤销确认在途时阻止跨项目和新建写入，丢ACK只重试原动作", async ({
  page,
}) => {
  await openWorkspace(page);
  await newCard(page);
  const ack = gate();
  let applied = false;
  let first = true;
  await page.route("**/api/mapping/execute", async (route) => {
    const c = route.request().postDataJSON();
    if (c.type !== "history.undo" || !first) return route.continue();
    first = false;
    await route.fetch();
    applied = true;
    await ack.promise;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "测试丢失撤销确认" }),
    });
  });
  try {
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(() => applied).toBe(true);
    await expect(
      page.getByRole("button", { name: "新建研究", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "卡片", exact: true }),
    ).toBeDisabled();
    ack.release();
    await expect(page.getByRole("alert")).toHaveText("测试丢失撤销确认");
    await expect(
      page.getByRole("button", { name: "新建研究", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    expect((await historyState(page)).redo).toHaveLength(1);
    await expect(
      page.getByRole("button", { name: "新建研究", exact: true }),
    ).toBeEnabled();
  } finally {
    ack.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
test("H4 待确认期间连续结束多个正文组，撤销按每组原值恢复且旧ACK不清新组", async ({
  page,
}) => {
  await openWorkspace(page);
  await newCard(page);
  const body = page.getByLabel("卡片正文", { exact: true });
  const ack = gate();
  let written = false;
  let first = true;
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type !== "body.edit" || !first)
      return route.continue();
    first = false;
    const response = await route.fetch();
    written = true;
    await ack.promise;
    await route.fulfill({ response });
  });
  try {
    await body.pressSequentially("A");
    await expect.poll(() => written).toBe(true);
    await body.press("Home");
    await body.pressSequentially("B");
    await body.press("End");
    await body.pressSequentially("C");
    await expect(body).toHaveValue("BAC");
    await body.press("Meta+z");
    ack.release();
    await expect(body).toHaveValue("BA");
    await expect(body).not.toHaveAttribute("readonly", "");
    await body.press("Meta+z");
    await expect(body).toHaveValue("A");
    await expect(body).not.toHaveAttribute("readonly", "");
    await body.press("Meta+z");
    await expect(body).toHaveValue("");
    expect((await historyState(page)).redo).toHaveLength(3);
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
  } finally {
    ack.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("R2 no-op标题ACK不借回读版本静默覆盖并发标题", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  await page.getByRole("button", { name: "初始标题", exact: true }).click();
  const title = page.getByLabel("卡片标题", { exact: true });
  const read = () =>
    page.evaluate(
      async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
      projectId,
    );
  const initial = await read();
  const card = initial.cards[0];
  const ack = gate();
  let noOpWritten = false;
  let first = true;
  const commands: { value: string; expected: string }[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === "thought.title")
      commands.push({
        value: command.payload.title,
        expected: command.expected,
      });
    if (
      command.type !== "thought.title" ||
      command.payload.title !== "初始标题" ||
      !first
    )
      return route.continue();
    first = false;
    const response = await route.fetch();
    expect((await response.json()).changedIds).toEqual([]);
    noOpWritten = true;
    await ack.promise;
    await route.fulfill({ response });
  });
  try {
    await title.fill("临时标题");
    await title.fill("初始标题");
    await expect.poll(() => noOpWritten).toBe(true);
    await title.fill("本地后续B");
    const remote = await page.evaluate(
      async ({ projectId, card }) => {
        const response = await fetch("/api/mapping/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commandId: crypto.randomUUID(),
            projectId,
            type: "thought.title",
            expected: card.versionId,
            payload: { id: card.id, title: "另一调用者C" },
          }),
        });
        return response.json();
      },
      { projectId, card },
    );
    expect(remote.changedIds).toEqual([card.id]);
    ack.release();
    await expect(page.getByRole("alert")).toContainText("标题已更新");
    await expect(title).toHaveValue("本地后续B");
    await expect(page.getByLabel("已保存的标题")).toHaveValue("另一调用者C");
    expect((await read()).cards[0].title).toBe("另一调用者C");
    expect(commands.find((c) => c.value === "本地后续B")!.expected).toBe(
      card.versionId,
    );
    await testInfo.attach("no-op-ack-versions", {
      body: JSON.stringify({ commands, remote }),
      contentType: "application/json",
    });
  } finally {
    ack.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
for (const lostAck of [false, true]) {
  test(`R2 no-op正文${lostAck ? "丢ACK重试" : "延迟ACK"}保持原版本与待确认输入组`, async ({
    page,
  }) => {
    await openWorkspace(page);
    const projectId = await newCard(page);
    const body = page.getByLabel("卡片正文", { exact: true });
    await body.fill("原正文A");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const initial = await page.evaluate(
      async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
      projectId,
    );
    const card = initial.cards[0];
    const ack = gate();
    let noOpWritten = false;
    let first = true;
    const submitted: { value: string; expected: string; commandId: string }[] =
      [];
    await page.route("**/api/mapping/execute", async (route) => {
      const c = route.request().postDataJSON();
      if (c.type === "body.edit")
        submitted.push({
          value: c.payload.text,
          expected: c.expected,
          commandId: c.commandId,
        });
      if (c.type !== "body.edit" || c.payload.text !== "原正文A" || !first)
        return route.continue();
      first = false;
      const response = await route.fetch();
      expect((await response.json()).changedIds).toEqual([]);
      noOpWritten = true;
      await ack.promise;
      if (lostAck)
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "测试丢失无变化确认" }),
        });
      else await route.fulfill({ response });
    });
    try {
      await body.fill("临时正文");
      await body.fill("原正文A");
      await expect.poll(() => noOpWritten).toBe(true);
      await body.press("End");
      await body.pressSequentially("B");
      await body.press("Home");
      await body.pressSequentially("X");
      const local = await body.inputValue();
      await page.evaluate(
        async ({ projectId, card }) => {
          const r = await fetch("/api/mapping/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              commandId: crypto.randomUUID(),
              projectId,
              type: "body.edit",
              expected: card.body.versionId,
              payload: { id: card.id, text: "另一调用者正文C" },
            }),
          });
          if (!r.ok) throw new Error("Remote write failed");
        },
        { projectId, card },
      );
      ack.release();
      if (lostAck) {
        await expect(page.getByRole("alert")).toHaveText("测试丢失无变化确认");
        await page.getByRole("button", { name: "重试保存" }).click();
        const retries = submitted.filter((c) => c.value === "原正文A");
        expect(retries).toHaveLength(2);
        expect(retries[0]!.commandId).toBe(retries[1]!.commandId);
      }
      await expect(page.getByRole("alert")).toContainText("正文已更新");
      await expect(body).toHaveValue(local);
      await expect(page.getByLabel("已保存的正文")).toHaveValue(
        "另一调用者正文C",
      );
      const after = await page.evaluate(
        async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
        projectId,
      );
      expect(after.cards[0].body.blocks[0].text).toBe("另一调用者正文C");
      expect(submitted.find((c) => c.value === "原正文AB")!.expected).toBe(
        card.body.versionId,
      );
    } finally {
      ack.release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}
test("R2 已落盘正文ACK延迟时后续输入先于方向键移动入历史", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const body = page.getByLabel("卡片正文", { exact: true });
  const read = () =>
    page.evaluate(
      async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
      projectId,
    );
  const original = (await read()).cards[0];
  const ack = gate();
  let written = false;
  let first = true;
  await page.route("**/api/mapping/execute", async (route) => {
    const c = route.request().postDataJSON();
    if (c.type !== "body.edit" || c.payload.text !== "A" || !first)
      return route.continue();
    first = false;
    const response = await route.fetch();
    written = true;
    await ack.promise;
    await route.fulfill({ response });
  });
  try {
    await body.pressSequentially("A");
    await expect.poll(() => written).toBe(true);
    expect((await read()).cards[0].body.blocks[0].text).toBe("A");
    await body.pressSequentially("B");
    await page
      .getByRole("button", { name: "移动卡片：方向键调整位置" })
      .press("ArrowRight");
    await expect(page.locator(".react-flow__node")).toHaveCSS(
      "transform",
      `matrix(1, 0, 0, 1, ${original.item.pose.x + 10}, ${original.item.pose.y})`,
    );
    ack.release();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const history = await historyState(page);
    const persisted = await read();
    await testInfo.attach("ordered-body-pose", {
      body: JSON.stringify({ history, persisted }),
      contentType: "application/json",
    });
    expect(history.undo.map((a: { label: string }) => a.label)).toEqual([
      "thought.create",
      "body.edit",
      "pose.move",
    ]);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(body).toHaveValue("AB");
    await expect
      .poll(async () => (await read()).cards[0].item.pose)
      .toEqual(original.item.pose);
    await expect(
      page.getByRole("button", { name: "撤销", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(body).toHaveValue("");
  } finally {
    ack.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
for (const lostAck of [false, true]) {
  test(`R2 已落盘正文${lostAck ? "丢ACK重试" : "迟ACK在拖动中返回"}不改变可见位置且正文先于布局`, async ({
    page,
  }) => {
    await openWorkspace(page);
    const projectId = await newCard(page);
    const body = page.getByLabel("卡片正文", { exact: true });
    const read = () =>
      page.evaluate(
        async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
        projectId,
      );
    const before = (await read()).cards[0];
    const ack = gate();
    let written = false;
    let first = true;
    const bodyKeys: string[] = [];
    await page.route("**/api/mapping/execute", async (route) => {
      const c = route.request().postDataJSON();
      if (c.type === "body.edit" && c.payload.text === "A")
        bodyKeys.push(c.commandId);
      if (c.type !== "body.edit" || c.payload.text !== "A" || !first)
        return route.continue();
      first = false;
      const response = await route.fetch();
      written = true;
      await ack.promise;
      if (lostAck)
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "测试丢失移动前正文确认" }),
        });
      else await route.fulfill({ response });
    });
    try {
      await body.pressSequentially("A");
      await expect.poll(() => written).toBe(true);
      expect((await read()).cards[0].body.blocks[0].text).toBe("A");
      await body.pressSequentially("B");
      const box = (await page.locator(".thought-card").boundingBox())!;
      await page.mouse.move(box.x + box.width - 15, box.y + 12);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 95, box.y + 92, { steps: 12 });
      const transform = await page
        .locator(".react-flow__node")
        .evaluate((n) => getComputedStyle(n).transform);
      expect(transform).not.toBe(
        `matrix(1, 0, 0, 1, ${before.item.pose.x}, ${before.item.pose.y})`,
      );
      if (!lostAck) {
        ack.release();
        await expect
          .poll(async () => (await read()).cards[0].body.blocks[0].text)
          .toBe("AB");
        await expect(page.locator(".react-flow__node")).toHaveCSS(
          "transform",
          transform,
        );
      }
      await page.mouse.up();
      if (lostAck) {
        ack.release();
        await expect(page.getByRole("alert")).toContainText("确认此移动之前");
        await expect(page.locator(".react-flow__node")).toHaveCSS(
          "transform",
          transform,
        );
        await page.getByRole("button", { name: "重试保存" }).click();
      }
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
      if (lostAck) {
        expect(bodyKeys).toHaveLength(2);
        expect(bodyKeys[0]).toBe(bodyKeys[1]);
      }
      expect(
        (await historyState(page)).undo.map((a: { label: string }) => a.label),
      ).toEqual(["thought.create", "body.edit", "pose.move"]);
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      await expect
        .poll(async () => (await read()).cards[0].item.pose)
        .toEqual(before.item.pose);
      await expect(body).toHaveValue("AB");
      await expect(
        page.getByRole("button", { name: "撤销", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      await expect(body).toHaveValue("");
    } finally {
      ack.release();
      await page.mouse.up();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}
test("R2 撤销创建保留当前写字板删除态并恢复原卡身份", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const read = () =>
    page.evaluate(
      async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
      projectId,
    );
  const original = (await read()).cards[0];
  await expect(page.locator(".body-editor")).toHaveCount(1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await expect(page.locator(".body-editor")).toHaveCount(1);
  await expect(page.getByText("这张卡片已删除", { exact: true })).toBeVisible();
  await expect(page.getByLabel("卡片正文", { exact: true })).toHaveCount(0);
  await expect(page.locator(".body-editor h2")).toHaveText("初始标题");
  await page.screenshot({ path: testInfo.outputPath("deleted-panel.png") });
  await page.getByRole("button", { name: "撤销删除", exact: true }).click();
  await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue("");
  const restored = (await read()).cards[0];
  expect(restored.id).toBe(original.id);
  expect(restored.body.id).toBe(original.body.id);
  expect(restored.body.blocks).toEqual(original.body.blocks);
  expect(restored.item.id).toBe(original.item.id);
  await expect(page.locator(".body-editor")).toHaveCount(1);
});
test("R2 删除恢复预读后发生竞争不会重做无关对象，失效入口诚实停用", async ({
  page,
}) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  const restore = page.getByRole("button", { name: "撤销删除", exact: true });
  await expect(restore).toBeEnabled();
  const readAck = gate();
  let captured = false;
  let first = true;
  await page.route(
    `**/api/mapping/projects/${projectId}/history`,
    async (route) => {
      if (!first) return route.continue();
      first = false;
      const response = await route.fetch();
      captured = true;
      await readAck.promise;
      await route.fulfill({ response });
    },
  );
  try {
    await restore.click();
    await expect.poll(() => captured).toBe(true);
    await page.evaluate(async (projectId) => {
      const post = async (command: unknown) => {
        const r = await fetch("/api/mapping/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        });
        if (!r.ok) throw new Error("Concurrent write failed");
        return r.json();
      };
      const created = await post({
        projectId,
        commandId: crypto.randomUUID(),
        type: "thought.create",
        expected: null,
        payload: {
          id: crypto.randomUUID(),
          title: "不能误恢复的另一张卡",
          text: "",
          x: 20,
          y: 20,
        },
      });
      await post({
        projectId,
        commandId: crypto.randomUUID(),
        type: "history.undo",
        expected: created.revision,
        payload: {},
      });
    }, projectId);
    const before = await historyState(page);
    expect(before.redo.at(-1).target.title).toBe("不能误恢复的另一张卡");
    readAck.release();
    await expect(page.getByRole("alert")).toContainText("项目历史已更新");
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    expect(await historyState(page)).toEqual(before);
    await expect(restore).toBeDisabled();
    await expect(
      page.getByText("这次删除的恢复已不可用", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".body-editor h2")).toHaveText("初始标题");
  } finally {
    readAck.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
for (const written of [false, true]) {
  test(`R2 删除${written ? "丢ACK" : "失败"}保留当前面板，原命令重试确认后才显示删除态`, async ({
    page,
  }) => {
    await openWorkspace(page);
    await newCard(page);
    let first = true;
    const keys: string[] = [];
    await page.route("**/api/mapping/execute", async (route) => {
      const c = route.request().postDataJSON();
      if (c.type !== "history.undo") return route.continue();
      keys.push(c.commandId);
      if (!first) return route.continue();
      first = false;
      if (written) await route.fetch();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "测试未确认删除" }),
      });
    });
    try {
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      await expect(page.getByRole("alert")).toHaveText("测试未确认删除");
      await expect(page.locator(".body-editor")).toHaveCount(1);
      await expect(
        page.getByText("这张卡片已删除", { exact: true }),
      ).toHaveCount(0);
      await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue(
        "",
      );
      await page.getByRole("button", { name: "重试保存" }).click();
      await expect(
        page.getByText("这张卡片已删除", { exact: true }),
      ).toBeVisible();
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
      expect((await historyState(page)).redo).toHaveLength(1);
      await expect(page.locator(".body-editor h2")).toHaveText("初始标题");
    } finally {
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}
test("R2 旧正文no-opACK先确认再撤销创建，不复活删除对象或收起面板", async ({
  page,
}) => {
  await openWorkspace(page);
  await newCard(page);
  const body = page.getByLabel("卡片正文", { exact: true });
  const ack = gate();
  let saved = false;
  let first = true;
  await page.route("**/api/mapping/execute", async (route) => {
    const c = route.request().postDataJSON();
    if (c.type !== "body.edit" || !first) return route.continue();
    first = false;
    const response = await route.fetch();
    expect((await response.json()).changedIds).toEqual([]);
    saved = true;
    await ack.promise;
    await route.fulfill({ response });
  });
  try {
    // One synthetic composition keeps both intermediate inputs in one unsaved
    // unit, so this command really confirms unchanged empty text.
    await body.dispatchEvent("compositionstart");
    await body.fill("暂改");
    await body.fill("");
    await body.dispatchEvent("compositionend");
    await expect.poll(() => saved).toBe(true);
    await body.press("Meta+z");
    await expect(body).toHaveAttribute("readonly", "");
    await expect(page.getByText("这张卡片已删除", { exact: true })).toHaveCount(
      0,
    );
    ack.release();
    await expect(
      page.getByText("这张卡片已删除", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await expect(page.locator(".body-editor")).toHaveCount(1);
    await expect(page.getByLabel("卡片正文", { exact: true })).toHaveCount(0);
    expect((await historyState(page)).redo).toHaveLength(1);
  } finally {
    ack.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
test("R2 后续研究编辑使原删除恢复失效，另一redo不能复活原卡", async ({
  page,
}) => {
  await openWorkspace(page);
  await newCard(page);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "撤销删除", exact: true }),
  ).toBeEnabled();
  await historyCard(page, "新卡片");
  await expect(
    page.getByRole("button", { name: "撤销删除", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".body-editor h2")).toHaveText("初始标题");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  expect((await historyState(page)).redo.at(-1).target.title).toBe("新卡片");
  await expect(
    page.getByRole("button", { name: "撤销删除", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("这次删除的恢复已不可用", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭正文" }).click();
  await expect(page.locator(".body-editor")).toHaveCount(0);
});
