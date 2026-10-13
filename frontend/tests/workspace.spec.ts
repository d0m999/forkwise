import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import type { Card, Command } from "../src/api";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
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
  // Release this fixture's active HTTP connections before waiting for graceful shutdown.
  await page.goto("about:blank");
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
  // Preserve #3: Pose is really persisted before the unfinished IME unit ends.
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(
            async (id) => (await fetch("/api/mapping/projects/" + id)).json(),
            projectId,
          )
        ).cards[0].item.pose.x,
    )
    .toBe(before.cards[0].item.pose.x + 10);
  await expect(body).toHaveValue("我的待保存正文");
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

for (const delayedPose of [false, true]) {
  test(`R2 明确正文冲突${delayedPose ? "解决在移动之后" : "不阻塞独立布局落盘或重设正文依据版本"}`, async ({
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
    const original = (await read()).cards[0];
    const submitted: {
      type: string;
      expected: string;
      payload: { text?: string };
    }[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/api/mapping/execute")
      )
        submitted.push(request.postDataJSON());
    });
    await body.dispatchEvent("compositionstart");
    await body.fill("我的冲突草稿");
    const external = await page.evaluate(
      async ({ projectId, card }) => {
        const response = await fetch("/api/mapping/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commandId: crypto.randomUUID(),
            projectId,
            type: "body.edit",
            expected: card.body.versionId,
            payload: { id: card.id, text: "对方已保存正文" },
          }),
        });
        return response.json();
      },
      { projectId, card: original },
    );
    expect(external.changedIds).toContain(original.body.id);
    await body.dispatchEvent("compositionend");
    await expect(page.getByLabel("已保存的正文")).toHaveValue("对方已保存正文");
    const poseGate = gate();
    let poseStarted = false;
    if (delayedPose)
      await page.route("**/api/mapping/execute", async (route) => {
        if (route.request().postDataJSON().type !== "pose.move")
          return route.continue();
        poseStarted = true;
        await poseGate.promise;
        await route.continue();
      });
    try {
      await page
        .getByRole("button", { name: "移动卡片：方向键调整位置" })
        .press("ArrowRight");
      if (delayedPose) {
        await expect.poll(() => poseStarted).toBe(true);
        await page.getByRole("button", { name: "确认保留我的正文" }).click();
        // Hold the Pose request beyond the save debounce; the later choice must wait.
        await page.waitForTimeout(600);
        expect((await read()).cards[0].body.blocks[0].text).toBe(
          "对方已保存正文",
        );
        poseGate.release();
      }
      await expect
        .poll(async () => (await read()).cards[0].item.pose.x)
        .toBe(original.item.pose.x + 10);
      if (!delayedPose) {
        await expect(body).toHaveValue("我的冲突草稿");
        await expect(page.getByLabel("已保存的正文")).toHaveValue(
          "对方已保存正文",
        );
        await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
        expect((await read()).cards[0].body.blocks[0].text).toBe(
          "对方已保存正文",
        );
        expect(
          submitted.filter((c) => c.payload.text === "我的冲突草稿"),
        ).toEqual([
          expect.objectContaining({ expected: original.body.versionId }),
        ]);
        await page.getByRole("button", { name: "确认保留我的正文" }).click();
      }
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
      expect((await read()).cards[0].body.blocks[0].text).toBe("我的冲突草稿");
      expect(
        (await historyState(page)).undo.map((a: { label: string }) => a.label),
      ).toEqual(["thought.create", "body.edit", "pose.move", "body.edit"]);
    } finally {
      poseGate.release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}

test("R3 正文未知转明确冲突后，可独立重试布局且重复点击只保存一次", async ({
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
  const failedBody = gate(),
    poseAck = gate();
  let bodyStarted = false,
    poseWritten = false,
    first = true;
  const commands: {
    type: string;
    commandId: string;
    expected: string;
    payload: { text?: string };
  }[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    commands.push(command);
    if (command.type === "body.edit" && command.payload.text === "A" && first) {
      first = false;
      bodyStarted = true;
      await failedBody.promise;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "测试正文结果未知" }),
      });
    }
    if (command.type === "pose.move") {
      const response = await route.fetch();
      poseWritten = true;
      await poseAck.promise;
      return route.fulfill({ response });
    }
    return route.continue();
  });
  try {
    await body.pressSequentially("A");
    await expect.poll(() => bodyStarted).toBe(true);
    await page
      .getByRole("button", { name: "移动卡片：方向键调整位置" })
      .press("ArrowRight");
    failedBody.release();
    await expect(page.getByRole("alert")).toContainText("确认此移动之前");
    const response = await page.evaluate(
      async ({ projectId, card }) => {
        return (
          await fetch("/api/mapping/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              commandId: crypto.randomUUID(),
              projectId,
              type: "body.edit",
              expected: card.body.versionId,
              payload: { id: card.id, text: "另一调用者C" },
            }),
          })
        ).ok;
      },
      { projectId, card: original },
    );
    expect(response).toBe(true);
    await body.fill("本地后续AB");
    await expect(page.getByLabel("已保存的正文")).toHaveValue("另一调用者C");
    const retry = page.getByRole("button", { name: "重试保存", exact: true });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect.poll(() => poseWritten).toBe(true);
    await retry.click();
    poseAck.release();
    await expect
      .poll(async () => (await read()).cards[0].item.pose.x)
      .toBe(original.item.pose.x + 10);
    await expect(page.getByRole("status")).toHaveText("保存未完成");
    await expect(body).toHaveValue("本地后续AB");
    await expect(page.getByLabel("已保存的正文")).toHaveValue("另一调用者C");
    expect((await read()).cards[0].body.blocks[0].text).toBe("另一调用者C");
    const attempts = commands.filter((c) => c.payload.text === "A");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[0]!.expected).toBe(original.body.versionId);
    expect(commands.filter((c) => c.type === "pose.move")).toHaveLength(1);
    expect(
      (await historyState(page)).undo.map((a: { label: string }) => a.label),
    ).toEqual(["thought.create", "body.edit", "pose.move"]);
    await testInfo.attach("unknown-to-conflict-recovery", {
      body: JSON.stringify({ commands, persisted: await read() }),
      contentType: "application/json",
    });
  } finally {
    failedBody.release();
    poseAck.release();
    await page.unrouteAll({ behavior: "wait" });
  }
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
      if (!updatedAgain) {
        await expect.poll(() => commands.length).toBe(1);
        expect(commands[0]!.expected).toBe(
          field === "body" ? remote.body.versionId : remote.versionId,
        );
      }
      if (updatedAgain) {
        await expect(page.getByLabel(`已保存的${label}`)).toHaveValue(
          "再次保存D",
        );
        expect(value((await read()).cards[0])).toBe("再次保存D");
        expect(commands).toHaveLength(0);
        if (field === "body") await expect(input).toHaveValue(original);
        else
          await expect(
            page.getByRole("button", { name: original, exact: true }),
          ).toBeVisible();
        await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
        const recheckedRemote = (await read()).cards[0];
        await page
          .getByRole("button", { name: `确认保留我的${label}` })
          .click();
        await expect.poll(() => commands.length).toBe(1);
        expect(commands[0]!.expected).toBe(
          field === "body"
            ? recheckedRemote.body.versionId
            : recheckedRemote.versionId,
        );
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
  await expect(
    page.getByRole("button", { name: "卡片", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "卡片", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("卡片标题", { exact: true }).fill("库存观察");
  await page.getByLabel("卡片标题", { exact: true }).press("Escape");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.goto("about:blank");
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
    await page.getByRole("button", { name: "重试撤销", exact: true }).click();
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
for (const direction of ["undo", "redo"] as const) {
  test(`R3 ${direction}丢ACK后普通反向入口不执行原动作，明确重试后才可反向操作`, async ({
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
    if (direction === "redo") {
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      await expect(
        page.getByText("这张卡片已删除", { exact: true }),
      ).toBeVisible();
    }
    const commands: { type: string; commandId: string }[] = [];
    let first = true;
    await page.route("**/api/mapping/execute", async (route) => {
      const command = route.request().postDataJSON();
      if (command.type.startsWith("history.")) commands.push(command);
      if (command.type !== `history.${direction}` || !first)
        return route.continue();
      first = false;
      await route.fetch();
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "测试历史确认丢失" }),
      });
    });
    try {
      const label = direction === "undo" ? "撤销" : "重做";
      const oppositeLabel = direction === "undo" ? "重做" : "撤销";
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect(page.getByRole("alert")).toHaveText("测试历史确认丢失");
      const confirmedOnServer = await read();
      expect(confirmedOnServer.cards).toHaveLength(
        direction === "undo" ? 0 : 1,
      );
      await expect(
        page.getByRole("button", { name: label, exact: true }),
      ).toBeDisabled();
      const opposite = page.getByRole("button", {
        name: oppositeLabel,
        exact: true,
      });
      await expect(opposite).toBeDisabled();
      // A disabled button and the ordinary keyboard route must both stay inert.
      await opposite.evaluate((button) =>
        (button as HTMLButtonElement).click(),
      );
      await page.keyboard.press(
        direction === "undo" ? "Meta+Shift+z" : "Meta+z",
      );
      await page.waitForTimeout(200);
      expect(commands).toHaveLength(1);
      const retry = page.getByRole("button", {
        name: `重试${label}`,
        exact: true,
      });
      await expect(retry).toBeEnabled();
      await retry.click();
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
      expect(commands).toHaveLength(2);
      expect(commands[1]).toEqual(commands[0]);
      expect((await read()).project.revision).toBe(
        confirmedOnServer.project.revision,
      );
      if (direction === "undo")
        await expect(
          page.getByText("这张卡片已删除", { exact: true }),
        ).toBeVisible();
      else expect((await read()).cards[0].id).toBe(original.id);
      await expect(opposite).toBeEnabled();
      await opposite.click();
      await expect
        .poll(async () => (await read()).project.revision)
        .toBe(confirmedOnServer.project.revision + 1);
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
      expect(commands).toHaveLength(3);
      expect(commands[2]!.type).toBe(
        direction === "undo" ? "history.redo" : "history.undo",
      );
      expect(commands[2]!.commandId).not.toBe(commands[0]!.commandId);
      const reversed = await read();
      expect(reversed.project.revision).toBe(
        confirmedOnServer.project.revision + 1,
      );
      expect(reversed.cards).toHaveLength(direction === "undo" ? 1 : 0);
      if (direction === "undo") {
        expect(reversed.cards[0].id).toBe(original.id);
        expect(reversed.cards[0].body.id).toBe(original.body.id);
        await expect(
          page.getByLabel("卡片正文", { exact: true }),
        ).toBeVisible();
      } else
        await expect(
          page.getByText("这张卡片已删除", { exact: true }),
        ).toBeVisible();
      await testInfo.attach("history-direction-recovery", {
        body: JSON.stringify({ commands, confirmedOnServer, reversed }),
        contentType: "application/json",
      });
    } finally {
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}

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
  test(`R2 完整正文前序组${lostAck ? "丢ACK原命令重试" : "迟ACK"}先于布局，新组合输入保持完整且不阻塞布局落盘`, async ({
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
    const submitted: {
      type: string;
      commandId: string;
      payload: { text?: string };
    }[] = [];
    await page.route("**/api/mapping/execute", async (route) => {
      const command = route.request().postDataJSON();
      submitted.push(command);
      if (
        command.type !== "body.edit" ||
        command.payload.text !== "A" ||
        !first
      )
        return route.continue();
      first = false;
      const response = await route.fetch();
      written = true;
      await ack.promise;
      if (lostAck)
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "测试丢失前序组确认" }),
        });
      else await route.fulfill({ response });
    });
    try {
      await body.pressSequentially("A");
      await expect.poll(() => written).toBe(true);
      await body.pressSequentially("B");
      // Synthetic events cover the coordinator, not real system IME acceptance.
      await body.dispatchEvent("compositionstart");
      await body.fill("ABC");
      await page
        .getByRole("button", { name: "移动卡片：方向键调整位置" })
        .press("ArrowRight");
      await expect(page.locator(".react-flow__node")).toHaveCSS(
        "transform",
        `matrix(1, 0, 0, 1, ${original.item.pose.x + 10}, ${original.item.pose.y})`,
      );
      ack.release();
      if (lostAck) {
        await expect(page.getByRole("alert")).toContainText("确认此移动之前");
        expect((await read()).cards[0].item.pose).toEqual(original.item.pose);
        expect((await read()).cards[0].body.blocks[0].text).toBe("A");
        await expect(body).toHaveValue("ABC");
        await page.getByRole("button", { name: "重试保存" }).click();
      }
      await expect
        .poll(async () => (await read()).cards[0].item.pose.x)
        .toBe(original.item.pose.x + 10);
      expect((await read()).cards[0].body.blocks[0].text).toBe("AB");
      const prefix = lostAck
        ? ["A", "A", "AB", "pose.move"]
        : ["A", "AB", "pose.move"];
      expect(
        submitted.map((c) =>
          c.type === "body.edit" ? c.payload.text : c.type,
        ),
      ).toEqual(prefix);
      if (lostAck) expect(submitted[0]).toEqual(submitted[1]);
      await expect(body).toHaveValue("ABC");
      await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
      await body.fill("ABCD");
      await body.dispatchEvent("compositionend");
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
      expect(
        submitted.map((c) =>
          c.type === "body.edit" ? c.payload.text : c.type,
        ),
      ).toEqual([...prefix, "ABCD"]);
      const timeline = await historyState(page);
      expect(timeline.undo.map((a: { label: string }) => a.label)).toEqual([
        "thought.create",
        "body.edit",
        "pose.move",
        "body.edit",
      ]);
      await testInfo.attach("completed-prefix-and-composition", {
        body: JSON.stringify({ submitted, timeline, persisted: await read() }),
        contentType: "application/json",
      });
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      await expect(body).toHaveValue("AB");
      expect((await read()).cards[0].item.pose.x).toBe(
        original.item.pose.x + 10,
      );
      await expect(
        page.getByRole("button", { name: "撤销", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      await expect
        .poll(async () => (await read()).cards[0].item.pose)
        .toEqual(original.item.pose);
      await expect(body).toHaveValue("AB");
    } finally {
      ack.release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}

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
      await page.getByRole("button", { name: "重试撤销" }).click();
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

test("D5 保存失败继续输入，刷新从原卡恢复最新草稿并真实落盘", async ({
  page,
}) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await historyCard(page, "恢复原卡");
  await page.getByRole("button", { name: "编辑正文" }).click();
  const initial = await draftProject(page);
  const card = initial.cards[0]!;
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type === "body.edit")
      await route.abort();
    else await route.continue();
  });
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.fill("未确认第一稿");
  await expect(page.getByRole("alert")).toBeVisible();
  await body.fill("失败后继续写的最新草稿");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "恢复草稿", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/mapping/execute");
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await expect(body).toHaveValue("失败后继续写的最新草稿");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect(
    (await draftProject(page)).cards.find((c: Card) => c.id === card.id)?.body
      .blocks[0].text,
  ).toBe("失败后继续写的最新草稿");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "恢复草稿", exact: true }),
  ).toHaveCount(0);
});

