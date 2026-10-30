import { expectTextValue, readTextValue, commandBodyText } from "./text-editor-assertions";
import { observeBodyInput, bodyInputObservations } from "./body-input-fixture";
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
let failedForEvidence = true;
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
  failedForEvidence = false;
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) failedForEvidence = true;
});
test.afterAll(async () => {
  await stop();
  // Source verification retains failed synthetic SQLite inputs for diagnosis.
  if (directory && !(process.env.FORKWISE_TEST_RETAIN_FAILURE && failedForEvidence))
    rmSync(directory, { recursive: true, force: true });
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
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 350, y: 240 } });
  await page.getByLabel("卡片标题", { exact: true }).fill("初始标题");
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const projectId = new URL(page.url()).searchParams.get("project")!;
  // The fixture begins after the real measured Pose is durable. No later test
  // mistakes that initial derived write for its own draft/history request.
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const state = await (await fetch("/api/mapping/projects/" + id)).json();
        return state.cards.every(
          (c: Card) => (c.item.heightPolicy?.necessaryHeight ?? 0) > 0,
        );
      }, projectId),
    )
    .toBe(true);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.getByRole("button", { name: "编辑正文" }).click();
  return projectId;
}

async function historyState(page: Page) {
  return page.evaluate(async () => {
    const id = document
      .querySelector("[role=tab][aria-selected=true]")!
      .getAttribute("title");
    return (await fetch(`/api/mapping/projects/${id}/history`)).json();
  });
}

