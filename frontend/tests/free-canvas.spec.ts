import { expectTextValue } from "./text-editor-assertions";
import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import type { ProjectState } from "../src/api";

let directory: string, server: ChildProcess, origin: string;
function record(event: Record<string, unknown>) {
  const evidence = process.env.FORKWISE_ISSUE10_RESOURCE_LOG;
  if (evidence) appendFileSync(evidence, JSON.stringify({ at: new Date().toISOString(), fixturePID: process.pid, fixturePPID: process.ppid, directory, ...event }) + "\n");
}
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
  const child = server, ownedDirectory = directory;
  record({ event: "server-spawn", pid: child.pid, executable: process.execPath, port: Number(new URL(origin).port) });
  child.once("exit", (code, signal) => record({ event: "server-closed", directory: ownedDirectory, pid: child.pid, exitCode: code, signal }));
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
    const exit = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await exit;
  }
}
async function open(page: Page) {
  await page.goto(
    JSON.parse(readFileSync(join(directory, "local-access.json"), "utf8")).url,
  );
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
}
async function state(page: Page): Promise<ProjectState> {
  const projects = await (
    await page.request.get(origin + "/api/mapping/projects")
  ).json();
  return (
    await page.request.get(origin + "/api/mapping/projects/" + projects[0].id)
  ).json();
}
async function timeline(page: Page) {
  const value = await state(page);
  return (
    await page.request.get(
      origin + `/api/mapping/projects/${value.project.id}/history`,
    )
  ).json();
}
async function place(page: Page, title: string, x: number, y: number) {
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x, y } });
  await page.getByLabel("卡片标题", { exact: true }).fill(title);
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
}
// These #8 scenarios exercise deliberate free geometry/overlap, not the #9
// default title-only height. Establish real manual geometry through the same
// authorized Mapping seam, then retain every original behavioral assertion.
async function manualHeight(page: Page, height: number) {
  const value = await state(page);
  const response = await page.request.post(origin + "/api/mapping/execute", {
    headers: { Origin: origin },
    data: {
      commandId: crypto.randomUUID(),
      projectId: value.project.id,
      type: "pose.batch",
      expected: Object.fromEntries(
        value.cards.map((c) => [c.id, c.item.versionId]),
      ),
      payload: {
        poses: value.cards.map((c) => ({ id: c.id, ...c.item.pose, height })),
      },
    },
  });
  expect(response.status()).toBe(200);
  for (let i = 0; i < value.cards.length; i++)
    await expect
      .poll(
        async () =>
          (await page.locator(".react-flow__node").nth(i).boundingBox())!
            .height,
      )
      .toBe(height);
}
test.beforeEach(async ({ page }) => {
  directory = mkdtempSync(join(tmpdir(), "forkwise-free-canvas-"));
  record({ event: "allocate-directory", method: "mkdtemp-direct" });
  const port = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  origin = `http://127.0.0.1:${port}`;
  await start();
  await open(page);
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("tab", { selected: true })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  await page.context().close();
  await stop();
  rmSync(directory, { recursive: true, force: true });
  record({ event: "directory-reclaimed", method: "rmSync-returned" });
});

test("F8-01 放置后标题与创建一步，单击只选择，菜单和双击标题同入口", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await expect(page.getByLabel("卡片正文", { exact: true })).toHaveCount(0);
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 110, y: 150 } });
  const title = page.getByLabel("卡片标题", { exact: true });
  await expect(title).toBeFocused();
  await title.fill("第一行");
  await title.press("Shift+Enter");
  await title.press("a");
  await title.press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const first = await state(page);
  expect(first.cards[0]!.title).toBe("第一行\na");
  expect(first.cards[0]!.item.pose).toMatchObject({ x: 110, y: 150 });
  expect((await timeline(page)).undo).toHaveLength(1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await page.locator(".title-button").click();
  await expect(title).toHaveCount(0);
  await page.getByRole("button", { name: "编辑标题", exact: true }).click();
  await expect(title).toHaveValue("第一行\na");
  await title.fill("新标题");
  await title.press("Escape");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect((await timeline(page)).undo).toHaveLength(2);
  await page.locator(".title-button").dblclick();
  await expect(title).toHaveValue("新标题");
  await title.press("Escape");
  expect((await timeline(page)).undo).toHaveLength(2);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".title-button")).toHaveText("第一行\na");
  expect((await state(page)).cards[0]!.title).toBe("第一行\na");
  await page.screenshot({ path: info.outputPath("title-entry.png") });
});