async function draftProject(page: Page) {
  return page.evaluate(async () => {
    const id = document
      .querySelector("[role=tab][aria-selected=true]")!
      .getAttribute("title");
    return (await fetch(`/api/mapping/projects/${id}`)).json();
  });
}

test("D5 损坏恢复条目不阻断有效草稿，原始损坏内容保留", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await historyCard(page, "损坏隔离");
  await page.getByRole("button", { name: "编辑正文" }).click();
  await page.route("**/api/mapping/execute", (r) => r.abort());
  await page.getByLabel("卡片正文", { exact: true }).fill("有效草稿");
  await page.evaluate(() =>
    localStorage.setItem("forkwise:recovery:v1:broken", "{broken"),
  );
  await page.reload();
  await expect(
    page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "恢复草稿", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/mapping/execute");
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue(
    "有效草稿",
  );
  expect(
    await page.evaluate(() =>
      localStorage.getItem("forkwise:recovery:v1:broken"),
    ),
  ).toBe("{broken");
});

async function externalBody(page: Page, text: string) {
  const state = await draftProject(page);
  const card = state.cards[0];
  const response = await page.request.post(origin + "/api/mapping/execute", {
    headers: { Origin: origin },
    data: {
      commandId: crypto.randomUUID(),
      projectId: state.project.id,
      type: "body.edit",
      expected: card.body.versionId,
      payload: { id: card.id, text },
    },
  });
  expect(response.ok()).toBe(true);
}
test("D5 冲突明确选择已保存正文，另一份先持久保存且重开可恢复", async ({
  page,
}) => {
  await openWorkspace(page);
  await newCard(page);
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.dispatchEvent("compositionstart");
  await body.fill("我的冲突草稿");
  await externalBody(page, "外部已保存正文");
  await body.dispatchEvent("compositionend");
  await expect(page.getByLabel("保存冲突")).toBeVisible();
  await page.getByRole("button", { name: "确认保留已保存的正文" }).click();
  await expect(body).toHaveValue("外部已保存正文");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.reload();
  await expect(page.getByLabel("草稿恢复")).toContainText("我的冲突草稿");
  expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
    "外部已保存正文",
  );
});

test("D5 关闭失败正文仍收起面板，切卡后重试只保存原卡", async ({ page }) => {
  await openWorkspace(page);
  await newCard(page);
  const first = (await draftProject(page)).cards[0];
  await page.getByRole("button", { name: "关闭正文" }).click();
  await historyCard(page, "另一张卡");
  const nodes = page.locator(".react-flow__node");
  await nodes.first().getByRole("button", { name: "编辑正文" }).press("Enter");
  await page.route("**/api/mapping/execute", async (r) => {
    if (r.request().postDataJSON().type === "body.edit") await r.abort();
    else await r.continue();
  });
  await page.getByLabel("卡片正文", { exact: true }).fill("原卡失败草稿");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "关闭正文" }).click();
  await expect(page.getByLabel("卡片正文", { exact: true })).toHaveCount(0);
  await nodes.last().getByRole("button", { name: "编辑正文" }).click();
  await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue("");
  await page.unroute("**/api/mapping/execute");
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const saved = await draftProject(page);
  expect(
    saved.cards.find((c: Card) => c.id === first.id).body.blocks[0].text,
  ).toBe("原卡失败草稿");
  expect(saved.cards[1].body.blocks[0].text).toBe("");
});

test("D5 删除目标恢复入口显示删除态，保留草稿且不复活", async ({ page }) => {
  await openWorkspace(page);
  await newCard(page);
  const state = await draftProject(page);
  await page.route("**/api/mapping/execute", async (r) => {
    if (r.request().postDataJSON().type === "body.edit") await r.abort();
    else await r.continue();
  });
  await page.getByLabel("卡片正文", { exact: true }).fill("删除后仍可查的草稿");
  await expect(page.getByRole("alert")).toBeVisible();
  const timeline = await historyState(page);
  const deleted = await page.request.post(origin + "/api/mapping/execute", {
    headers: { Origin: origin },
    data: {
      commandId: crypto.randomUUID(),
      projectId: state.project.id,
      type: "history.undo",
      expected: timeline.revision,
      payload: {},
    },
  });
  expect(deleted.ok()).toBe(true);
  await page.reload();
  await page.unroute("**/api/mapping/execute");
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await expect(page.getByLabel("已删除卡片")).toBeVisible();
  await expect(page.getByLabel("草稿恢复")).toContainText("删除后仍可查的草稿");
  expect((await draftProject(page)).cards).toHaveLength(0);
});

test("D5 明确校验失败后修正输入提交最新草稿，不死循环旧无效请求", async ({
  page,
}) => {
  await openWorkspace(page);
  await newCard(page);
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.fill("x".repeat(200001));
  await expect(page.getByRole("alert")).toContainText("保存请求格式无效");
  await body.fill("修正后的可保存正文");
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
    "修正后的可保存正文",
  );
});

test("D5 SQLite已提交但丢ACK，重开先原请求重试再保存新generation", async ({
  page,
}) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  let original: unknown;
  await page.route("**/api/mapping/execute", async (route) => {
    const cmd = route.request().postDataJSON();
    if (cmd.type !== "body.edit") {
      await route.continue();
      return;
    }
    original ??= cmd;
    await route.fetch();
    await route.abort();
  });
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.fill("已落盘但未确认");
  await expect(page.getByRole("alert")).toBeVisible();
  await body.fill("后来继续输入");
  await page.reload();
  await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
    "title",
    projectId,
  );
  await page.unroute("**/api/mapping/execute");
  const replay: unknown[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    replay.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await expect(body).toHaveValue("后来继续输入");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect(replay[0]).toEqual(original);
  const changes = await (
    await page.request.get(
      origin + `/api/mapping/projects/${projectId}/changes?after=0`,
    )
  ).json();
  expect(
    changes.changes.filter(
      (c: { commandId: string }) =>
        c.commandId === (original as { commandId: string }).commandId,
    ),
  ).toHaveLength(1);
});