async function historyCard(
  page: Page,
  title = "历史卡",
  position = { x: 350, y: 240 },
) {
  await expect(
    page.getByRole("button", { name: "卡片", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "卡片", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.locator(".react-flow__pane").click({ position });
  await page.getByLabel("卡片标题", { exact: true }).fill(title);
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
}


async function draftProject(page: Page) {
  return page.evaluate(async () => {
    const id = document
      .querySelector("[role=tab][aria-selected=true]")!
      .getAttribute("title");
    return (await fetch(`/api/mapping/projects/${id}`)).json();
  });
}


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
  await expectTextValue(body, "失败后继续写的最新草稿");
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
  await expectTextValue(page.getByLabel("卡片正文", { exact: true }), "有效草稿");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("forkwise:recovery:v1:broken"),
    ),
  ).toBe("{broken");
});
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
  await expectTextValue(body, "外部已保存正文");
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
  await historyCard(page, "另一张卡", { x: 700, y: 240 });
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
  await expectTextValue(page.getByLabel("卡片正文", { exact: true }), "");
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
  await expectTextValue(body, "后来继续输入");
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
  await expectTextValue(body, "写满后仍继续输入".repeat(100));
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
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expectTextValue(body, "A");
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
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expectTextValue(body, "ABC");
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
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expectTextValue(body, "A");
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expectTextValue(body, "AP");
  await page.getByRole("button", { name: "项目导航" }).focus();
  await body.pressSequentially("B");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expectTextValue(body, "AP");
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
  await expect(page.getByRole("status")).toHaveText("有待恢复的未确认草稿");
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
    await expectTextValue(body, "恢复查询期间继续输入的新正文");
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
    await expectTextValue(body, "恢复查询期间继续输入的新正文");
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
  await expect(page.getByRole("status")).toHaveText("有待恢复的未确认草稿");
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
  await expect(page.getByRole("status")).toHaveText("有待恢复的未确认草稿");
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
  expect(commandBodyText(requests[1]!)).toBe("媒体仍未完成，继续输入的新正文");
  expect(requests[1]!.payload.requiredAssetIds).toEqual(["pending-asset"]);
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
  await expectTextValue(body, "媒体仍未完成，继续输入的新正文");
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
    await expect(page.getByRole("status")).toHaveText("有待恢复的未确认草稿");
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
        await expect(page.locator(".body-editor h2")).toHaveText("正在编辑：" + ("另一张卡片"));
        await openBody(originalCard);
        await expect(page.locator(".body-editor h2")).toHaveText(
          "正在编辑：" + (originalCard.title),
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
        await expectTextValue(page.getByLabel("卡片正文", { exact: true }), originalCard.body.blocks[0].text);
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
      await expectTextValue(page.getByLabel("卡片正文", { exact: true }), "后发明确选择的草稿");
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
  await expect(page.getByRole("status")).toHaveText("有待恢复的未确认草稿");
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
    origin + "/api/mapping/projects/" + projectId + "/map?view=index*",
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
    await expectTextValue(page.getByLabel("卡片正文", { exact: true }), "读取在途时实际输入并先获得ACK的正文");
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
    await page.unroute(
      origin + "/api/mapping/projects/" + projectId + "/map?view=index*",
    );
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
  await expect(page.getByRole("status")).toHaveText("有待恢复的未确认草稿");
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
    expect(commandBodyText(requests[1]!)).toBe("旧媒体请求等待响应时的新正文");
    expect(requests[1]!.payload.requiredAssetIds).toEqual(["pending-asset"]);
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
            value: commandBodyText(command),
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
    const keysBeforeValid = await page.evaluate(() => Object.keys(localStorage));
    const valid = await seedRecoveryJournal(
      page,
      projectId,
      card,
      "同库合法恢复正文",
    );
    const validKeys = await page.evaluate(
      (beforeKeys) => Object.keys(localStorage).filter((key) => !beforeKeys.includes(key)),
      keysBeforeValid,
    );
    expect(validKeys).toHaveLength(1);
    const validKey = validKeys[0];
    expect(validKey).toMatch(/^forkwise:recovery:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    await page.reload();
    await expect(restore).toHaveCount(1);
    await restore.click();
    await expectTextValue(page.getByLabel("卡片正文", { exact: true }), "同库合法恢复正文");
    await expect
      .poll(async () => (await draftProject(page)).cards[0].body.blocks[0].text)
      .toBe("同库合法恢复正文");
    expect(requests).toEqual([valid]);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    // A durable server readback does not establish that this browser confirmed
    // the receipt. Keep the damaged bytes while the seeded and owner journals clear.
    await page.waitForFunction(({ damagedKey, raw, validKey, projectId, cardId }) => {
      if (localStorage.getItem(damagedKey) !== raw) throw new Error("损坏恢复原串在确认期间改变");
      if (localStorage.getItem(validKey) !== null) return false;
      const prefix = "forkwise:recovery:v1:";
      return !Object.keys(localStorage).some((key) => {
        if (!key.startsWith(prefix + "[")) return false;
        const owner = JSON.parse(key.slice(prefix.length));
        return owner[1] === projectId && owner[2] === cardId;
      });
    }, { damagedKey: key, raw, validKey, projectId, cardId: card.id }, { timeout: 5000 });
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
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


test("S5-R3 损坏原串与已提交未确认正文共存，重开明确重试保持原请求和唯一变更", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page);
  const card = before.cards[0];
  const damagedKey = "forkwise:recovery:v1:pending-with-damaged";
  const damagedCommand = { commandId: crypto.randomUUID(), projectId, type: "body.edit",
    expected: card.body.versionId, payload: { id: card.id, text: "损坏记录声明未持久资源" } };
  const raw = "\n" + JSON.stringify({
    schema: 1, projectId, cardId: card.id,
    drafts: [{ projectId, cardId: card.id, field: "body", value: damagedCommand.payload.text,
      generation: 1, expected: damagedCommand.expected, requiredAssetIds: ["missing-resource"], command: damagedCommand }],
    closed: [], pending: null,
  }, null, 2) + "\n";
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: damagedKey, raw });
  await page.reload();
  await expect(page.getByRole("tab", { selected: true })).toHaveAttribute("title", projectId);
  await expect(page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复")).toBeVisible();
  await expect(page.getByRole("button", { name: "恢复草稿", exact: true })).toHaveCount(0);
  expect(await draftProject(page)).toEqual(before);
  const requests: Command[] = [], forwarded: Command[] = [];
  const responses: { status: number; body: any }[] = [];
  let release!: () => void, finishFirst!: () => void;
  const responseRelease = new Promise<void>((resolve) => { release = resolve; });
  const firstFinished = new Promise<void>((resolve) => { finishFirst = resolve; });
  const readJournals = () => page.evaluate(({ projectId, cardId }) => {
    const prefix = "forkwise:recovery:v1:";
    return Object.keys(localStorage).filter((key) => {
      if (!key.startsWith(prefix + "[")) return false;
      const owner = JSON.parse(key.slice(prefix.length));
      return owner[1] === projectId && owner[2] === cardId;
    }).map((key) => ({ key, value: JSON.parse(localStorage.getItem(key)!) }));
  }, { projectId, cardId: card.id });
  page.on("request", (request) => {
    if (request.url().endsWith("/api/mapping/execute")) {
      const command = request.postDataJSON();
      if (command.type === "body.edit") requests.push(command);
    }
  });
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "body.edit") { await route.continue(); return; }
    forwarded.push(command);
    const first = forwarded.length === 1;
    try {
      const response = await route.fetch();
      responses.push({ status: response.status(), body: await response.json() });
      if (first) await responseRelease;
      await route.fulfill({ response });
    } finally {
      if (first) finishFirst();
    }
  });
  const text = "损坏原串旁的已提交未确认正文";
  try {
    await page.getByRole("button", { name: "编辑正文", exact: true }).click();
    await page.getByLabel("卡片正文", { exact: true }).fill(text);
    await expect.poll(() => responses.length).toBe(1);
    expect(responses[0].status).toBe(200);
    await expect.poll(async () => (await draftProject(page)).cards[0].body.blocks[0].text).toBe(text);
    expect(requests).toHaveLength(1);
    const original = structuredClone(requests[0]);
    expect(original.projectId).toBe(projectId);
    expect(original.type).toBe("body.edit");
    expect(original.expected).toBe(card.body.versionId);
    expect(original.payload.id).toBe(card.id);
    expect(forwarded).toEqual([original]);
    expect(responses[0].body.commandId).toBe(original.commandId);
    expect(responses[0].body.projectId).toBe(projectId);
    const held = await readJournals();
    expect(held).toHaveLength(1);
    expect(held[0].value.pending.command).toEqual(original);
    expect(await page.evaluate((key) => localStorage.getItem(key), damagedKey)).toBe(raw);
    // A committed server write still has no delivered receipt in this browser.
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute("title", projectId);
    release();
    await firstFinished;
    const restore = page.getByRole("button", { name: "恢复草稿", exact: true });
    await expect(restore).toHaveCount(1);
    const reopened = await readJournals();
    expect(reopened).toHaveLength(1);
    expect(reopened[0].key).toBe(held[0].key);
    expect(reopened[0].value.pending.command).toEqual(original);
    expect(await page.evaluate((key) => localStorage.getItem(key), damagedKey)).toBe(raw);
    expect(requests).toEqual([original]);
    await restore.click();
    await expect.poll(() => responses.length).toBe(2);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    // Deep equality covers all canonical fields, arrays, expected and editGroup.
    // No media defaults or transport-token equality are introduced.
    expect(requests).toEqual([original, original]);
    expect(forwarded).toEqual([original, original]);
    expect(responses[1].body).toEqual(responses[0].body);
    await page.waitForFunction(({ damagedKey, raw, projectId, cardId }) => {
      if (localStorage.getItem(damagedKey) !== raw) throw new Error("损坏恢复原串在重试确认期间改变");
      const prefix = "forkwise:recovery:v1:";
      return !Object.keys(localStorage).some((key) => {
        if (!key.startsWith(prefix + "[")) return false;
        const owner = JSON.parse(key.slice(prefix.length));
        return owner[1] === projectId && owner[2] === cardId;
      });
    }, { damagedKey, raw, projectId, cardId: card.id }, { timeout: 5000 });
    let afterRevision = before.project.revision;
    let snapshot: string | undefined;
    const pages: any[] = [];
    for (;;) {
      const query = new URLSearchParams({ after: String(afterRevision) });
      if (snapshot) query.set("snapshot", snapshot);
      const response = await page.request.get(origin + "/api/mapping/projects/" + projectId + "/changes?" + query);
      expect(response.status()).toBe(200);
      const result = await response.json();
      expect(result.status).toBe("OK");
      expect(typeof result.complete).toBe("boolean");
      if (snapshot) expect(result.snapshot).toBe(snapshot);
      else snapshot = result.snapshot;
      pages.push(result);
      if (result.complete) break;
      expect(typeof result.nextRevision).toBe("number");
      afterRevision = result.nextRevision;
    }
    const changes = pages.flatMap((page) => page.changes).filter((change) => change.commandId === original.commandId);
    expect(changes).toHaveLength(1);
    expect(changes[0].projectId).toBe(projectId);
    expect(changes[0].actor).toEqual({ id: "local-owner", type: "human" });
    expect(changes[0].domains).toEqual([{ domain: "body", id: card.body.id }]);
    expect(changes[0].before.body.versionId).toBe(original.expected);
    expect(changes[0].after.body.versionId).toBe(responses[0].body.versions.body);
    expect(changes[0].after.body.blocks[0].text).toBe(text);
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute("title", projectId);
    await expect(restore).toHaveCount(0);
    expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(text);
    expect(await page.evaluate((key) => localStorage.getItem(key), damagedKey)).toBe(raw);
    expect(requests).toEqual([original, original]);
    await testInfo.attach("damaged-pending-retry-runtime", { contentType: "application/json",
      body: JSON.stringify({ projectId, original, requests, forwarded, responses, held, reopened, pages,
        damagedRaw: raw, retained: await page.evaluate((key) => localStorage.getItem(key), damagedKey) }) });
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
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
          value: commandBodyText(original),
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
      await expectTextValue(page.getByLabel("卡片正文", { exact: true }), commandBodyText(original));
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
    expect(requests[1].payload).toEqual({ id: card.id, blocks: remote.cards[0].body.blocks });
    expect(commandBodyText(requests[1])).toBe("实际已保存的远端正文");
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
    value: commandBodyText(command),
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
    value: commandBodyText(command),
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
    value: commandBodyText(command),
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
        value: commandBodyText(bodyCommand),
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
    value: commandBodyText(command),
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
  // Remove this fixture's interception before navigation starts new bootstrap requests.
  await page.unroute("**/api/mapping/execute");
  await page.reload();
  await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
    "title",
    projectId,
  );
  const requests: Command[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      requests.push(r.postDataJSON());
  });
  try {
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await expectTextValue(body, "最新generation必须实际保存");
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
    value: commandBodyText(command),
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
    value: commandBodyText(command),
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

test("S5-R5 closed-only媒体拒绝保留可见输入和缓存，原请求重试及刷新仍可恢复", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page);
  const card: Card = before.cards[0];
  const text = "只有closed的最后未确认正文";
  const original = await seedRecoveryJournal(page, projectId, card, text, [
    "pending-resource",
  ]);
  const journal = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith("forkwise:recovery:v1:"),
    )!;
    const value = JSON.parse(localStorage.getItem(key)!);
    value.closed = value.drafts;
    value.drafts = [];
    localStorage.setItem(key, JSON.stringify(value));
    return value;
  });
  const history = async () =>
    (
      await page.request.get(
        origin + `/api/mapping/projects/${projectId}/history`,
      )
    ).json();
  const historyBefore = await history();
  const requests: Command[] = [],
    codes: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      requests.push(r.postDataJSON());
  });
  page.on("response", async (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      codes.push((await r.json()).code);
  });
  const cache = () =>
    page.evaluate(() =>
      Object.keys(localStorage)
        .filter((k) => k.startsWith("forkwise:recovery:v1:"))
        .map((k) => ({ key: k, raw: localStorage.getItem(k)! })),
    );
  const body = page.getByLabel("卡片正文", { exact: true });
  try {
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("所需媒体尚未持久保存");
    await expect.poll(() => codes).toEqual(["MEDIA_NOT_PERSISTED"]);
    expect(requests).toEqual([original]);
    expect(await draftProject(page)).toEqual(before);
    expect(await history()).toEqual(historyBefore);
    await expectTextValue(body, text);
    expect((await cache()).some((x) => x.raw.includes(text))).toBe(true);
    await expect(page.getByRole("status")).toHaveText("保存未完成");
    await page.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect
      .poll(() => codes)
      .toEqual(["MEDIA_NOT_PERSISTED", "MEDIA_NOT_PERSISTED"]);
    expect(requests).toEqual([original, original]);
    await expectTextValue(body, text);
    expect((await cache()).some((x) => x.raw.includes(text))).toBe(true);
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    await expect(page.getByLabel("草稿恢复")).toContainText(text);
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await expect
      .poll(() => codes)
      .toEqual(Array(3).fill("MEDIA_NOT_PERSISTED"));
    expect(requests).toEqual([original, original, original]);
    await expectTextValue(body, text);
    expect(await draftProject(page)).toEqual(before);
    expect(await history()).toEqual(historyBefore);
    expect((await cache()).some((x) => x.raw.includes(text))).toBe(true);
  } finally {
    writeFileSync(
      testInfo.outputPath("closed-only-rejection-runtime.json"),
      JSON.stringify({
        journal,
        original,
        requests,
        codes,
        before,
        after: await draftProject(page),
        historyBefore,
        historyAfter: await history(),
        visible: await page.evaluate(
          () =>
            document.querySelector<HTMLElement>("#card-body")?.innerText ??
            null,
        ),
        cache: await cache(),
      }),
      { mode: 0o600 },
    );
    await page.screenshot({
      path: testInfo.outputPath("closed-only-rejection.png"),
    });
  }
});