async function marquee(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  shift = false,
) {
  const rect = (await page.locator(".react-flow__pane").boundingBox())!;
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(rect.x + from.x, rect.y + from.y);
  await page.mouse.down();
  await page.mouse.move(rect.x + to.x, rect.y + to.y, { steps: 8 });
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
}
test("F8-03 完整框选替换和Shift追加，从任一已选卡原子移动且写字板绑定原卡", async ({
  page,
}, info) => {
  await place(page, "甲", 60, 100);
  await place(page, "乙", 410, 100);
  await place(page, "丙", 810, 400);
  const before = await state(page);
  await marquee(page, { x: 40, y: 80 }, { x: 370, y: 300 });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
  await page
    .locator(".react-flow__node")
    .nth(0)
    .getByRole("button", { name: "编辑正文" })
    .click();
  await page.getByLabel("卡片正文", { exact: true }).fill("仅甲正在编辑");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await marquee(page, { x: 40, y: 80 }, { x: 705, y: 300 }, true);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await expectTextValue(page.getByLabel("卡片正文", { exact: true }), "仅甲正在编辑");
  const historyBefore = (await timeline(page)).undo.length;
  const node = page.locator(".react-flow__node").nth(1);
  const b = (await node.boundingBox())!;
  await page.mouse.move(b.x + 80, b.y + b.height - 12);
  await page.mouse.down();
  await page.mouse.move(b.x + 160, b.y + b.height + 78, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await state(page)).cards[1]!.item.pose.x)
    .toBe(490);
  const moved = await state(page);
  expect(moved.cards[0]!.item.pose).toMatchObject({ x: 140, y: 190 });
  expect(moved.cards[1]!.item.pose).toMatchObject({ x: 490, y: 190 });
  expect(moved.cards[2]!.item).toEqual(before.cards[2]!.item);
  expect((await timeline(page)).undo).toHaveLength(historyBefore + 1);
  await marquee(page, { x: 30, y: 310 }, { x: 100, y: 360 });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  await page.getByLabel("卡片正文", { exact: true }).fill("取消后仍写甲");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect((await state(page)).cards.map((c) => c.body.blocks[0]!.text)).toEqual([
    "取消后仍写甲",
    "",
    "",
  ]);
  await marquee(page, { x: 100, y: 170 }, { x: 180, y: 220 });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("selection-binding.png") });
});