test("D5 真实localStorage容量耗尽时保留两份，释放容量后才允许冲突选择", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  await newCard(page);
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.dispatchEvent("compositionstart");
  await body.fill("必须保护的本机草稿");
  await externalBody(page, "必须保护的远端正文");
  await body.dispatchEvent("compositionend");
  await expect(page.getByLabel("保存冲突")).toBeVisible();
  const full = await page.evaluate(() => {
    let i = 0,
      failed = false;
    for (const size of [100000, 1000, 10, 1]) {
      try {
        for (;;) localStorage.setItem("quota-" + i++, "x".repeat(size));
      } catch (e) {
        failed = (e as DOMException).name === "QuotaExceededError";
      }
    }
    return failed;
  });
  expect(full).toBe(true);
  await body.fill("写满后仍继续输入".repeat(100));
  await expect(page.getByText(/恢复区写入失败/)).toBeVisible();
  await page.getByRole("button", { name: "确认保留我的正文" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "无法保存另一份恢复副本，请释放本机空间后重试" }),
  ).toBeVisible();
  await expect(page.getByLabel("保存冲突")).toBeVisible();
  expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
    "必须保护的远端正文",
  );
  await expect(body).toHaveValue("写满后仍继续输入".repeat(100));
  await page.screenshot({ path: testInfo.outputPath("quota-preserved.png") });
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("quota-")) localStorage.removeItem(key);
  });
  await page.getByRole("button", { name: "确认保留我的正文" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.reload();
  await expect(page.getByLabel("草稿恢复")).toContainText("必须保护的远端正文");
});

test("D5 比较后远端再次变化必须重新选择，跨项目身份伪造不执行", async ({
  page,
}) => {
  await openWorkspace(page);
  await newCard(page);
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.dispatchEvent("compositionstart");
  await body.fill("我的正文");
  await externalBody(page, "远端一");
  await body.dispatchEvent("compositionend");
  await expect(page.getByLabel("已保存的正文")).toHaveValue("远端一");
  await externalBody(page, "远端二");
  await page.getByRole("button", { name: "确认保留我的正文" }).click();
  await expect(page.getByLabel("已保存的正文")).toHaveValue("远端二");
  expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
    "远端二",
  );
  await page.getByRole("button", { name: "确认保留我的正文" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const state = await draftProject(page);
  await page.evaluate(
    ({ projectId }) => {
      localStorage.setItem(
        "forkwise:recovery:v1:forged",
        JSON.stringify({
          schema: 1,
          projectId,
          cardId: "other-project-card",
          drafts: [
            {
              projectId,
              cardId: "other-project-card",
              field: "body",
              value: "不能写入",
              expected: "forged",
              generation: 1,
            },
          ],
          closed: [],
          pending: null,
        }),
      );
    },
    { projectId: state.project.id },
  );
  await page.reload();
  await page
    .getByLabel("草稿恢复")
    .locator("article")
    .filter({ hasText: "不能写入" })
    .getByRole("button")
    .click();
  await expect(page.getByRole("alert")).toContainText("草稿身份不属于此项目");
  expect((await draftProject(page)).cards).toEqual(state.cards);
});

test("D5 synthetic格式边界结束动作组但不虚构格式内容", async ({ page }) => {
  await openWorkspace(page);
  await newCard(page);
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.pressSequentially("A");
  await body.evaluate((el) =>
    el.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "formatBold" }),
    ),
  );
  await body.pressSequentially("B");
  await body.press("Meta+z");
  await expect(body).toHaveValue("A");
});

test("D5 400ms落盘与1s分组独立，长synthetic IME不被2s拆分", async ({
  page,
}) => {
  await openWorkspace(page);
  await newCard(page);
  const clockStart = Date.now();
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart + 1000);
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.pressSequentially("A");
  await page.clock.runFor(399);
  expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe("");
  await page.clock.runFor(1);
  await expect
    .poll(async () => (await draftProject(page)).cards[0].body.blocks[0].text)
    .toBe("A");
  await page.clock.runFor(200);
  await body.pressSequentially("B");
  await page.clock.runFor(400);
  await expect
    .poll(async () => (await draftProject(page)).cards[0].body.blocks[0].text)
    .toBe("AB");
  expect((await historyState(page)).undo).toHaveLength(2);
  await page.clock.runFor(1100);
  await body.pressSequentially("C");
  await page.clock.runFor(400);
  await expect.poll(async () => (await historyState(page)).undo.length).toBe(3);
  await body.dispatchEvent("compositionstart");
  await body.fill("ABC中文组合");
  await page.clock.runFor(2500);
  expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe("ABC");
  await body.dispatchEvent("compositionend");
  await page.clock.runFor(400);
  await expect
    .poll(async () => (await draftProject(page)).cards[0].body.blocks[0].text)
    .toBe("ABC中文组合");
  await body.press("Meta+z");
  await expect(body).toHaveValue("ABC");
});

test("D5 synthetic粘贴边界和真实焦点边界各自可撤销", async ({ page }) => {
  await openWorkspace(page);
  await newCard(page);
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.pressSequentially("A");
  await body.evaluate((el) =>
    el.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertFromPaste",
      }),
    ),
  );
  await body.pressSequentially("P");
  await body.press("Meta+z");
  await expect(body).toHaveValue("A");
  await body.press("Meta+Shift+z");
  await expect(body).toHaveValue("AP");
  await page.getByRole("button", { name: "项目导航" }).focus();
  await body.pressSequentially("B");
  await body.press("Meta+z");
  await expect(body).toHaveValue("AP");
});

test("S5-R2 恢复identity迟到不覆盖同卡后来实际输入，旧草稿保留到重开", async ({
  page,
}, testInfo) => {
  page.on("pageerror", (error) =>
    process.stderr.write("R2 browser error: " + error.message + "\n"),
  );
  await openWorkspace(page);
  await newCard(page);
  const body = page.getByLabel("卡片正文", { exact: true });
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type === "body.edit")
      await route.abort();
    else await route.continue();
  });
  await body.fill("之前失败的恢复正文");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.reload();
  await page.unroute("**/api/mapping/execute");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.getByRole("button", { name: "编辑正文" }).click();
  const identityStarted = gate(),
    identityResponse = gate();
  await page.route("**/cards/*/identity", async (route) => {
    const response = await route.fetch();
    identityStarted.release();
    await identityResponse.promise;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await identityStarted.promise;
    await body.pressSequentially("恢复查询期间继续输入的新正文");
    await page.screenshot({
      path: testInfo.outputPath("before-identity-release.png"),
    });
    identityResponse.release();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
      "恢复查询期间继续输入的新正文",
    );
    await expect(body).toHaveValue("恢复查询期间继续输入的新正文");
    await expect(
      page.getByText(
        "恢复检查期间内容或编辑对象已变化，原草稿仍保留，请重新选择恢复",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("草稿恢复")).toContainText(
      "之前失败的恢复正文",
    );
    await page.reload();
    await page.getByRole("button", { name: "编辑正文" }).click();
    await expect(body).toHaveValue("恢复查询期间继续输入的新正文");
    await expect(page.getByLabel("草稿恢复")).toContainText(
      "之前失败的恢复正文",
    );
  } finally {
    identityResponse.release();
    await page.unroute("**/cards/*/identity");
    await page.screenshot({
      path: testInfo.outputPath("after-identity-release.png"),
    });
  }
});

async function seedRecoveryJournal(
  page: Page,
  projectId: string,
  card: Card,
  text: string,
  requiredAssetIds?: string[],
) {
  const command = {
    commandId: crypto.randomUUID(),
    projectId,
    type: "body.edit" as const,
    expected: card.body.versionId,
    payload: {
      id: card.id,
      text,
      ...(requiredAssetIds ? { requiredAssetIds } : {}),
    },
  };
  const draft = {
    projectId,
    cardId: card.id,
    field: "body",
    value: text,
    generation: 1,
    expected: card.body.versionId,
    command,
  };
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    {
      key: "forkwise:recovery:v1:" + crypto.randomUUID(),
      value: {
        schema: 1,
        projectId,
        cardId: card.id,
        drafts: [draft],
        closed: [],
        pending: null,
      },
    },
  );
  return command;
}

test("S5-R2 未持久化媒体拒绝后同generation重试保留原封请求和SQLite状态", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page),
    historyBefore = await historyState(page);
  const original = await seedRecoveryJournal(
    page,
    projectId,
    before.cards[0],
    "等待真实媒体的恢复正文",
    ["pending-asset"],
  );
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const requests: unknown[] = [],
    replies: { code?: string }[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    replies.push(await response.json());
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("所需媒体尚未持久保存");
    expect(requests[0]).toEqual(original);
    expect(await draftProject(page)).toEqual(before);
    await page.screenshot({
      path: testInfo.outputPath("media-before-retry.png"),
    });
    await page.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect.poll(() => replies.length).toBe(2);
    expect(replies[1]!.code).toBe("MEDIA_NOT_PERSISTED");
    expect(requests[1]).toEqual(original);
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    expect(await draftProject(page)).toEqual(before);
    expect(await historyState(page)).toEqual(historyBefore);
  } finally {
    await testInfo.attach("media-original-request-runtime", {
      body: JSON.stringify({
        original,
        requests,
        replies,
        before,
        after: await draftProject(page),
        historyBefore,
        historyAfter: await historyState(page),
      }),
      contentType: "application/json",
    });
    await page.unroute("**/api/mapping/execute");
    await page.screenshot({
      path: testInfo.outputPath("media-after-retry.png"),
    });
  }
});