test("S5-R5 queued-only丢ACK保留可见输入，明确重试原请求只持久写入一次", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page);
  const card: Card = before.cards[0];
  const text = "只有队列投影的未知结果正文";
  const original = await seedRecoveryJournal(page, projectId, card, text);
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith("forkwise:recovery:v1:"),
    )!;
    const value = JSON.parse(localStorage.getItem(key)!);
    value.closed = value.drafts;
    value.drafts = [];
    localStorage.setItem(key, JSON.stringify(value));
  });
  const requests: Command[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      requests.push(r.postDataJSON());
  });
  await page.route(
    "**/api/mapping/execute",
    async (route) => {
      await route.fetch();
      await route.abort();
    },
    { times: 1 },
  );
  const body = page.getByLabel("卡片正文", { exact: true });
  try {
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(requests).toEqual([original]);
    const committed = await draftProject(page);
    expect(committed.cards[0].body.blocks[0].text).toBe(text);
    await expectTextValue(body, text);
    await page.unroute("**/api/mapping/execute");
    await page.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(requests).toEqual([original, original]);
    expect(await draftProject(page)).toEqual(committed);
    const changes = await (
      await page.request.get(
        origin + `/api/mapping/projects/${projectId}/changes?after=0`,
      )
    ).json();
    expect(
      changes.changes.filter(
        (c: { commandId: string }) => c.commandId === original.commandId,
      ),
    ).toHaveLength(1);
    await body.fill("未知原请求确认后的新一代正文");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(requests).toHaveLength(3);
    expect(requests[2].commandId).not.toBe(original.commandId);
    expect(requests[2].expected).toBe(committed.cards[0].body.versionId);
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    await page.getByRole("button", { name: "编辑正文", exact: true }).click();
    await expectTextValue(body, "未知原请求确认后的新一代正文");
    expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
      "未知原请求确认后的新一代正文",
    );
    await expect(
      page.getByRole("button", { name: "恢复草稿", exact: true }),
    ).toHaveCount(0);
  } finally {
    await page.unroute("**/api/mapping/execute");
    writeFileSync(
      testInfo.outputPath("queued-unknown-runtime.json"),
      JSON.stringify({
        original,
        requests,
        before,
        after: await draftProject(page),
        visible: await page.evaluate(
          () =>
            document.querySelector<HTMLElement>("#card-body")?.innerText ??
            null,
        ),
        cache: await page.evaluate(() =>
          Object.keys(localStorage)
            .filter((k) => k.startsWith("forkwise:recovery:v1:"))
            .map((k) => localStorage.getItem(k)),
        ),
      }),
      { mode: 0o600 },
    );
    await page.screenshot({ path: testInfo.outputPath("queued-unknown.png") });
  }
});