async function dragCard(
  page: Page,
  index: number,
  dx: number,
  dy: number,
  alt = false,
) {
  const b = (await page.locator(".react-flow__node").nth(index).boundingBox())!;
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(b.x + 80, b.y + b.height - 12);
  await page.mouse.down();
  await page.mouse.move(b.x + 80 + dx, b.y + b.height - 12 + dy, { steps: 10 });
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
}
test("F8-04 单卡边中心吸附可见开关与Alt临时禁用，松开恢复且允许重叠", async ({
  page,
}, info) => {
  await place(page, "移动卡", 60, 100);
  await place(page, "参照卡", 610, 400);
  const toggle = page.getByRole("button", { name: "对齐吸附", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await dragCard(page, 0, 273, 93);
  expect((await state(page)).cards[0]!.item.pose).toMatchObject({
    x: 330,
    y: 193,
  });
  await toggle.click();
  await dragCard(page, 0, 3, 2);
  expect((await state(page)).cards[0]!.item.pose).toMatchObject({
    x: 333,
    y: 195,
  });
  await toggle.click();
  await dragCard(page, 0, 1, 2, true);
  expect((await state(page)).cards[0]!.item.pose).toMatchObject({
    x: 334,
    y: 197,
  });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await dragCard(page, 0, 1, 2);
  expect((await state(page)).cards[0]!.item.pose).toMatchObject({
    x: 330,
    y: 199,
  });
  await toggle.click();
  await dragCard(page, 0, 290, 220);
  const overlapped = await state(page);
  expect(overlapped.cards[0]!.item.pose).toMatchObject({ x: 620, y: 419 });
  expect(overlapped.cards[1]!.item.pose).toMatchObject({ x: 610, y: 400 });
  await page.screenshot({ path: info.outputPath("free-overlap.png") });
});

test("F8-05 尺寸调整可以覆盖邻卡，一次历史与服务重启保持完整几何", async ({
  page,
}, info) => {
  await place(page, "自由尺寸", 60, 100);
  await place(page, "邻卡不动", 400, 100);
  await manualHeight(page, 160);
  await page.locator(".title-button").first().click();
  await expect(page.locator(".react-flow__node").first()).toHaveClass(
    /selected/,
  );
  const before = await state(page);
  const count = (await timeline(page)).undo.length;
  const h = page.getByRole("button", {
    name: "调整卡片尺寸：右下",
    exact: true,
  });
  await expect(h).toBeVisible();
  const box = (await h.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 160,
    box.y + box.height / 2 + 100,
    { steps: 10 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await state(page)).cards[0]!.item.pose.width)
    .toBe(440);
  const resized = await state(page);
  expect(resized.cards[0]!.item.pose).toEqual({
    x: 60,
    y: 100,
    width: 440,
    height: 260,
  });
  expect(resized.cards[1]!).toEqual(before.cards[1]!);
  expect((await timeline(page)).undo).toHaveLength(count + 1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(async () => (await state(page)).cards[0]!.item.pose)
    .toEqual(before.cards[0]!.item.pose);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect
    .poll(async () => (await state(page)).cards[0]!.item.pose)
    .toEqual(resized.cards[0]!.item.pose);
  await page.goto("about:blank");
  await stop();
  await start();
  await open(page);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  expect((await state(page)).cards[0]!.item.pose).toEqual(
    resized.cards[0]!.item.pose,
  );
  const rendered = (await page
    .locator(".react-flow__node")
    .first()
    .boundingBox())!;
  expect(rendered.width).toBe(440);
  expect(rendered.height).toBe(260);
  await page.screenshot({ path: info.outputPath("resized-reopened.png") });
});

test("F8-06 多卡拖动Esc取消恢复预览，未变化不入历史且之后仍可操作", async ({
  page,
}, info) => {
  await place(page, "甲", 60, 100);
  await place(page, "乙", 410, 100);
  await marquee(page, { x: 40, y: 80 }, { x: 710, y: 300 });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  const before = await state(page),
    history = await timeline(page);
  const node = page.locator(".react-flow__node").first(),
    b = (await node.boundingBox())!;
  await page.mouse.move(b.x + 80, b.y + b.height - 12);
  await page.mouse.down();
  await page.mouse.move(b.x + 180, b.y + b.height + 58, { steps: 8 });
  await expect.poll(async () => (await node.boundingBox())!.x).toBe(b.x + 100);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await node.boundingBox())!.x).toBe(b.x);
  await page.mouse.up();
  expect(await state(page)).toEqual(before);
  expect(await timeline(page)).toEqual(history);
  await node.locator(".title-button").click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect(await timeline(page)).toEqual(history);
  await dragCard(page, 0, 30, 30, true);
  expect((await timeline(page)).undo).toHaveLength(history.undo.length + 1);
  await page.screenshot({ path: info.outputPath("cancel-then-move.png") });
});

test("F8-07 pointercancel恢复框选及尺寸预览，没有半批或历史", async ({
  page,
}) => {
  await place(page, "保留选卡", 60, 100);
  await place(page, "另一张", 410, 100);
  await page.locator(".title-button").first().click();
  const before = await state(page),
    history = await timeline(page);
  const pane = page.locator(".react-flow__pane"),
    rect = (await pane.boundingBox())!;
  await page.mouse.move(rect.x + 900, rect.y + 500);
  await page.mouse.down();
  await page.mouse.move(rect.x + 1100, rect.y + 650, { steps: 8 });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  // A native PointerEvent cancellation fault is injected into the real UI.
  // This does not claim an OS device disconnect or system input-method test.
  await pane.dispatchEvent("pointercancel", { pointerId: 1, bubbles: true });
  await expect(page.locator(".react-flow__selection")).toHaveCount(0);
  await expect(page.locator(".react-flow__node").first()).toHaveClass(
    /selected/,
  );
  await page.mouse.up();
  const h = page.getByRole("button", {
      name: "调整卡片尺寸：右下",
      exact: true,
    }),
    box = (await h.boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 105, box.y + 75, { steps: 8 });
  await expect
    .poll(
      async () =>
        (await page.locator(".react-flow__node").first().boundingBox())!.width,
    )
    .toBe(380);
  await h.dispatchEvent("pointercancel", { pointerId: 1, bubbles: true });
  await expect
    .poll(
      async () =>
        (await page.locator(".react-flow__node").first().boundingBox())!.width,
    )
    .toBe(280);
  await page.mouse.up();
  expect(await state(page)).toEqual(before);
  expect(await timeline(page)).toEqual(history);
});

test("F8-08 键盘激活卡片工具仍等待落点，IME事件优先及空标题Esc保留", async ({
  page,
}) => {
  await page.getByRole("button", { name: "卡片", exact: true }).press("Enter");
  await expect(
    page.getByRole("button", { name: "卡片", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 120, y: 160 } });
  const title = page.getByLabel("卡片标题", { exact: true });
  // Composition events test routing, not the native macOS candidate window.
  await title.dispatchEvent("compositionstart", { data: "" });
  await title.fill("组合输入");
  await title.press("Enter");
  await title.press("Escape");
  await expect(title).toBeVisible();
  await title.dispatchEvent("compositionend", { data: "组合输入" });
  await title.fill("");
  await title.press("Escape");
  await expect(page.locator(".title-button")).toHaveText("未命名卡片");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect((await state(page)).cards[0]!.title).toBe("");
  expect((await timeline(page)).undo).toHaveLength(1);
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 900, y: 500 } });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
});