test("S5-R2 媒体依赖随新generation和重开继续保留，不能变成已保存", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page),
    historyBefore = await historyState(page);
  const original = await seedRecoveryJournal(
    page,
    projectId,
    before.cards[0],
    "带未完成媒体的草稿",
    ["pending-asset"],
  );
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const requests: {
    commandId: string;
    expected: string;
    payload: { text: string; requiredAssetIds?: string[] };
  }[] = [];
  const codes: (string | undefined)[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    codes.push((await response.json()).code);
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("所需媒体尚未持久保存");
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.fill("媒体仍未完成，继续输入的新正文");
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect.poll(() => codes.length).toBe(2);
  expect(codes[1]).toBe("MEDIA_NOT_PERSISTED");
  expect(requests[1]!.payload).toMatchObject({
    text: "媒体仍未完成，继续输入的新正文",
    requiredAssetIds: ["pending-asset"],
  });
  expect(requests[1]!.commandId).not.toBe(original.commandId);
  expect(requests[1]!.expected).toBe(original.expected);
  expect(await draftProject(page)).toEqual(before);
  expect(await historyState(page)).toEqual(historyBefore);
  await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
  const reopenUrl = page.url();
  await page.goto("about:blank");
  await stop();
  await start();
  await page.goto(reopenUrl);
  await expect(
    page.getByRole("button", { name: "恢复草稿", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await expect.poll(() => codes.length).toBe(3);
  expect(requests[2]).toEqual(requests[1]);
  expect(codes[2]).toBe("MEDIA_NOT_PERSISTED");
  await expect(body).toHaveValue("媒体仍未完成，继续输入的新正文");
  await body.pressSequentially("，重开后继续写");
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect.poll(() => codes.length).toBe(4);
  expect(requests[3]!.payload.requiredAssetIds).toEqual(["pending-asset"]);
  expect(codes[3]).toBe("MEDIA_NOT_PERSISTED");
  await testInfo.attach("media-generation-restart-runtime", {
    body: JSON.stringify({
      original,
      requests,
      codes,
      before,
      after: await draftProject(page),
      historyBefore,
      historyAfter: await historyState(page),
    }),
    contentType: "application/json",
  });
  expect(await draftProject(page)).toEqual(before);
  expect(await historyState(page)).toEqual(historyBefore);
  await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
});

for (const boundary of ["card", "project", "close"] as const) {
  test(`S5-R2 恢复读取跨${boundary}边界迟到时不交接，往返也不能复用旧授权`, async ({
    page,
  }) => {
    await openWorkspace(page);
    const projectId = await newCard(page);
    const initial = await draftProject(page),
      originalCard = initial.cards[0];
    let otherCard: Card | undefined, otherProjectId: string | undefined;
    if (boundary === "card") {
      await historyCard(page, "另一张卡片");
      otherCard = (await draftProject(page)).cards[1];
    } else if (boundary === "project") {
      await page.getByRole("button", { name: "新建研究", exact: true }).click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("project"))
        .not.toBe(projectId);
      otherProjectId = new URL(page.url()).searchParams.get("project")!;
      await page.locator(`[role=tab][title="${projectId}"]`).click();
      await expect(
        page.locator(`[role=tab][title="${projectId}"]`),
      ).toHaveAttribute("aria-selected", "true");
    }
    await seedRecoveryJournal(
      page,
      projectId,
      originalCard,
      "必须保留的原卡恢复草稿",
    );
    await page.reload();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const openBody = (card: Card) =>
      page
        .locator(`[data-id="${card.item.id}"]`)
        .getByRole("button", { name: "编辑正文" })
        .press("Enter");
    await openBody(originalCard);
    const readStarted = gate(),
      release = gate();
    const submitted: unknown[] = [];
    await page.route("**/api/mapping/execute", async (route) => {
      submitted.push(route.request().postDataJSON());
      await route.continue();
    });
    await page.route("**/cards/*/identity", async (route) => {
      const response = await route.fetch();
      readStarted.release();
      await release.promise;
      await route.fulfill({ response });
    });
    try {
      await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
      await readStarted.promise;
      if (boundary === "card") {
        await openBody(otherCard!);
        await expect(page.locator(".body-editor h2")).toHaveText("另一张卡片");
        await openBody(originalCard);
        await expect(page.locator(".body-editor h2")).toHaveText(
          originalCard.title,
        );
      } else if (boundary === "project") {
        await page.locator(`[role=tab][title="${otherProjectId}"]`).click();
        await expect(
          page.locator(`[role=tab][title="${otherProjectId}"]`),
        ).toHaveAttribute("aria-selected", "true");
        await page.locator(`[role=tab][title="${projectId}"]`).click();
        await expect(
          page.locator(`[role=tab][title="${projectId}"]`),
        ).toHaveAttribute("aria-selected", "true");
        await openBody(originalCard);
      } else {
        await page.getByRole("button", { name: "关闭正文" }).click();
        await expect(page.getByLabel("卡片正文", { exact: true })).toHaveCount(
          0,
        );
      }
      release.release();
      await expect(
        page.getByText(
          "恢复检查期间内容或编辑对象已变化，原草稿仍保留，请重新选择恢复",
        ),
      ).toBeVisible();
      expect(submitted).toEqual([]);
      expect(
        (await draftProject(page)).cards.find(
          (c: Card) => c.id === originalCard.id,
        ).body,
      ).toEqual(originalCard.body);
      await expect(page.getByLabel("草稿恢复")).toContainText(
        "必须保留的原卡恢复草稿",
      );
      if (boundary === "close")
        await expect(page.getByLabel("卡片正文", { exact: true })).toHaveCount(
          0,
        );
      else
        await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue(
          originalCard.body.blocks[0].text,
        );
      await page.reload();
      await expect(page.getByLabel("草稿恢复")).toContainText(
        "必须保留的原卡恢复草稿",
      );
    } finally {
      release.release();
      await page.unroute("**/cards/*/identity");
    }
  });
}

for (const lateReply of ["success", "failure"] as const) {
  test(`S5-R2 后发恢复完成后，先发identity晚到${lateReply}不覆盖其内容或状态`, async ({
    page,
  }) => {
    await openWorkspace(page);
    const projectId = await newCard(page),
      before = await draftProject(page);
    const first = await seedRecoveryJournal(
      page,
      projectId,
      before.cards[0],
      "先发恢复草稿",
    );
    const second = await seedRecoveryJournal(
      page,
      projectId,
      before.cards[0],
      "后发明确选择的草稿",
    );
    await page.reload();
    await expect(page.getByLabel("草稿恢复")).toContainText(
      "后发明确选择的草稿",
    );
    const firstStarted = gate(),
      firstRelease = gate(),
      firstDelivered = gate();
    let identityCount = 0;
    const requests: { commandId: string }[] = [];
    await page.route("**/api/mapping/execute", async (route) => {
      requests.push(route.request().postDataJSON());
      await route.continue();
    });
    await page.route("**/cards/*/identity", async (route) => {
      identityCount++;
      if (identityCount === 1) {
        const response = await route.fetch();
        firstStarted.release();
        await firstRelease.promise;
        if (lateReply === "success") await route.fulfill({ response });
        else
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              code: "UNAVAILABLE",
              message: "先发请求晚到失败",
            }),
          });
        firstDelivered.release();
      } else await route.continue();
    });
    try {
      const entry = (text: string) =>
        page
          .getByLabel("草稿恢复")
          .locator("article")
          .filter({ hasText: text })
          .getByRole("button", { name: "恢复草稿" });
      await entry("先发恢复草稿").click();
      await firstStarted.promise;
      await entry("后发明确选择的草稿").click();
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
      await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue(
        "后发明确选择的草稿",
      );
      firstRelease.release();
      await firstDelivered.promise;
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(requests.map((r) => r.commandId)).toEqual([second.commandId]);
      expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
        "后发明确选择的草稿",
      );
      await expect(page.getByLabel("草稿恢复")).toContainText("先发恢复草稿");
      expect(requests.some((r) => r.commandId === first.commandId)).toBe(false);
      await page.reload();
      await expect(page.getByLabel("草稿恢复")).toContainText("先发恢复草稿");
    } finally {
      firstRelease.release();
      await page.unroute("**/cards/*/identity");
    }
  });
}

test("S5-R2 恢复project旧读取晚于新输入ACK到达也不得覆盖，恢复记录仍在", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page),
    before = await draftProject(page);
  const original = await seedRecoveryJournal(
    page,
    projectId,
    before.cards[0],
    "旧读取绑定的恢复正文",
  );
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.getByRole("button", { name: "编辑正文" }).click();
  const readStarted = gate(),
    releaseRead = gate();
  let firstRead = true;
  const requests: { commandId: string }[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.route(
    origin + "/api/mapping/projects/" + projectId,
    async (route) => {
      if (firstRead) {
        firstRead = false;
        const response = await route.fetch();
        readStarted.release();
        await releaseRead.promise;
        await route.fulfill({ response });
      } else await route.continue();
    },
  );
  try {
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await readStarted.promise;
    await page
      .getByLabel("卡片正文", { exact: true })
      .pressSequentially("读取在途时实际输入并先获得ACK的正文");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    releaseRead.release();
    await expect(
      page.getByText(
        "恢复检查期间内容或编辑对象已变化，原草稿仍保留，请重新选择恢复",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue(
      "读取在途时实际输入并先获得ACK的正文",
    );
    expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
      "读取在途时实际输入并先获得ACK的正文",
    );
    expect(requests.some((r) => r.commandId === original.commandId)).toBe(
      false,
    );
    await expect(page.getByLabel("草稿恢复")).toContainText(
      "旧读取绑定的恢复正文",
    );
    await testInfo.attach("late-project-runtime", {
      body: JSON.stringify({
        original,
        requests,
        readback: await draftProject(page),
      }),
      contentType: "application/json",
    });
    await page.reload();
    await expect(page.getByLabel("草稿恢复")).toContainText(
      "旧读取绑定的恢复正文",
    );
  } finally {
    releaseRead.release();
    await page.unroute(origin + "/api/mapping/projects/" + projectId);
  }
});

test("S5-R2 媒体拒绝响应在途时继续输入，新请求仍带原媒体依赖", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page),
    before = await draftProject(page);
  const original = await seedRecoveryJournal(
    page,
    projectId,
    before.cards[0],
    "在途媒体恢复正文",
    ["pending-asset"],
  );
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const pendingStarted = gate(),
    responseRelease = gate();
  const requests: {
    commandId: string;
    payload: { text: string; requiredAssetIds?: string[] };
  }[] = [];
  const codes: (string | undefined)[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    codes.push((await response.json()).code);
    if (requests.length === 1) {
      pendingStarted.release();
      await responseRelease.promise;
    }
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await pendingStarted.promise;
    await page
      .getByLabel("卡片正文", { exact: true })
      .fill("旧媒体请求等待响应时的新正文");
    responseRelease.release();
    await expect(page.getByRole("alert")).toContainText("所需媒体尚未持久保存");
    await page.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect.poll(() => codes.length).toBe(2);
    expect(requests[0]).toEqual(original);
    expect(requests[1]!.payload).toMatchObject({
      text: "旧媒体请求等待响应时的新正文",
      requiredAssetIds: ["pending-asset"],
    });
    expect(codes).toEqual(["MEDIA_NOT_PERSISTED", "MEDIA_NOT_PERSISTED"]);
    expect(await draftProject(page)).toEqual(before);
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    await testInfo.attach("media-inflight-runtime", {
      body: JSON.stringify({
        original,
        requests,
        codes,
        before,
        after: await draftProject(page),
      }),
      contentType: "application/json",
    });
  } finally {
    responseRelease.release();
    await page.unroute("**/api/mapping/execute");
  }
});