for (const refusal of [
  "MEDIA_NOT_PERSISTED",
  "INVALID_COMMAND",
  "TOO_LARGE",
] as const) {
  test(`S5-R5 pending-only真实${refusal}拒绝保留最后输入，最新纠正稿及重开保持约束`, async ({
    page,
    browser,
  }, testInfo) => {
    await openWorkspace(page);
    const projectId = await newCard(page);
    const before = await draftProject(page);
    const card: Card = before.cards[0];
    // These lengths are reachable through ordinary paste. The HTTP byte limit
    // rejects the multibyte case before Mapping's per-field length validation.
    const text =
      refusal === "INVALID_COMMAND"
        ? "x".repeat(200001)
        : refusal === "TOO_LARGE"
          ? "文".repeat(333400)
          : "pending中尚未持久化的媒体正文";
    const original = await seedRecoveryJournal(
      page,
      projectId,
      card,
      text,
      refusal === "MEDIA_NOT_PERSISTED" ? ["pending-resource"] : undefined,
    );
    const journal = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) =>
        k.startsWith("forkwise:recovery:v1:"),
      )!;
      const value = JSON.parse(localStorage.getItem(key)!);
      value.pending = value.drafts[0];
      value.drafts = [];
      localStorage.setItem(key, JSON.stringify(value));
      return value;
    });
    const history = async () =>
      (
        await page.request.get(
          origin + `/api/mapping/projects/${projectId}/history`,
        )
      ).json();
    const historyBefore = await history();
    const requests: Command[] = [],
      codes: string[] = [];
    const reopenedTimeline: unknown[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/mapping/execute"))
        requests.push(r.postDataJSON());
    });
    page.on("response", async (r) => {
      if (r.url().endsWith("/api/mapping/execute"))
        codes.push((await r.json()).code ?? "ACK");
    });
    const cache = () =>
      page.evaluate(() =>
        Object.keys(localStorage)
          .filter((k) => k.startsWith("forkwise:recovery:v1:"))
          .map((k) => ({ key: k, raw: localStorage.getItem(k)! })),
      );
    const body = page.getByLabel("卡片正文", { exact: true });
    const corrected = `${refusal}之后明确编辑的最新完整正文`;
    try {
      await page.reload();
      await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
        "title",
        projectId,
      );
      await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
      await expect.poll(() => codes).toEqual([refusal]);
      expect(requests).toEqual([original]);
      await expectTextValue(body, text);
      await expect(page.getByRole("status")).toHaveText("保存未完成");
      expect((await cache()).some((x) => x.raw.includes(text))).toBe(true);
      expect(await draftProject(page)).toEqual(before);
      expect(await history()).toEqual(historyBefore);
      if (refusal === "MEDIA_NOT_PERSISTED") {
        await page
          .getByRole("button", { name: "重试保存", exact: true })
          .click();
        await expect.poll(() => codes).toEqual([refusal, refusal]);
        expect(requests).toEqual([original, original]);
      }
      await body.fill(corrected);
      await page.getByRole("button", { name: "重试保存", exact: true }).click();
      await expect
        .poll(() => codes.length)
        .toBe(refusal === "MEDIA_NOT_PERSISTED" ? 3 : 2);
      const latest = requests.at(-1)!;
      expect(latest.commandId).not.toBe(original.commandId);
      expect(latest.expected).toBe(original.expected);
      expect(latest.type).toBe("body.edit");
      if (latest.type !== "body.edit") throw new Error("Expected a body edit");
      expect(commandBodyText(latest)).toBe(corrected);
      if (refusal === "MEDIA_NOT_PERSISTED") {
        expect(latest.payload.requiredAssetIds).toEqual(["pending-resource"]);
        expect(codes).toEqual(Array(3).fill(refusal));
        expect(await draftProject(page)).toEqual(before);
        expect(await history()).toEqual(historyBefore);
        await expectTextValue(body, corrected);
        await page.reload();
        await expect(page.getByLabel("草稿恢复")).toContainText(corrected);
        await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
        await page
          .getByRole("button", { name: "恢复草稿", exact: true })
          .click();
        await expect.poll(() => codes).toEqual(Array(4).fill(refusal));
        expect(requests.at(-1)).toEqual(latest);
        await expectTextValue(body, corrected);
        expect((await cache()).some((x) => x.raw.includes(corrected))).toBe(
          true,
        );
        expect(await draftProject(page)).toEqual(before);
        expect(await history()).toEqual(historyBefore);
      } else {
        await expect(page.getByRole("status")).toHaveText("已保存到本机");
        expect(codes).toEqual([refusal, "ACK"]);
        const saved = await draftProject(page);
        expect(saved.cards[0].body.blocks[0].text).toBe(corrected);
        const changes = await (
          await page.request.get(
            origin + `/api/mapping/projects/${projectId}/changes?after=0`,
          )
        ).json();
        expect(
          changes.changes.filter(
            (c: { commandId: string }) => c.commandId === original.commandId,
          ),
        ).toHaveLength(0);
        expect(
          changes.changes.filter(
            (c: { commandId: string }) => c.commandId === latest.commandId,
          ),
        ).toHaveLength(1);
        // Release owned HTTP connections before restarting this fixture's server.
        await page.goto("about:blank");
        await test.step("Await owned validation fixture service exit", stop);
        await test.step(
          "Restart validation fixture on the same temporary SQLite",
          start,
        );
        const context = await browser.newContext();
        try {
          const reopened = await context.newPage();
          await test.step("Authorize the empty validation browser context and load workspace", () =>
            openWorkspace(reopened));
          reopenedTimeline.push({
            phase: "before-tab-click",
            target: projectId,
            selected: await reopened
              .getByRole("tab", { selected: true })
              .getAttribute("title"),
          });
          await reopened
            .getByRole("tab")
            .filter({
              has: reopened.locator(
                `small:text-is("${projectId.slice(0, 6)}")`,
              ),
            })
            .click();
          reopenedTimeline.push({
            phase: "after-tab-click-before-editor",
            target: projectId,
            selected: await reopened
              .getByRole("tab", { selected: true })
              .getAttribute("title"),
          });
          // A tab click starts an async handoff; bind the editor to its target.
          await expect(
            reopened.getByRole("tab", { selected: true }),
          ).toHaveAttribute("title", projectId);
          await reopened
            .getByRole("button", { name: "编辑正文", exact: true })
            .click();
          reopenedTimeline.push({
            phase: "after-editor-click",
            target: projectId,
            selected: await reopened
              .getByRole("tab", { selected: true })
              .getAttribute("title"),
            bodyCount: await reopened
              .getByLabel("卡片正文", { exact: true })
              .count(),
          });
          await expectTextValue(reopened.getByLabel("卡片正文", { exact: true }), corrected);
          expect(await draftProject(reopened)).toEqual(saved);
          await expect(
            reopened.getByRole("button", { name: "恢复草稿", exact: true }),
          ).toHaveCount(0);
          await reopened.screenshot({
            path: testInfo.outputPath("pending-rejection-restarted.png"),
          });
        } finally {
          await context.close();
        }
        // Reauthorize the original synthetic context solely for final readback.
        const access = JSON.parse(
          readFileSync(join(directory, "local-access.json"), "utf8"),
        );
        const diagnosticUrl = new URL(access.url);
        diagnosticUrl.searchParams.set("project", projectId);
        await page.goto(diagnosticUrl.toString());
        await expect(page).not.toHaveURL(/#token=/);
        // Removing the token precedes session authorization and project loading.
        await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
          "title",
          projectId,
        );
      }
    } finally {
      writeFileSync(
        testInfo.outputPath("pending-rejection-runtime.json"),
        JSON.stringify({
          refusal,
          journal,
          original,
          requests,
          codes,
          reopenedTimeline,
          before,
          after: (await page.getByRole("tab", { selected: true }).count())
            ? await draftProject(page)
            : null,
          originalPageSelectedTabs: await page
            .getByRole("tab", { selected: true })
            .count(),
          originalPageIsBlank: page.url() === "about:blank",
          historyBefore,
          historyAfter: page.url() === "about:blank" ? null : await history(),
          visible: await page.evaluate(
            () =>
              document.querySelector<HTMLElement>("#card-body")
                ?.innerText ?? null,
          ),
          cache: page.url() === "about:blank" ? null : await cache(),
        }),
        { mode: 0o600 },
      );
      await page.screenshot({
        path: testInfo.outputPath("pending-rejection.png"),
      });
    }
  });
}