test("F8-09 新卡可落在已有卡片上，不误开正文或修改邻卡", async ({ page }) => {
  await place(page, "旧卡", 120, 160);
  const before = await state(page);
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  await page.mouse.click(pane.x + 150, pane.y + 210);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.getByLabel("卡片标题", { exact: true })).toBeFocused();
  await page.getByLabel("卡片标题", { exact: true }).fill("重叠新卡");
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const after = await state(page);
  expect(after.cards[0]).toEqual(before.cards[0]);
  expect(after.cards[1]!.item.pose).toMatchObject({ x: 150, y: 210 });
  await expect(page.getByLabel("卡片正文", { exact: true })).toHaveCount(0);
});

test("F8-10 纯卡临时置前保内部顺序，取消恢复创建序位且不写历史", async ({
  page,
}, info) => {
  await place(page, "底卡", 60, 100);
  await place(page, "中卡", 120, 140);
  await place(page, "新卡", 180, 180);
  await manualHeight(page, 160);
  const before = await state(page),
    history = await timeline(page),
    pane = (await page.locator(".react-flow__pane").boundingBox())!;
  const top = () =>
    page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest(".react-flow__node")
          ?.getAttribute("data-id"),
      { x: pane.x + 250, y: pane.y + 240 },
    );
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 1100, y: 650 } });
  expect(await top()).toBe(before.cards[2]!.item.id);
  await page.mouse.click(pane.x + 75, pane.y + 150);
  await expect(page.locator(".react-flow__node").first()).toHaveClass(
    /selected/,
  );
  expect(await top()).toBe(before.cards[0]!.item.id);
  await marquee(page, { x: 40, y: 80 }, { x: 410, y: 315 });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  expect(await top()).toBe(before.cards[1]!.item.id);
  await page.screenshot({ path: info.outputPath("temporary-raise.png") });
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 1100, y: 650 } });
  expect(await top()).toBe(before.cards[2]!.item.id);
  expect(await state(page)).toEqual(before);
  expect(await timeline(page)).toEqual(history);
  const index = await (
    await page.request.get(
      origin + `/api/mapping/projects/${before.project.id}/map?view=index`,
    )
  ).json();
  expect(index.scope.order).toBe("creation_ordinal");
});