test("S5-R3 原请求缺省媒体要求的损坏恢复隔离原字节，合法草稿仍可实际保存", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page);
  const card = before.cards[0];
  const key = "forkwise:recovery:v1:missing-requirements";
  const command = {
    commandId: crypto.randomUUID(),
    projectId,
    type: "body.edit",
    expected: card.body.versionId,
    payload: { id: card.id, text: "损坏记录声明未持久资源" },
  };
  const raw =
    "\n" +
    JSON.stringify(
      {
        schema: 1,
        projectId,
        cardId: card.id,
        drafts: [
          {
            projectId,
            cardId: card.id,
            field: "body",
            value: command.payload.text,
            generation: 1,
            expected: command.expected,
            requiredAssetIds: ["missing-resource"],
            command,
          },
        ],
        closed: [],
        pending: null,
      },
      null,
      2,
    ) +
    "\n";
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key,
    raw,
  });
  const requests: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/mapping/execute"))
      requests.push(request.postDataJSON());
  });
  try {
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    const restore = page.getByRole("button", { name: "恢复草稿", exact: true });
    // Capture the actual vulnerable path on RED, rather than failing before HTTP/readback.
    if (await restore.count()) {
      await restore.click();
      await expect.poll(() => requests.length).toBe(1);
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
    }
    await expect(
      page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复"),
    ).toBeVisible();
    expect(requests).toEqual([]);
    expect(await draftProject(page)).toEqual(before);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    const valid = await seedRecoveryJournal(
      page,
      projectId,
      card,
      "同库合法恢复正文",
    );
    await page.reload();
    await expect(restore).toHaveCount(1);
    await restore.click();
    await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue(
      "同库合法恢复正文",
    );
    await expect
      .poll(async () => (await draftProject(page)).cards[0].body.blocks[0].text)
      .toBe("同库合法恢复正文");
    expect(requests).toEqual([valid]);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await page.reload();
    await expect(restore).toHaveCount(0);
    expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
      "同库合法恢复正文",
    );
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
  } finally {
    const runtime = JSON.stringify({
      command,
      raw,
      requests,
      before,
      after: await draftProject(page),
      retained: await page.evaluate((key) => localStorage.getItem(key), key),
      status: await page.getByRole("status").innerText(),
    });
    writeFileSync(
      testInfo.outputPath("missing-requirements-runtime.json"),
      runtime,
      { mode: 0o600 },
    );
    await page.screenshot({
      path: testInfo.outputPath("missing-requirements.png"),
    });
  }
});

test("S5-R3 pending原请求只覆盖较少资源时隔离整个损坏条目并保留字节", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page),
    before = await draftProject(page),
    card = before.cards[0];
  const key = "forkwise:recovery:v1:subset-requirements";
  const raw = JSON.stringify(
    {
      schema: 1,
      projectId,
      cardId: card.id,
      drafts: [],
      closed: [],
      pending: {
        projectId,
        cardId: card.id,
        field: "body",
        value: "原请求缺少第二份资源",
        expected: card.body.versionId,
        generation: 1,
        requiredAssetIds: ["missing-a", "missing-b"],
        command: {
          commandId: crypto.randomUUID(),
          projectId,
          type: "body.edit",
          expected: card.body.versionId,
          payload: {
            id: card.id,
            text: "原请求缺少第二份资源",
            requiredAssetIds: ["missing-a"],
          },
        },
      },
    },
    null,
    2,
  );
  const requests: unknown[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      requests.push(r.postDataJSON());
  });
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key,
    raw,
  });
  await page.reload();
  await expect(
    page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "恢复草稿", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
  expect(requests).toEqual([]);
  expect(await draftProject(page)).toEqual(before);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    raw,
  );
  await page.reload();
  await expect(
    page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复"),
  ).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    raw,
  );
  writeFileSync(
    testInfo.outputPath("subset-requirements-runtime.json"),
    JSON.stringify({ raw, requests, before, after: await draftProject(page) }),
    { mode: 0o600 },
  );
});

test("S5-R3 标题原请求夹带正文资源字段须隔离，不能拒绝后剥字段保存", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page),
    before = await draftProject(page),
    card = before.cards[0];
  const key = "forkwise:recovery:v1:title-with-assets";
  const raw = JSON.stringify(
    {
      schema: 1,
      projectId,
      cardId: card.id,
      closed: [],
      pending: null,
      drafts: [
        {
          projectId,
          cardId: card.id,
          field: "title",
          value: "不应落盘的损坏标题",
          expected: card.versionId,
          generation: 1,
          command: {
            commandId: crypto.randomUUID(),
            projectId,
            type: "thought.title",
            expected: card.versionId,
            payload: {
              id: card.id,
              title: "不应落盘的损坏标题",
              requiredAssetIds: ["missing-resource"],
            },
          },
        },
      ],
    },
    null,
    2,
  );
  const requests: unknown[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      requests.push(r.postDataJSON());
  });
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key,
    raw,
  });
  try {
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    const restore = page.getByRole("button", { name: "恢复草稿", exact: true });
    if (await restore.count()) {
      await restore.click();
      await expect(page.getByRole("alert")).toBeVisible();
      await page.getByRole("button", { name: "重试保存", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
    }
    await expect(
      page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复"),
    ).toBeVisible();
    expect(requests).toEqual([]);
    expect(await draftProject(page)).toEqual(before);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
  } finally {
    writeFileSync(
      testInfo.outputPath("title-assets-runtime.json"),
      JSON.stringify({
        raw,
        requests,
        before,
        after: await draftProject(page),
        retained: await page.evaluate((key) => localStorage.getItem(key), key),
        status: await page.getByRole("status").innerText(),
      }),
      { mode: 0o600 },
    );
    await page.screenshot({ path: testInfo.outputPath("title-assets.png") });
  }
});

for (const compatibility of [
  "reordered",
  "command-superset",
  "legacy-command-only",
] as const) {
  test(`S5-R3 合法${compatibility}媒体恢复在未知响应及刷新后重放原请求`, async ({
    page,
  }, testInfo) => {
    await openWorkspace(page);
    const projectId = await newCard(page),
      before = await draftProject(page),
      card = before.cards[0];
    const original = {
      commandId: crypto.randomUUID(),
      projectId,
      type: "body.edit",
      expected: card.body.versionId,
      payload: {
        id: card.id,
        text: "同一合法资源集合的恢复正文",
        requiredAssetIds: ["missing-b", "missing-a"],
      },
    };
    const raw = JSON.stringify({
      schema: 1,
      projectId,
      cardId: card.id,
      drafts: [
        {
          projectId,
          cardId: card.id,
          field: "body",
          value: original.payload.text,
          expected: original.expected,
          generation: 7,
          ...(compatibility === "legacy-command-only"
            ? {}
            : {
                requiredAssetIds:
                  compatibility === "reordered"
                    ? ["missing-a", "missing-b"]
                    : ["missing-a"],
              }),
          command: original,
        },
      ],
      closed: [],
      pending: null,
    });
    await page.evaluate(
      (raw) =>
        localStorage.setItem("forkwise:recovery:v1:compatible-media", raw),
      raw,
    );
    const requests: unknown[] = [],
      codes: (string | undefined)[] = [];
    await page.route("**/api/mapping/execute", async (route) => {
      requests.push(route.request().postDataJSON());
      const response = await route.fetch();
      codes.push((await response.json()).code);
      if (requests.length === 1)
        await route.abort(); // Real HTTP completed, but caller cannot know its outcome.
      else await route.fulfill({ response });
    });
    try {
      await page.reload();
      await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect.poll(() => requests.length).toBe(1);
      expect(requests[0]).toEqual(original);
      expect(await draftProject(page)).toEqual(before);
      await page.reload();
      await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText(
        "所需媒体尚未持久保存",
      );
      await page.getByRole("button", { name: "重试保存", exact: true }).click();
      await expect.poll(() => requests.length).toBe(3);
      await expect.poll(() => codes.length).toBe(3);
      expect(requests).toEqual([original, original, original]);
      expect(codes).toEqual([
        "MEDIA_NOT_PERSISTED",
        "MEDIA_NOT_PERSISTED",
        "MEDIA_NOT_PERSISTED",
      ]);
      await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
      expect(await draftProject(page)).toEqual(before);
      await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue(
        original.payload.text,
      );
    } finally {
      writeFileSync(
        testInfo.outputPath("compatible-media-runtime.json"),
        JSON.stringify({
          compatibility,
          raw,
          original,
          requests,
          codes,
          before,
          after: await draftProject(page),
        }),
        { mode: 0o600 },
      );
      await page.unroute("**/api/mapping/execute");
    }
  });
}

for (const damage of [
  "project",
  "card",
  "text",
  "expected",
  "generation",
] as const) {
  test(`S5-R3 恢复${damage}绑定损坏时保留原件且不派发请求`, async ({
    page,
  }, testInfo) => {
    await openWorkspace(page);
    const projectId = await newCard(page),
      before = await draftProject(page),
      card = before.cards[0];
    const value = "不应交接的损坏正文";
    const raw = JSON.stringify(
      {
        schema: 1,
        projectId,
        cardId: card.id,
        drafts: [
          {
            projectId,
            cardId: card.id,
            field: "body",
            value,
            generation: damage === "generation" ? 0 : 1,
            expected: card.body.versionId,
            command: {
              commandId: crypto.randomUUID(),
              type: "body.edit",
              projectId: damage === "project" ? "other-project" : projectId,
              expected:
                damage === "expected"
                  ? "another-body-version"
                  : card.body.versionId,
              payload: {
                id: damage === "card" ? "other-card" : card.id,
                text: damage === "text" ? "另一份原请求正文" : value,
              },
            },
          },
        ],
        closed: [],
        pending: null,
      },
      null,
      2,
    );
    const key = "forkwise:recovery:v1:binding-" + damage,
      requests: unknown[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/mapping/execute"))
        requests.push(r.postDataJSON());
    });
    await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
      key,
      raw,
    });
    await page.reload();
    await expect(
      page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "恢复草稿", exact: true }),
    ).toHaveCount(0);
    expect(requests).toEqual([]);
    expect(await draftProject(page)).toEqual(before);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    writeFileSync(
      testInfo.outputPath("binding-runtime.json"),
      JSON.stringify({
        damage,
        raw,
        requests,
        before,
        after: await draftProject(page),
      }),
      { mode: 0o600 },
    );
  });
}