for (const refusal of ["MEDIA_NOT_PERSISTED", "INVALID_COMMAND"] as const) {
  test(`S5-R5 ${refusal}旧拒绝晚到不覆盖后来完整输入，也不堵住最新重试`, async ({
    page,
  }, testInfo) => {
    await openWorkspace(page);
    const projectId = await newCard(page);
    const before = await draftProject(page);
    const card: Card = before.cards[0];
    const original = await seedRecoveryJournal(
      page,
      projectId,
      card,
      refusal === "INVALID_COMMAND" ? "x".repeat(200001) : "旧媒体输入等待拒绝",
      refusal === "MEDIA_NOT_PERSISTED" ? ["pending-resource"] : undefined,
    );
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) =>
        k.startsWith("forkwise:recovery:v1:"),
      )!;
      const value = JSON.parse(localStorage.getItem(key)!);
      value.closed = value.drafts;
      value.drafts = [];
      localStorage.setItem(key, JSON.stringify(value));
    });
    const hold = gate(),
      replied = gate();
    let serverCode: string | undefined;
    const requests: Command[] = [],
      codes: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/mapping/execute"))
        requests.push(r.postDataJSON());
    });
    page.on("response", async (r) => {
      if (r.url().endsWith("/api/mapping/execute"))
        codes.push((await r.json()).code ?? "ACK");
    });
    await page.route("**/api/mapping/execute", async (route) => {
      if (route.request().postDataJSON().commandId !== original.commandId)
        return route.continue();
      const response = await route.fetch();
      serverCode = (await response.json()).code;
      replied.release();
      await hold.promise;
      await route.fulfill({ response });
    });
    const history = async () =>
      (
        await page.request.get(
          origin + `/api/mapping/projects/${projectId}/history`,
        )
      ).json();
    const historyBefore = await history();
    const body = page.getByLabel("卡片正文", { exact: true });
    const latestText = `${refusal}响应晚到期间本人继续输入的最新完整正文`;
    const cache = () =>
      page.evaluate(() =>
        Object.keys(localStorage)
          .filter((k) => k.startsWith("forkwise:recovery:v1:"))
          .map((k) => ({ key: k, raw: localStorage.getItem(k)! })),
      );
    try {
      await page.reload();
      await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
        "title",
        projectId,
      );
      await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
      await replied.promise;
      expect(serverCode).toBe(refusal);
      expect(await draftProject(page)).toEqual(before);
      expect(await history()).toEqual(historyBefore);
      await body.fill(latestText);
      expect((await cache()).some((x) => x.raw.includes(latestText))).toBe(
        true,
      );
      hold.release();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect.poll(() => codes).toEqual([refusal]);
      await expectTextValue(body, latestText);
      expect((await cache()).some((x) => x.raw.includes(latestText))).toBe(
        true,
      );
      await page.unroute("**/api/mapping/execute");
      await page.getByRole("button", { name: "重试保存", exact: true }).click();
      await expect.poll(() => codes.length).toBe(2);
      expect(requests[0]).toEqual(original);
      const latest = requests[1];
      expect(latest.commandId).not.toBe(original.commandId);
      expect(latest.expected).toBe(original.expected);
      if (latest.type !== "body.edit") throw new Error("Expected a body edit");
      expect(commandBodyText(latest)).toBe(latestText);
      if (refusal === "MEDIA_NOT_PERSISTED") {
        expect(latest.payload.requiredAssetIds).toEqual(["pending-resource"]);
        expect(codes).toEqual([refusal, refusal]);
        await expect(page.getByRole("status")).toHaveText("保存未完成");
        await expectTextValue(body, latestText);
        await page
          .getByRole("button", { name: "重试保存", exact: true })
          .click();
        await expect.poll(() => codes.length).toBe(3);
        expect(requests[2]).toEqual(latest);
        expect(await draftProject(page)).toEqual(before);
        expect(await history()).toEqual(historyBefore);
        await page.reload();
        await expect(page.getByLabel("草稿恢复")).toContainText(latestText);
        await page
          .getByRole("button", { name: "恢复草稿", exact: true })
          .click();
        await expect.poll(() => codes.length).toBe(4);
        expect(requests[3]).toEqual(latest);
        await expectTextValue(body, latestText);
        expect(await draftProject(page)).toEqual(before);
        expect(await history()).toEqual(historyBefore);
      } else {
        expect(codes).toEqual([refusal, "ACK"]);
        await expect(page.getByRole("status")).toHaveText("已保存到本机");
        expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
          latestText,
        );
        const changes = await (
          await page.request.get(
            origin + `/api/mapping/projects/${projectId}/changes?after=0`,
          )
        ).json();
        expect(
          changes.changes.filter(
            (c: { commandId: string }) => c.commandId === original.commandId,
          ),
        ).toHaveLength(0);
        expect(
          changes.changes.filter(
            (c: { commandId: string }) => c.commandId === latest.commandId,
          ),
        ).toHaveLength(1);
        await page.reload();
        await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
          "title",
          projectId,
        );
        await page
          .getByRole("button", { name: "编辑正文", exact: true })
          .click();
        await expectTextValue(body, latestText);
        await expect(
          page.getByRole("button", { name: "恢复草稿", exact: true }),
        ).toHaveCount(0);
        expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
          latestText,
        );
      }
    } finally {
      hold.release();
      await page.unroute("**/api/mapping/execute");
      writeFileSync(
        testInfo.outputPath("late-refusal-runtime.json"),
        JSON.stringify({
          refusal,
          serverCode,
          original,
          latestText,
          requests,
          codes,
          before,
          after: await draftProject(page),
          historyBefore,
          historyAfter: await history(),
          visible: await page.evaluate(
            () =>
              document.querySelector<HTMLElement>("#card-body")
                ?.innerText ?? null,
          ),
          cache: await cache(),
        }),
        { mode: 0o600 },
      );
      await page.screenshot({ path: testInfo.outputPath("late-refusal.png") });
    }
  });
}