test("F8-11 多卡只以外框吸附，显示辅助线，拖动内Alt按下与松开恢复开关", async ({
  page,
}, info) => {
  await place(page, "甲", 60, 100);
  await place(page, "乙", 410, 100);
  await place(page, "参照", 600, 400);
  const h = page.getByRole("button", { name: "调整卡片尺寸：右", exact: true }),
    hb = (await h.boundingBox())!;
  await page.mouse.move(hb.x + 5, hb.y + 5);
  await page.mouse.down();
  await page.mouse.move(hb.x + 25, hb.y + 5, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await state(page)).cards[2]!.item.pose.width)
    .toBe(300);
  await marquee(page, { x: 40, y: 80 }, { x: 710, y: 300 });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await dragCard(page, 0, 47, 25);
  const unsnapped = await state(page);
  expect(unsnapped.cards[0]!.item.pose).toMatchObject({ x: 107, y: 125 });
  expect(unsnapped.cards[1]!.item.pose).toMatchObject({ x: 457, y: 125 });
  const node = page.locator(".react-flow__node").first(),
    b = (await node.boundingBox())!;
  await page.mouse.move(b.x + 80, b.y + b.height - 12);
  await page.mouse.down();
  await page.mouse.move(b.x + 93, b.y + b.height - 12, { steps: 5 });
  await expect(page.locator('.alignment-guide[data-axis="x"]')).toHaveCount(1);
  await page.keyboard.down("Alt");
  await expect(page.locator(".alignment-guide")).toHaveCount(0);
  await page.keyboard.up("Alt");
  await expect(page.locator('.alignment-guide[data-axis="x"]')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("outer-box-alignment.png") });
  await page.mouse.up();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const moved = await state(page);
  expect(moved.cards[0]!.item.pose).toMatchObject({ x: 120, y: 125 });
  expect(moved.cards[1]!.item.pose).toMatchObject({ x: 470, y: 125 });
});

test("F8-12 移动工具与空格临时平移，缩放只改视口，输入空格不平移", async ({
  page,
}) => {
  await place(page, "视口", 120, 160);
  const before = await state(page),
    history = await timeline(page);
  const transform = () =>
    page.locator(".react-flow__viewport").getAttribute("style");
  const initial = await transform();
  await page.getByRole("button", { name: "移动", exact: true }).click();
  await marquee(page, { x: 900, y: 500 }, { x: 980, y: 560 });
  await expect.poll(transform).not.toBe(initial);
  await page.getByRole("button", { name: "选择", exact: true }).click();
  const panned = await transform();
  await page.keyboard.down("Space");
  await marquee(page, { x: 900, y: 500 }, { x: 950, y: 530 });
  await page.keyboard.up("Space");
  await expect.poll(transform).not.toBe(panned);
  await page.getByRole("button", { name: "放大", exact: true }).click();
  expect(await state(page)).toEqual(before);
  expect(await timeline(page)).toEqual(history);
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const body = page.getByLabel("卡片正文", { exact: true });
  await body.fill("输入空格");
  const view = await transform();
  await body.press("Space");
  await expectTextValue(body, "输入空格 ");
  expect(await transform()).toBe(view);
});

test("F8-13 标题内原生逐步undo只有输入路由，外部点击保留原标题目标，正文双击沿已有入口", async ({
  page,
}, info) => {
  // This native-undo/preview scenario starts with real Body content so its
  // initial geometry has preview space. Later Body edits never manufacture it.
  const initial = await state(page);
  const created = await page.request.post(origin + "/api/mapping/execute", {
    headers: { Origin: origin },
    data: {
      commandId: crypto.randomUUID(),
      projectId: initial.project.id,
      type: "thought.create",
      expected: null,
      payload: {
        id: crypto.randomUUID(),
        title: "原标题",
        text: "初始准备正文",
        x: 120,
        y: 160,
      },
    },
  });
  expect(created.status()).toBe(200);
  await expect(page.locator(".title-button")).toHaveText("原标题");
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  await page.getByLabel("卡片正文", { exact: true }).fill("保留原正文");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.getByRole("button", { name: "关闭正文", exact: true }).click();
  await page.locator(".title-button").dblclick();
  const title = page.getByLabel("卡片标题", { exact: true });
  await title.press("Meta+a");
  await title.pressSequentially("新标题");
  // The same browser's plain-textarea control undoes one inserted Chinese
  // character per step. Completing the round still has one Mapping action.
  await title.press("Meta+z");
  await expect(title).toHaveValue("新标");
  await title.press("Meta+Shift+z");
  await expect(title).toHaveValue("新标题");
  await title.press("Meta+z");
  await title.press("Meta+z");
  await expect(title).toHaveValue("新");
  expect((await timeline(page)).undo).toHaveLength(2);
  await title.fill("点击外部保留");
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 1000, y: 600 } });
  await expect(page.locator(".title-button")).toHaveText("点击外部保留");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect((await state(page)).cards[0]!.body.blocks[0]!.text).toBe("保留原正文");
  await page.locator(".preview").dblclick();
  await expectTextValue(page.getByLabel("卡片正文", { exact: true }), "保留原正文");
  await expect(title).toHaveCount(0);
});