test("S5-R3 合法后来媒体generation冲突明确选择远端，先存本机副本且重开仍受媒体门槛", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page),
    initial = await draftProject(page),
    card = initial.cards[0];
  // The original unconfirmed generation has no media. A later draft adds media;
  // it must not rewrite the original request, and explicit remote choice may discard it only after archiving.
  const original = {
    commandId: crypto.randomUUID(),
    projectId,
    type: "body.edit",
    expected: card.body.versionId,
    payload: { id: card.id, text: "较早未确认的普通正文" },
  };
  const newer = {
    projectId,
    cardId: card.id,
    field: "body",
    value: "后来加入未持久媒体的本机正文",
    generation: 2,
    expected: card.body.versionId,
    requiredAssetIds: ["pending-asset"],
  };
  await page.evaluate(
    ({ projectId, cardId, original, newer }) =>
      localStorage.setItem(
        "forkwise:recovery:v1:two-generations",
        JSON.stringify({
          schema: 1,
          projectId,
          cardId,
          drafts: [newer],
          closed: [],
          pending: {
            projectId,
            cardId,
            field: "body",
            value: original.payload.text,
            generation: 1,
            expected: original.expected,
            command: original,
          },
        }),
      ),
    { projectId, cardId: card.id, original, newer },
  );
  await externalBody(page, "实际已保存的远端正文");
  const remote = await draftProject(page),
    requests: {
      expected: string;
      payload: { id: string; text: string; requiredAssetIds?: string[] };
    }[] = [],
    codes: (string | undefined)[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    codes.push((await response.json()).code);
    await route.fulfill({ response });
  });
  try {
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await expect(page.getByLabel("保存冲突")).toBeVisible();
    expect(requests).toEqual([original]);
    expect(codes).toEqual(["VERSION_CONFLICT"]);
    await expect(page.getByLabel("我的正文")).toHaveValue(newer.value);
    await expect(page.getByLabel("已保存的正文")).toHaveValue(
      "实际已保存的远端正文",
    );
    await page
      .getByRole("button", { name: "确认保留已保存的正文", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(requests[1].payload).toEqual({
      id: card.id,
      text: "实际已保存的远端正文",
    });
    expect(requests[1].expected).toBe(remote.cards[0].body.versionId);
    const copies = await page.evaluate(() =>
      Object.keys(localStorage)
        .filter((k) => k.startsWith("forkwise:recovery:v1:"))
        .map((k) => JSON.parse(localStorage.getItem(k)!)),
    );
    expect(copies).toHaveLength(1);
    expect(copies[0].drafts[0]).toMatchObject({
      value: newer.value,
      requiredAssetIds: ["pending-asset"],
    });
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("所需媒体尚未持久保存");
    expect(requests[2].payload).toEqual({
      id: card.id,
      text: newer.value,
      requiredAssetIds: ["pending-asset"],
    });
    expect(codes[2]).toBe("MEDIA_NOT_PERSISTED");
    expect(await draftProject(page)).toEqual(remote);
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    writeFileSync(
      testInfo.outputPath("media-remote-choice-runtime.json"),
      JSON.stringify({
        original,
        newer,
        requests,
        codes,
        copies,
        remote,
        after: await draftProject(page),
      }),
      { mode: 0o600 },
    );
  } finally {
    await page.unroute("**/api/mapping/execute");
  }
});

test("S5-R4 同目标generation不同文本的journal保留原件隔离，合法恢复仍落盘", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page),
    card = before.cards[0];
  const key = "forkwise:recovery:v1:duplicate-generation";
  const oldCommand = {
    commandId: crypto.randomUUID(),
    projectId,
    type: "body.edit",
    expected: card.body.versionId,
    payload: { id: card.id, text: "较早恢复正文" },
  };
  const latestCommand = {
    ...oldCommand,
    commandId: crypto.randomUUID(),
    payload: { id: card.id, text: "必须保护的最新恢复正文" },
  };
  const projection = (command: typeof oldCommand) => ({
    projectId,
    cardId: card.id,
    field: "body",
    value: command.payload.text,
    expected: command.expected,
    generation: 1,
    command,
  });
  const raw =
    "\n" +
    JSON.stringify(
      {
        schema: 1,
        projectId,
        cardId: card.id,
        closed: [projection(oldCommand)],
        drafts: [projection(latestCommand)],
        pending: null,
      },
      null,
      2,
    ) +
    "\n";
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key,
    raw,
  });
  const requests: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/mapping/execute"))
      requests.push(request.postDataJSON());
  });
  try {
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    const restore = page.getByRole("button", { name: "恢复草稿", exact: true });
    // On RED follow the vulnerable handoff through its real write and readback.
    if (await restore.count()) {
      await restore.click();
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
    }
    await expect(
      page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复"),
    ).toBeVisible();
    expect(requests).toEqual([]);
    expect(await draftProject(page)).toEqual(before);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    const valid = await seedRecoveryJournal(
      page,
      projectId,
      card,
      "独立合法草稿可恢复",
    );
    await page.reload();
    await expect(restore).toHaveCount(1);
    await restore.click();
    await expect
      .poll(async () => (await draftProject(page)).cards[0].body.blocks[0].text)
      .toBe("独立合法草稿可恢复");
    expect(requests).toEqual([valid]);
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
      "独立合法草稿可恢复",
    );
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(restore).toHaveCount(0);
  } finally {
    writeFileSync(
      testInfo.outputPath("duplicate-generation-runtime.json"),
      JSON.stringify({
        raw,
        oldCommand,
        latestCommand,
        requests,
        before,
        after: await draftProject(page),
        retained: await page.evaluate((key) => localStorage.getItem(key), key),
        status: await page.getByRole("status").innerText(),
      }),
      { mode: 0o600 },
    );
    await page.screenshot({
      path: testInfo.outputPath("duplicate-generation.png"),
    });
  }
});
test("S5-R4 同文本generation不同原commandId隔离，不能确认未执行请求", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page),
    card = before.cards[0];
  const key = "forkwise:recovery:v1:duplicate-command";
  const oldCommand = {
    commandId: crypto.randomUUID(),
    projectId,
    type: "body.edit",
    expected: card.body.versionId,
    payload: { id: card.id, text: "较早恢复正文" },
  };
  const latestCommand = {
    ...oldCommand,
    commandId: crypto.randomUUID(),
    payload: { id: card.id, text: "较早恢复正文" },
  };
  const projection = (command: typeof oldCommand) => ({
    projectId,
    cardId: card.id,
    field: "body",
    value: command.payload.text,
    expected: command.expected,
    generation: 1,
    command,
  });
  const raw =
    "\n" +
    JSON.stringify(
      {
        schema: 1,
        projectId,
        cardId: card.id,
        closed: [projection(oldCommand)],
        drafts: [projection(latestCommand)],
        pending: null,
      },
      null,
      2,
    ) +
    "\n";
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key,
    raw,
  });
  const requests: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/mapping/execute"))
      requests.push(request.postDataJSON());
  });
  try {
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    const restore = page.getByRole("button", { name: "恢复草稿", exact: true });
    // On RED follow the vulnerable handoff through its real write and readback.
    if (await restore.count()) {
      await restore.click();
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
    }
    await expect(
      page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复"),
    ).toBeVisible();
    expect(requests).toEqual([]);
    expect(await draftProject(page)).toEqual(before);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    const valid = await seedRecoveryJournal(
      page,
      projectId,
      card,
      "独立合法草稿可恢复",
    );
    await page.reload();
    await expect(restore).toHaveCount(1);
    await restore.click();
    await expect
      .poll(async () => (await draftProject(page)).cards[0].body.blocks[0].text)
      .toBe("独立合法草稿可恢复");
    expect(requests).toEqual([valid]);
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
      "独立合法草稿可恢复",
    );
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(restore).toHaveCount(0);
  } finally {
    writeFileSync(
      testInfo.outputPath("duplicate-command-runtime.json"),
      JSON.stringify({
        raw,
        oldCommand,
        latestCommand,
        requests,
        before,
        after: await draftProject(page),
        retained: await page.evaluate((key) => localStorage.getItem(key), key),
        status: await page.getByRole("status").innerText(),
      }),
      { mode: 0o600 },
    );
    await page.screenshot({
      path: testInfo.outputPath("duplicate-command.png"),
    });
  }
});
test("S5-R4 同generation无command投影的expected不同须隔离", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const earlier = (await draftProject(page)).cards[0].body.versionId;
  await externalBody(page, "既有权威安全正文");
  const before = await draftProject(page),
    card = before.cards[0];
  const key = "forkwise:recovery:v1:duplicate-expected";
  const oldCommand = {
    commandId: crypto.randomUUID(),
    projectId,
    type: "body.edit",
    expected: card.body.versionId,
    payload: { id: card.id, text: "较早恢复正文" },
  };
  const latestCommand = {
    ...oldCommand,
    commandId: crypto.randomUUID(),
    payload: { id: card.id, text: "较早恢复正文" },
  };
  const projection = (command: typeof oldCommand) => ({
    projectId,
    cardId: card.id,
    field: "body",
    value: command.payload.text,
    expected: command.expected,
    generation: 1,
    command,
  });
  const raw =
    "\n" +
    JSON.stringify(
      {
        schema: 1,
        projectId,
        cardId: card.id,
        closed: [projection(oldCommand)],
        drafts: [
          {
            ...projection(latestCommand),
            expected: earlier,
            command: undefined,
          },
        ],
        pending: null,
      },
      null,
      2,
    ) +
    "\n";
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key,
    raw,
  });
  const requests: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/mapping/execute"))
      requests.push(request.postDataJSON());
  });
  try {
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    const restore = page.getByRole("button", { name: "恢复草稿", exact: true });
    // On RED follow the vulnerable handoff through its real write and readback.
    if (await restore.count()) {
      await restore.click();
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
    }
    await expect(
      page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复"),
    ).toBeVisible();
    expect(requests).toEqual([]);
    expect(await draftProject(page)).toEqual(before);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    const valid = await seedRecoveryJournal(
      page,
      projectId,
      card,
      "独立合法草稿可恢复",
    );
    await page.reload();
    await expect(restore).toHaveCount(1);
    await restore.click();
    await expect
      .poll(async () => (await draftProject(page)).cards[0].body.blocks[0].text)
      .toBe("独立合法草稿可恢复");
    expect(requests).toEqual([valid]);
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
      "独立合法草稿可恢复",
    );
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(restore).toHaveCount(0);
  } finally {
    writeFileSync(
      testInfo.outputPath("duplicate-expected-runtime.json"),
      JSON.stringify({
        raw,
        oldCommand,
        latestCommand,
        requests,
        before,
        after: await draftProject(page),
        retained: await page.evaluate((key) => localStorage.getItem(key), key),
        status: await page.getByRole("status").innerText(),
      }),
      { mode: 0o600 },
    );
    await page.screenshot({
      path: testInfo.outputPath("duplicate-expected.png"),
    });
  }
});