test("S5-R6 active同字段不同generation逆序须隔离原字节，不能执行旧稿或清除新稿", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const projectId = await newCard(page);
  const before = await draftProject(page);
  const card: Card = before.cards[0];
  const oldCommand: Command = {
    commandId: crypto.randomUUID(),
    projectId,
    type: "body.edit",
    expected: card.body.versionId,
    payload: { id: card.id, text: "较旧active输入" },
  };
  const newCommand: Command = {
    commandId: crypto.randomUUID(),
    projectId,
    type: "body.edit",
    expected: card.body.versionId,
    payload: { id: card.id, text: "必须保留的最新active输入" },
  };
  const draft = (
    generation: number,
    command: Extract<Command, { type: "body.edit" }>,
  ) => ({
    projectId,
    cardId: card.id,
    field: "body",
    generation,
    expected: command.expected,
    value: commandBodyText(command),
    command,
  });
  const journal = {
    schema: 1,
    projectId,
    cardId: card.id,
    drafts: [draft(2, newCommand), draft(1, oldCommand)],
    closed: [],
    pending: null,
  };
  const key = "forkwise:recovery:v1:r6-inverse-active";
  const raw = JSON.stringify(journal);
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key,
    raw,
  });
  const history = async () =>
    (
      await page.request.get(
        origin + `/api/mapping/projects/${projectId}/history`,
      )
    ).json();
  const historyBefore = await history();
  const requests: Command[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      requests.push(r.postDataJSON());
  });
  try {
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    const offered = page.getByRole("button", { name: "恢复草稿", exact: true });
    // Exercise any wrongly offered recovery to capture its actual HTTP/SQLite
    // consequence in RED; a quarantined record offers no executable entry.
    if (await offered.count()) {
      const response = page.waitForResponse((r) =>
        r.url().endsWith("/api/mapping/execute"),
      );
      await offered.click();
      await response;
      await expect(page.getByRole("status")).not.toHaveText("正在保存…");
    }
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    expect(requests).toEqual([]);
    expect(await draftProject(page)).toEqual(before);
    expect(await history()).toEqual(historyBefore);
    await expect(offered).toHaveCount(0);
    await expect(
      page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      projectId,
    );
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      raw,
    );
    await expect(offered).toHaveCount(0);
    await expect(
      page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    expect(await draftProject(page)).toEqual(before);
    expect(await history()).toEqual(historyBefore);
  } finally {
    writeFileSync(
      testInfo.outputPath("inverse-active-runtime.json"),
      JSON.stringify({
        key,
        raw,
        journal,
        requests,
        before,
        after: await draftProject(page),
        historyBefore,
        historyAfter: await history(),
        retained: await page.evaluate((key) => localStorage.getItem(key), key),
        visible: await page.evaluate(
          () =>
            document.querySelector<HTMLElement>("#card-body")?.innerText ??
            null,
        ),
      }),
      { mode: 0o600 },
    );
    await page.screenshot({ path: testInfo.outputPath("inverse-active.png") });
  }
});

