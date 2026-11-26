import type { Page } from "@playwright/test";
import { preserveClipboard } from "./clipboard-fixture";
import { expect, test } from "./writing-board-fixture";

async function openReferenceDialog(page: Page, reference: string) {
  await page.getByRole("button", { name: "打开卡片引用", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "打开卡片引用" });
  await dialog.getByRole("textbox", { name: "卡片引用" }).fill(reference);
  await dialog.getByRole("button", { name: "打开", exact: true }).click();
  return dialog;
}

test("复制同名卡的引用，改名、移位和更新正文后仍打开并定位原卡", async ({ page, workspace }, testInfo) => {
  const projectId = (await workspace.state()).project.id;
  const cardId = "card/甲%";
  for (const [id, text, x] of [[cardId, "原版正文", 70], ["other-card", "同名另一张的正文", 460]] as const) {
    await workspace.execute(page, {
      projectId, commandId: crypto.randomUUID(), type: "thought.create", expected: null,
      payload: { id, title: "同名卡片", text, x, y: 130 },
    });
  }
  await page.reload();
  const initial = (await workspace.state()).cards.find(card => card.id === cardId)!;
  const node = page.locator(`.react-flow__node[data-id="${initial.item.id}"]`);
  await expect(page.getByRole("button", { name: "同名卡片", exact: true })).toHaveCount(2);
  const expectedReference = `forkwise:card/${projectId}/card%2F%E7%94%B2%25`;
  const clipboard = await preserveClipboard(page, testInfo, expectedReference, false);
  try {
    await node.getByRole("button", { name: "同名卡片", exact: true }).click();
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: "复制卡片引用", exact: true }).click();
    await clipboard.wrote(expectedReference);
    const reference = await page.evaluate(() => navigator.clipboard.readText());
    expect(reference).toBe(expectedReference);

    await workspace.execute(page, {
      projectId, commandId: crypto.randomUUID(), type: "thought.title", expected: initial.versionId,
      payload: { id: cardId, title: "原卡改名" },
    });
    await expect(node.getByRole("button", { name: "原卡改名", exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("已复制卡片引用");
    // 画布会保存标题测量产生的布局版本，移动应基于画布测量完成后的版本。
    const renamed = (await workspace.state()).cards.find(card => card.id === cardId)!;
    await workspace.execute(page, {
      projectId, commandId: crypto.randomUUID(), type: "pose.move", expected: renamed.item.versionId,
      payload: { id: cardId, x: 2200, y: 1900 },
    });
    await workspace.execute(page, {
      projectId, commandId: crypto.randomUUID(), type: "body.edit", expected: initial.body.versionId,
      payload: { id: cardId, text: "已保存的最新正文" },
    });
    const saved = await workspace.state();
    const dialog = await openReferenceDialog(page, reference);
    await expect(dialog).not.toBeVisible();
    const board = page.getByRole("complementary", { name: "写字板" });
    await expect(board).toContainText("正在编辑：原卡改名");
    await expect(board.getByRole("textbox", { name: "卡片正文" })).toHaveText("已保存的最新正文");
    await expect(page.locator(".react-flow__node.selected")).toHaveAttribute("data-id", initial.item.id);
    await expect.poll(async () => {
      const [card, canvas] = await Promise.all([node.boundingBox(), page.locator(".canvas").boundingBox()]);
      if (!card || !canvas) return Infinity;
      return Math.hypot(card.x + card.width / 2 - (canvas.x + canvas.width / 2),
        card.y + card.height / 2 - (canvas.y + canvas.height / 2));
    }).toBeLessThan(2);
    expect((await workspace.state()).project.revision).toBe(saved.project.revision);
  } finally {
    await clipboard.restore();
  }
});

test("取消后晚到的引用不会打开卡片，可以从另一个项目重新打开正确项目和正文", async ({ page, workspace }) => {
  const sourceId = (await workspace.state()).project.id;
  const cardId = "source-card";
  await workspace.execute(page, {
    projectId: sourceId, commandId: crypto.randomUUID(), type: "thought.create", expected: null,
    payload: { id: cardId, title: "原项目卡片", text: "原项目的正文", x: 150, y: 170 },
  });
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  const activeProject = page.getByRole("tab", { selected: true });
  await expect(activeProject).not.toHaveAttribute("title", sourceId);
  const otherId = await activeProject.getAttribute("title");
  const reference = `forkwise:card/${sourceId}/${cardId}`;
  const endpoint = "**/api/mapping/card-reference?*";
  let arrived!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { arrived = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(endpoint, async route => {
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
  });
  try {
    const dialog = await openReferenceDialog(page, reference);
    await waiting;
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(dialog).not.toBeVisible();
    const result = page.waitForResponse(response => new URL(response.url()).pathname === "/api/mapping/card-reference");
    release();
    await result;
    await expect(activeProject).toHaveAttribute("title", otherId!);
    await expect(page.getByRole("complementary", { name: "写字板" })).toHaveCount(0);
  } finally {
    release();
    await page.unroute(endpoint);
  }
  const dialog = await openReferenceDialog(page, reference);
  await expect(dialog).not.toBeVisible();
  await expect(activeProject).toHaveAttribute("title", sourceId);
  const board = page.getByRole("complementary", { name: "写字板" });
  await expect(board.getByRole("textbox", { name: "卡片正文" })).toHaveText("原项目的正文");
  await expect(page.locator(".react-flow__node.selected")).toHaveAttribute("data-id", (await workspace.state()).cards[0]!.item.id);
});

test("工作台没有打开项目时也能通过引用打开目标", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const cardId = "card-from-empty-workspace";
  await workspace.execute(page, {
    projectId, commandId: crypto.randomUUID(), type: "thought.create", expected: null,
    payload: { id: cardId, title: "稍后可见的项目", text: "引用打开的正文", x: 150, y: 170 },
  });
  // 模拟工作台首次读取项目列表时为空，而其他窗口随后建立可访问的项目。
  await page.route("**/api/mapping/projects", route => route.fulfill({ json: [] }), { times: 1 });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await expect(page.getByRole("tab", { selected: true })).toHaveCount(0);
  const dialog = await openReferenceDialog(page, `forkwise:card/${projectId}/${cardId}`);
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("tab", { selected: true })).toHaveAttribute("title", projectId);
  const board = page.getByRole("complementary", { name: "写字板" });
  await expect(board.getByRole("textbox", { name: "卡片正文" })).toHaveText("引用打开的正文");
});