test("S5-R4 同卡不同field同generation各自确认，不吞掉标题原请求", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page),
    card = before.cards[0];
  const bodyCommand = {
    commandId: crypto.randomUUID(),
    projectId,
    type: "body.edit",
    expected: card.body.versionId,
    payload: { id: card.id, text: "独立正文确认" },
  };
  const titleCommand = {
    commandId: crypto.randomUUID(),
    projectId,
    type: "thought.title",
    expected: card.versionId,
    payload: { id: card.id, title: "独立标题确认" },
  };
  const journal = {
    schema: 1,
    projectId,
    cardId: card.id,
    drafts: [],
    pending: null,
    closed: [
      {
        projectId,
        cardId: card.id,
        field: "body",
        value: bodyCommand.payload.text,
        expected: bodyCommand.expected,
        generation: 1,
        command: bodyCommand,
      },
      {
        projectId,
        cardId: card.id,
        field: "title",
        value: titleCommand.payload.title,
        expected: titleCommand.expected,
        generation: 1,
        command: titleCommand,
      },
    ],
  };
  const key = "forkwise:recovery:v1:independent-fields",
    raw = JSON.stringify(journal);
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key,
    raw,
  });
  const requests: unknown[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      requests.push(r.postDataJSON());
  });
  try {
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await expect
      .poll(async () => (await draftProject(page)).cards[0].body.blocks[0].text)
      .toBe("独立正文确认");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const saved = await draftProject(page);
    expect(saved.cards[0].body.blocks[0].text).toBe("独立正文确认");
    expect(saved.cards[0].title).toBe("独立标题确认");
    expect(requests).toEqual([bodyCommand, titleCommand]);
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    expect((await draftProject(page)).cards[0]).toEqual(saved.cards[0]);
    await expect(
      page.getByRole("button", { name: "恢复草稿", exact: true }),
    ).toHaveCount(0);
  } finally {
    writeFileSync(
      testInfo.outputPath("independent-fields-runtime.json"),
      JSON.stringify({
        journal,
        requests,
        before,
        after: await draftProject(page),
      }),
      { mode: 0o600 },
    );
    await page.screenshot({
      path: testInfo.outputPath("independent-fields.png"),
    });
  }
});

test("S5-R4 合法无command重复投影恢复实际丢ACK原请求，不重建命令", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  let original: unknown;
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "body.edit") return route.continue();
    original = command;
    await route.fetch();
    await route.abort();
  });
  await page
    .getByLabel("卡片正文", { exact: true })
    .fill("真实已提交但丢ACK的正文");
  await expect(page.getByRole("alert")).toBeVisible();
  const committed = await draftProject(page);
  const raw = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith("forkwise:recovery:v1:"),
    )!;
    const journal = JSON.parse(localStorage.getItem(key)!);
    // Compatible schema 1 projections can predate command assignment. Preserve
    // the actual pending request in drafts, with its other projection still bare.
    journal.closed = [{ ...journal.pending, command: undefined }];
    journal.drafts = [journal.pending];
    journal.pending = null;
    const raw = JSON.stringify(journal);
    localStorage.setItem(key, raw);
    return raw;
  });
  await page.unroute("**/api/mapping/execute");
  const requests: unknown[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      requests.push(r.postDataJSON());
  });
  try {
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    // The real HTTP replay must use the stored request, even if already committed.
    expect(requests[0]).toEqual(original);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(requests).toEqual([original]);
    expect(await draftProject(page)).toEqual(committed);
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    await expect(
      page.getByRole("button", { name: "恢复草稿", exact: true }),
    ).toHaveCount(0);
    expect(await draftProject(page)).toEqual(committed);
  } finally {
    writeFileSync(
      testInfo.outputPath("bare-projection-runtime.json"),
      JSON.stringify({
        raw,
        original,
        requests,
        committed,
        after: await draftProject(page),
      }),
      { mode: 0o600 },
    );
    await page.screenshot({ path: testInfo.outputPath("bare-projection.png") });
  }
});
test("S5-R4 同generation跨投影媒体要求不得被较弱原请求确认", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page),
    card = before.cards[0];
  const key = "forkwise:recovery:v1:duplicate-resources";
  const oldCommand = {
    commandId: crypto.randomUUID(),
    projectId,
    type: "body.edit",
    expected: card.body.versionId,
    payload: { id: card.id, text: "较早恢复正文" },
  };
  const latestCommand = {
    ...oldCommand,
    commandId: crypto.randomUUID(),
    payload: { id: card.id, text: "较早恢复正文" },
  };
  const projection = (command: typeof oldCommand) => ({
    projectId,
    cardId: card.id,
    field: "body",
    value: command.payload.text,
    expected: command.expected,
    generation: 1,
    command,
  });
  const raw =
    "\n" +
    JSON.stringify(
      {
        schema: 1,
        projectId,
        cardId: card.id,
        closed: [projection(oldCommand)],
        drafts: [
          {
            ...projection(latestCommand),
            command: undefined,
            requiredAssetIds: ["unpersisted-projection-asset"],
          },
        ],
        pending: null,
      },
      null,
      2,
    ) +
    "\n";
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key,
    raw,
  });
  const requests: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/mapping/execute"))
      requests.push(request.postDataJSON());
  });
  try {
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    const restore = page.getByRole("button", { name: "恢复草稿", exact: true });
    // On RED follow the vulnerable handoff through its real write and readback.
    if (await restore.count()) {
      await restore.click();
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
    }
    await expect(
      page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复"),
    ).toBeVisible();
    expect(requests).toEqual([]);
    expect(await draftProject(page)).toEqual(before);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    const valid = await seedRecoveryJournal(
      page,
      projectId,
      card,
      "独立合法草稿可恢复",
    );
    await page.reload();
    await expect(restore).toHaveCount(1);
    await restore.click();
    await expect
      .poll(async () => (await draftProject(page)).cards[0].body.blocks[0].text)
      .toBe("独立合法草稿可恢复");
    expect(requests).toEqual([valid]);
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
      "独立合法草稿可恢复",
    );
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(restore).toHaveCount(0);
  } finally {
    writeFileSync(
      testInfo.outputPath("duplicate-resources-runtime.json"),
      JSON.stringify({
        raw,
        oldCommand,
        latestCommand,
        requests,
        before,
        after: await draftProject(page),
        retained: await page.evaluate((key) => localStorage.getItem(key), key),
        status: await page.getByRole("status").innerText(),
      }),
      { mode: 0o600 },
    );
    await page.screenshot({
      path: testInfo.outputPath("duplicate-resources.png"),
    });
  }
});

test("S5-R4 正常pending和drafts重复投影原封重放，旧ACK只确认原generation", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  let original: unknown;
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type !== "body.edit")
      return route.continue();
    original = route.request().postDataJSON();
    await route.fetch();
    await route.abort();
  });
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.fill("正常未知原请求");
  await expect(page.getByRole("alert")).toBeVisible();
  const captured = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith("forkwise:recovery:v1:"),
    )!;
    return JSON.parse(localStorage.getItem(key)!);
  });
  expect(captured.pending.command).toEqual(original);
  expect(captured.drafts[0]).toEqual(captured.pending);
  await body.fill("最新generation必须实际保存");
  console.log("R4 pending: before reload");
  await page.reload();
  console.log("R4 pending: reloaded");
  await page.unroute("**/api/mapping/execute");
  await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
    "title",
    projectId,
  );
  console.log("R4 pending: ready");
  const requests: Command[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      requests.push(r.postDataJSON());
  });
  try {
    console.log("R4 pending: restore start");
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    console.log("R4 pending: restore clicked");
    await expect(body).toHaveValue("最新generation必须实际保存");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(original);
    expect(requests[1].commandId).not.toBe(requests[0].commandId);
    const saved = await draftProject(page);
    expect(saved.cards[0].body.blocks[0].text).toBe(
      "最新generation必须实际保存",
    );
    const changes = await (
      await page.request.get(
        origin + `/api/mapping/projects/${projectId}/changes?after=0`,
      )
    ).json();
    expect(
      changes.changes.filter(
        (c: { commandId: string }) => c.commandId === requests[0].commandId,
      ),
    ).toHaveLength(1);
    expect(
      changes.changes.filter(
        (c: { commandId: string }) => c.commandId === requests[1].commandId,
      ),
    ).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    expect(await draftProject(page)).toEqual(saved);
    await expect(
      page.getByRole("button", { name: "恢复草稿", exact: true }),
    ).toHaveCount(0);
  } finally {
    writeFileSync(
      testInfo.outputPath("normal-duplicate-runtime.json"),
      JSON.stringify({
        captured,
        original,
        requests,
        after: await draftProject(page),
      }),
      { mode: 0o600 },
    );
  }
});