for (const scenario of [
  "forward-body",
  "reverse-media",
  "forward-title",
] as const) {
  test(`S5-R6 ${scenario}坏active原件隔离，其它合法key保存及后来编辑均不清原件`, async ({
    page,
  }, testInfo) => {
    await openWorkspace(page);
    const projectId = await newCard(page);
    const before = await draftProject(page);
    const card: Card = before.cards[0];
    const field = scenario === "forward-title" ? "title" : "body";
    const expected = field === "title" ? card.versionId : card.body.versionId;
    const oldValue =
      scenario === "reverse-media" ? "同文但资源要求不同" : "旧active完整输入";
    const newValue =
      scenario === "reverse-media" ? oldValue : "新active完整输入";
    const original = (text: string, resources?: string[]): Command =>
      field === "title"
        ? {
            commandId: crypto.randomUUID(),
            projectId,
            type: "thought.title",
            expected,
            payload: { id: card.id, title: text },
          }
        : {
            commandId: crypto.randomUUID(),
            projectId,
            type: "body.edit",
            expected,
            payload: {
              id: card.id,
              text,
              ...(resources ? { requiredAssetIds: resources } : {}),
            },
          };
    const oldCommand = original(oldValue),
      newCommand = original(
        newValue,
        scenario === "reverse-media" ? ["pending-resource"] : undefined,
      );
    const old = {
      projectId,
      cardId: card.id,
      field,
      expected,
      generation: 1,
      value: oldValue,
      command: oldCommand,
    };
    const latest = {
      projectId,
      cardId: card.id,
      field,
      expected,
      generation: 2,
      value: newValue,
      command: newCommand,
      ...(scenario === "reverse-media"
        ? { requiredAssetIds: ["pending-resource"] }
        : {}),
    };
    const journal = {
      schema: 1,
      projectId,
      cardId: card.id,
      drafts: scenario === "reverse-media" ? [latest, old] : [old, latest],
      pending: null,
      closed: [],
    };
    const key = "forkwise:recovery:v1:r6-" + scenario,
      raw = JSON.stringify(journal);
    await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
      key,
      raw,
    });
    const goodText = "独立合法key的正文恢复";
    const valid = await seedRecoveryJournal(page, projectId, card, goodText);
    const history = async () =>
      (
        await page.request.get(
          origin + `/api/mapping/projects/${projectId}/history`,
        )
      ).json();
    const historyBefore = await history();
    const requests: Command[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/mapping/execute"))
        requests.push(r.postDataJSON());
    });
    try {
      await page.reload();
      await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
        "title",
        projectId,
      );
      await expect(
        page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "恢复草稿", exact: true }),
      ).toHaveCount(1);
      await expect(page.getByLabel("草稿恢复")).toContainText(goodText);
      expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
        raw,
      );
      expect(requests).toEqual([]);
      expect(await draftProject(page)).toEqual(before);
      expect(await history()).toEqual(historyBefore);
      await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("部分恢复记录未确认");
      expect(requests).toEqual([valid]);
      const saved = await draftProject(page);
      expect(saved.cards[0].body.blocks[0].text).toBe(goodText);
      expect(saved.cards[0].title).toBe(card.title);
      expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
        raw,
      );
      const changes = await (
        await page.request.get(
          origin + `/api/mapping/projects/${projectId}/changes?after=0`,
        )
      ).json();
      expect(
        changes.changes.filter((c: { commandId: string }) =>
          [oldCommand.commandId, newCommand.commandId].includes(c.commandId),
        ),
      ).toHaveLength(0);
      expect(
        changes.changes.filter(
          (c: { commandId: string }) => c.commandId === valid.commandId,
        ),
      ).toHaveLength(1);
      await page.reload();
      await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
        "title",
        projectId,
      );
      await expect(
        page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
      expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
        raw,
      );
      await expect(
        page.getByRole("button", { name: "恢复草稿", exact: true }),
      ).toHaveCount(0);
      expect(await draftProject(page)).toEqual(saved);
      await page.getByRole("button", { name: "编辑正文", exact: true }).click();
      await page
        .getByLabel("卡片正文", { exact: true })
        .fill("合法保存之后的实际编辑仍保留损坏原件");
      await expect(page.getByRole("status")).toHaveText("部分恢复记录未确认");
      expect(requests).toHaveLength(2);
      expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
        raw,
      );
      expect((await draftProject(page)).cards[0].body.blocks[0].text).toBe(
        "合法保存之后的实际编辑仍保留损坏原件",
      );
      await page.reload();
      await expect(
        page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
      expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
        raw,
      );
    } finally {
      writeFileSync(
        testInfo.outputPath("active-quarantine-runtime.json"),
        JSON.stringify({
          scenario,
          key,
          raw,
          journal,
          valid,
          requests,
          before,
          after: await draftProject(page),
          historyBefore,
          historyAfter: await history(),
          retained: await page.evaluate(
            (key) => localStorage.getItem(key),
            key,
          ),
        }),
        { mode: 0o600 },
      );
      await page.screenshot({
        path: testInfo.outputPath("active-quarantine.png"),
      });
    }
  });
}