test("F8-14 真实UI与Agent HTTP用同snapshot读取同SQLite正文与移动几何", async ({
  page,
}, info) => {
  await place(page, "同快照", 120, 160);
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const text = "真实SQLite正文\n中文🧠";
  await page.getByLabel("卡片正文", { exact: true }).fill(text);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.getByRole("button", { name: "关闭正文", exact: true }).click();
  await dragCard(page, 0, 50, 40, true);
  const current = await state(page);
  await expect(page.locator(".workspace")).toHaveAttribute(
    "data-revision",
    String(current.project.revision),
  );
  const snapshot = (await page
    .locator(".workspace")
    .getAttribute("data-snapshot"))!;
  // A fixture host issues a real readonly Agent session through the approved
  // Mapping Interface on this exact test-owned database; no private SQL writes.
  const { openMapping } = await import(
    resolve("../backend/dist/src/mapping/storage.js")
  );
  const host = openMapping(directory);
  let token: string;
  try {
    token = host.access.issue("agent", [current.project.id]);
  } finally {
    host.close();
  }
  const endpoint = origin + `/api/mapping/projects/${current.project.id}/map`;
  const index = await (
    await page.request.get(endpoint + `?view=index&snapshot=${snapshot}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  expect(index.revision).toBe(current.project.revision);
  expect(index.items[0].item).toEqual(current.cards[0]!.item);
  expect(index.items[0].title).toBe("同快照");
  expect(index.items[0].body.versionId).toBe(current.cards[0]!.body.versionId);
  const detail = await (
    await page.request.get(
      endpoint +
        `?view=detail&snapshot=${snapshot}&cardId=${current.cards[0]!.id}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
  ).json();
  const body = JSON.parse(
    detail.items.map((i: { jsonText: string }) => i.jsonText).join(""),
  );
  expect(body).toEqual(current.cards[0]!.body);
  expect(body.blocks.map((b: { text: string }) => b.text).join("\n")).toBe(text);
  const rendered = (await page.locator(".react-flow__node").boundingBox())!,
    pane = (await page.locator(".react-flow__pane").boundingBox())!;
  expect(rendered.x - pane.x).toBe(170);
  expect(rendered.y - pane.y).toBe(200);
  writeFileSync(
    info.outputPath("same-snapshot-agent.json"),
    JSON.stringify(
      { revision: index.revision, snapshot, item: index.items[0].item, body },
      null,
      2,
    ),
  );
});

test("F8-15 尺寸手柄可键盘调整，无效方向不产生历史", async ({ page }) => {
  await place(page, "键盘尺寸", 120, 160);
  const before = await timeline(page);
  const handle = page.getByRole("button", {
    name: "调整卡片尺寸：右",
    exact: true,
  });
  await handle.press("ArrowRight");
  await expect
    .poll(async () => (await state(page)).cards[0]!.item.pose.width)
    .toBe(290);
  expect((await timeline(page)).undo).toHaveLength(before.undo.length + 1);
  const saved = await state(page),
    history = await timeline(page);
  await handle.press("ArrowUp");
  expect(await state(page)).toEqual(saved);
  expect(await timeline(page)).toEqual(history);
});