test("S5-R4 不同card的同generation恢复分别保存原卡并保留未执行journal", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  await page.getByRole("button", { name: "关闭正文" }).click();
  await historyCard(page, "第二张恢复卡");
  const before = await draftProject(page),
    [first, second] = before.cards;
  const a = await seedRecoveryJournal(page, projectId, first, "第一张原卡草稿");
  const b = await seedRecoveryJournal(
    page,
    projectId,
    second,
    "第二张原卡草稿",
  );
  const secondBytes = await page.evaluate(
    (id) =>
      Object.keys(localStorage)
        .filter((k) => k.startsWith("forkwise:recovery:v1:"))
        .map((k) => ({ key: k, raw: localStorage.getItem(k)! }))
        .find((e) => JSON.parse(e.raw).cardId === id)!,
    second.id,
  );
  const requests: unknown[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      requests.push(r.postDataJSON());
  });
  try {
    await page.reload();
    const restore = page.getByRole("button", { name: "恢复草稿", exact: true });
    await expect(restore).toHaveCount(2);
    await page
      .getByRole("region", { name: "草稿恢复" })
      .locator("article")
      .filter({ hasText: "第一张原卡草稿" })
      .getByRole("button", { name: "恢复草稿", exact: true })
      .click();
    await expect.poll(() => requests.length).toBe(1);
    await expect
      .poll(async () => (await draftProject(page)).cards[0].body.blocks[0].text)
      .toBe("第一张原卡草稿");
    await expect(restore).toHaveCount(1);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), secondBytes.key),
    ).toBe(secondBytes.raw);
    await restore.click();
    await expect
      .poll(async () => (await draftProject(page)).cards[1].body.blocks[0].text)
      .toBe("第二张原卡草稿");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(requests).toEqual([a, b]);
    const saved = await draftProject(page);
    expect(saved.cards[0].id).toBe(first.id);
    expect(saved.cards[1].id).toBe(second.id);
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    expect(await draftProject(page)).toEqual(saved);
    await expect(restore).toHaveCount(0);
  } finally {
    writeFileSync(
      testInfo.outputPath("independent-cards-runtime.json"),
      JSON.stringify({
        requests,
        before,
        after: await draftProject(page),
        secondBytes,
      }),
      { mode: 0o600 },
    );
  }
});
test("S5-R4 不同generation复用commandId却改变原请求须隔离", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page),
    card = before.cards[0];
  const key = "forkwise:recovery:v1:reused-command";
  const oldCommand = {
    commandId: crypto.randomUUID(),
    projectId,
    type: "body.edit",
    expected: card.body.versionId,
    payload: { id: card.id, text: "较早恢复正文" },
  };
  const latestCommand = {
    ...oldCommand,
    commandId: oldCommand.commandId,
    payload: { id: card.id, text: "必须保护的最新恢复正文" },
  };
  const projection = (command: typeof oldCommand) => ({
    projectId,
    cardId: card.id,
    field: "body",
    value: command.payload.text,
    expected: command.expected,
    generation: 1,
    command,
  });
  const raw =
    "\n" +
    JSON.stringify(
      {
        schema: 1,
        projectId,
        cardId: card.id,
        closed: [projection(oldCommand)],
        drafts: [{ ...projection(latestCommand), generation: 2 }],
        pending: null,
      },
      null,
      2,
    ) +
    "\n";
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key,
    raw,
  });
  const requests: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/mapping/execute"))
      requests.push(request.postDataJSON());
  });
  try {
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    const restore = page.getByRole("button", { name: "恢复草稿", exact: true });
    // On RED follow the vulnerable handoff through its real write and readback.
    if (await restore.count()) {
      await restore.click();
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
    }
    await expect(
      page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复"),
    ).toBeVisible();
    expect(requests).toEqual([]);
    expect(await draftProject(page)).toEqual(before);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    const valid = await seedRecoveryJournal(
      page,
      projectId,
      card,
      "独立合法草稿可恢复",
    );
    await page.reload();
    await expect(restore).toHaveCount(1);
    await restore.click();
    await expect
      .poll(async () => (await draftProject(page)).cards[0].body.blocks[0].text)
      .toBe("独立合法草稿可恢复");
    expect(requests).toEqual([valid]);
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
      "独立合法草稿可恢复",
    );
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(restore).toHaveCount(0);
  } finally {
    writeFileSync(
      testInfo.outputPath("reused-command-runtime.json"),
      JSON.stringify({
        raw,
        oldCommand,
        latestCommand,
        requests,
        before,
        after: await draftProject(page),
        retained: await page.evaluate((key) => localStorage.getItem(key), key),
        status: await page.getByRole("status").innerText(),
      }),
      { mode: 0o600 },
    );
    await page.screenshot({ path: testInfo.outputPath("reused-command.png") });
  }
});

test("S5-R4 合法未生成command的重复投影共享媒体要求与首次生成的原请求", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page),
    card = before.cards[0];
  const bare = {
    projectId,
    cardId: card.id,
    field: "body",
    value: "媒体资源仍未持久化",
    expected: card.body.versionId,
    generation: 1,
  };
  const journal = {
    schema: 1,
    projectId,
    cardId: card.id,
    pending: null,
    closed: [bare],
    drafts: [
      { ...bare, requiredAssetIds: ["first-resource", "second-resource"] },
    ],
  };
  await page.evaluate(
    (journal) =>
      localStorage.setItem(
        "forkwise:recovery:v1:bare-media",
        JSON.stringify(journal),
      ),
    journal,
  );
  const requests: Extract<Command, { type: "body.edit" }>[] = [],
    codes: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      requests.push(r.postDataJSON());
  });
  page.on("response", async (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      codes.push((await r.json()).code ?? "ACK");
  });
  try {
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await expect.poll(() => codes.length).toBeGreaterThan(0);
    expect(requests[0].payload.requiredAssetIds).toEqual([
      "first-resource",
      "second-resource",
    ]);
    expect(codes[0]).toBe("MEDIA_NOT_PERSISTED");
    await page.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect.poll(() => codes.length).toBe(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(codes).toEqual(["MEDIA_NOT_PERSISTED", "MEDIA_NOT_PERSISTED"]);
    expect(await draftProject(page)).toEqual(before);
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await expect.poll(() => codes.length).toBe(3);
    expect(requests[2]).toEqual(requests[0]);
    expect(codes[2]).toBe("MEDIA_NOT_PERSISTED");
    expect(await draftProject(page)).toEqual(before);
  } finally {
    writeFileSync(
      testInfo.outputPath("bare-media-runtime.json"),
      JSON.stringify({
        journal,
        requests,
        codes,
        before,
        after: await draftProject(page),
      }),
      { mode: 0o600 },
    );
    await page.screenshot({ path: testInfo.outputPath("bare-media.png") });
  }
});
test("S5-R4 非法command占位不能当作尚未生成的合法重复投影", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page),
    card = before.cards[0];
  const key = "forkwise:recovery:v1:invalid-command-projection";
  const oldCommand = {
    commandId: crypto.randomUUID(),
    projectId,
    type: "body.edit",
    expected: card.body.versionId,
    payload: { id: card.id, text: "较早恢复正文" },
  };
  const latestCommand = {
    ...oldCommand,
    commandId: crypto.randomUUID(),
    payload: { id: card.id, text: "较早恢复正文" },
  };
  const projection = (command: typeof oldCommand) => ({
    projectId,
    cardId: card.id,
    field: "body",
    value: command.payload.text,
    expected: command.expected,
    generation: 1,
    command,
  });
  const raw =
    "\n" +
    JSON.stringify(
      {
        schema: 1,
        projectId,
        cardId: card.id,
        closed: [projection(oldCommand)],
        drafts: [{ ...projection(latestCommand), command: false }],
        pending: null,
      },
      null,
      2,
    ) +
    "\n";
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key,
    raw,
  });
  const requests: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/mapping/execute"))
      requests.push(request.postDataJSON());
  });
  try {
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    const restore = page.getByRole("button", { name: "恢复草稿", exact: true });
    // On RED follow the vulnerable handoff through its real write and readback.
    if (await restore.count()) {
      await restore.click();
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
    }
    await expect(
      page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复"),
    ).toBeVisible();
    expect(requests).toEqual([]);
    expect(await draftProject(page)).toEqual(before);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    const valid = await seedRecoveryJournal(
      page,
      projectId,
      card,
      "独立合法草稿可恢复",
    );
    await page.reload();
    await expect(restore).toHaveCount(1);
    await restore.click();
    await expect
      .poll(async () => (await draftProject(page)).cards[0].body.blocks[0].text)
      .toBe("独立合法草稿可恢复");
    expect(requests).toEqual([valid]);
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
      "独立合法草稿可恢复",
    );
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(restore).toHaveCount(0);
  } finally {
    writeFileSync(
      testInfo.outputPath("invalid-command-projection-runtime.json"),
      JSON.stringify({
        raw,
        oldCommand,
        latestCommand,
        requests,
        before,
        after: await draftProject(page),
        retained: await page.evaluate((key) => localStorage.getItem(key), key),
        status: await page.getByRole("status").innerText(),
      }),
      { mode: 0o600 },
    );
    await page.screenshot({
      path: testInfo.outputPath("invalid-command-projection.png"),
    });
  }
});
test("S5-R4 合法重复投影允许资源集合与对象键顺序不同，原请求保持", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page),
    card = before.cards[0];
  const bare = {
    projectId,
    cardId: card.id,
    field: "body",
    value: "媒体资源仍未持久化",
    expected: card.body.versionId,
    generation: 1,
  };
  const command = {
    commandId: crypto.randomUUID(),
    projectId,
    type: "body.edit",
    expected: bare.expected,
    payload: {
      id: card.id,
      text: bare.value,
      requiredAssetIds: ["first-resource", "second-resource"],
    },
  };
  const reordered = {
    payload: {
      requiredAssetIds: command.payload.requiredAssetIds,
      text: bare.value,
      id: card.id,
    },
    expected: bare.expected,
    type: command.type,
    projectId,
    commandId: command.commandId,
  };
  const journal = {
    schema: 1,
    projectId,
    cardId: card.id,
    pending: { ...bare, command },
    closed: [
      { ...bare, requiredAssetIds: ["first-resource"], command: reordered },
    ],
    drafts: [
      { ...bare, requiredAssetIds: ["second-resource", "first-resource"] },
    ],
  };
  await page.evaluate(
    (journal) =>
      localStorage.setItem(
        "forkwise:recovery:v1:reordered-projections",
        JSON.stringify(journal),
      ),
    journal,
  );
  const requests: Extract<Command, { type: "body.edit" }>[] = [],
    codes: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      requests.push(r.postDataJSON());
  });
  page.on("response", async (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      codes.push((await r.json()).code ?? "ACK");
  });
  try {
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await expect.poll(() => codes.length).toBeGreaterThan(0);
    expect(requests[0].payload.requiredAssetIds).toEqual([
      "first-resource",
      "second-resource",
    ]);
    expect(requests[0]).toEqual(command);
    expect(codes[0]).toBe("MEDIA_NOT_PERSISTED");
    await page.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect.poll(() => codes.length).toBe(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(codes).toEqual(["MEDIA_NOT_PERSISTED", "MEDIA_NOT_PERSISTED"]);
    expect(await draftProject(page)).toEqual(before);
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await expect.poll(() => codes.length).toBe(3);
    expect(requests[2]).toEqual(requests[0]);
    expect(codes[2]).toBe("MEDIA_NOT_PERSISTED");
    expect(await draftProject(page)).toEqual(before);
  } finally {
    writeFileSync(
      testInfo.outputPath("bare-media-runtime.json"),
      JSON.stringify({
        journal,
        requests,
        codes,
        before,
        after: await draftProject(page),
      }),
      { mode: 0o600 },
    );
    await page.screenshot({ path: testInfo.outputPath("bare-media.png") });
  }
});