for (const queue of ["pending", "closed"] as const) {
  test(`S5-R6 合法${queue}前代未知请求与最新active恢复，原请求只写一次且ACK不吞最新稿`, async ({
    page,
  }, testInfo) => {
    await openWorkspace(page);
    const projectId = await newCard(page);
    const before = await draftProject(page);
    const card: Card = before.cards[0];
    const prefix = "已真实落盘但ACK丢失的前代正文";
    const latestText = "前代仍未知时本人继续输入的最新完整正文";
    const requests: Extract<Command, { type: "body.edit" }>[] = [];
    page.on("request", (r) => {
      if (
        r.url().endsWith("/api/mapping/execute") &&
        r.postDataJSON().type === "body.edit"
      )
        requests.push(r.postDataJSON());
    });
    let committed = false;
    await page.route("**/api/mapping/execute", async (route) => {
      if (route.request().postDataJSON().type !== "body.edit")
        return route.continue();
      if (!committed) {
        await route.fetch();
        committed = true;
      }
      await route.abort();
    });
    const body = page.getByLabel("卡片正文", { exact: true });
    let captured: unknown;
    try {
      await body.fill(prefix);
      await expect(page.getByRole("alert")).toBeVisible();
      const original = requests[0];
      const persistedPrefix = await draftProject(page);
      expect(persistedPrefix.cards[0].body.blocks[0].text).toBe(prefix);
      await body.fill(latestText);
      // Capture the actual producer journal after later typing. Moving the
      // original from pending to closed exercises the supported queue variant,
      // without inventing versions, generations, payloads or idempotency keys.
      captured = await page.evaluate((queue) => {
        const key = Object.keys(localStorage).find((k) =>
          k.startsWith("forkwise:recovery:v1:"),
        )!;
        const journal = JSON.parse(localStorage.getItem(key)!);
        if (queue === "closed") {
          if (
            !journal.closed.some(
              (d: { generation: number }) =>
                d.generation === journal.pending.generation,
            )
          )
            journal.closed.push(journal.pending);
          journal.pending = null;
          localStorage.setItem(key, JSON.stringify(journal));
        }
        return { key, raw: localStorage.getItem(key), journal };
      }, queue);
      const shape = (
        captured as {
          journal: {
            drafts: {
              generation: number;
              value: string;
              expected: string;
              command?: Command;
            }[];
            pending: { generation: number; command: Command } | null;
            closed: { generation: number; command: Command }[];
          };
        }
      ).journal;
      expect(shape.drafts).toHaveLength(1);
      expect(shape.drafts[0].value).toBe(latestText);
      expect(shape.drafts[0].command).toBeUndefined();
      expect(shape.drafts[0].expected).toBe(original.expected);
      const queued = queue === "pending" ? shape.pending! : shape.closed[0];
      expect(queued.generation).toBeLessThan(shape.drafts[0].generation);
      expect(queued.command).toEqual(original);
      await page.unroute("**/api/mapping/execute");
      await page.reload();
      await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
        "title",
        projectId,
      );
      await expect(page.getByRole("status")).toHaveText("有待恢复的未确认草稿");
      await expect(page.getByLabel("草稿恢复")).toContainText(latestText);
      await expect(
        page.getByText("部分恢复记录损坏，原件已保留；其他草稿仍可恢复", {
          exact: true,
        }),
      ).toHaveCount(0);
      const start = requests.length;
      await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
      const recovered = requests.slice(start);
      expect(recovered).toHaveLength(2);
      expect(recovered[0]).toEqual(original);
      expect(recovered[1].commandId).not.toBe(original.commandId);
      expect(commandBodyText(recovered[1])).toBe(latestText);
      expect(recovered[1].expected).toBe(
        persistedPrefix.cards[0].body.versionId,
      );
      await expectTextValue(body, latestText);
      const saved = await draftProject(page);
      expect(saved.cards[0].body.blocks[0].text).toBe(latestText);
      const changes = await (
        await page.request.get(
          origin + `/api/mapping/projects/${projectId}/changes?after=0`,
        )
      ).json();
      expect(
        changes.changes.filter(
          (c: { commandId: string }) => c.commandId === original.commandId,
        ),
      ).toHaveLength(1);
      expect(
        changes.changes.filter(
          (c: { commandId: string }) => c.commandId === recovered[1].commandId,
        ),
      ).toHaveLength(1);
      expect(
        await page.evaluate(() =>
          Object.keys(localStorage).filter((k) =>
            k.startsWith("forkwise:recovery:v1:"),
          ),
        ),
      ).toEqual([]);
      await page.reload();
      await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
        "title",
        projectId,
      );
      await page.getByRole("button", { name: "编辑正文", exact: true }).click();
      await expectTextValue(body, latestText);
      expect(await draftProject(page)).toEqual(saved);
      await expect(
        page.getByRole("button", { name: "恢复草稿", exact: true }),
      ).toHaveCount(0);
    } finally {
      await page.unroute("**/api/mapping/execute");
      writeFileSync(
        testInfo.outputPath("legal-multigeneration-runtime.json"),
        JSON.stringify({
          queue,
          captured,
          requests,
          before,
          after: await draftProject(page),
          visible: await page.evaluate(
            () =>
              document.querySelector<HTMLElement>("#card-body")
                ?.innerText ?? null,
          ),
          cache: await page.evaluate(() =>
            Object.keys(localStorage)
              .filter((k) => k.startsWith("forkwise:recovery:v1:"))
              .map((k) => localStorage.getItem(k)),
          ),
        }),
        { mode: 0o600 },
      );
      await page.screenshot({
        path: testInfo.outputPath("legal-multigeneration.png"),
      });
    }
  });
}
