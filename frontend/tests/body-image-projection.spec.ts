import { test, expect, place } from "./writing-board-fixture";
test("UI编辑图片后的同revision完整HTTP-MCP JSON与SQLite重开一致", async ({
  page,
  workspace,
}, info) => {
  await place(page, "图片完整投影");
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  await page.getByRole("textbox", { name: "卡片正文", exact: true }).click();
  await page.getByRole("button", { name: "插入块", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "投影.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="green"/></svg>',
    ),
  });
  const image = page.locator(".body-image img");
  await expect(image).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await image.click();
  const grip = page.getByRole("slider", {
    name: "调整正文图片宽度",
    exact: true,
  });
  await grip.focus();
  await grip.press("ArrowLeft");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await image.click();
  await page.getByRole("button", { name: "编辑图片说明", exact: true }).click();
  await page
    .getByRole("textbox", { name: "图注", exact: true })
    .fill("完整图注");
  await page
    .getByRole("textbox", { name: "替代文字", exact: true })
    .fill("用户的图像描述");
  await page.getByRole("button", { name: "保存图片说明", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const state = await workspace.state(),
    card = state.cards[0]!;
  const snapshot = (await page
    .locator(".workspace")
    .getAttribute("data-snapshot"))!;
  const revision = Number(
    await page.locator(".workspace").getAttribute("data-revision"),
  );
  expect(revision).toBe(state.project.revision);
  let cursor: string | undefined,
    json = "";
  do {
    const query = new URLSearchParams({
      view: "detail",
      cardId: card.id,
      snapshot,
      ...(cursor ? { cursor } : {}),
    });
    const response = await page.request.get(
      `${workspace.origin}/api/mapping/projects/${state.project.id}/map?${query}`,
    );
    expect(response.ok()).toBe(true);
    const value = await response.json();
    expect(value.revision).toBe(revision);
    json += value.items.map((i: any) => i.jsonText).join("");
    cursor = value.nextCursor ?? undefined;
  } while (cursor);
  expect(JSON.parse(json).blocks).toEqual(card.body.blocks);
  const mcp = await workspace.agentBody(state.project.id, card.id, snapshot);
  expect(mcp.revision).toBe(revision);
  expect(mcp.body.blocks).toEqual(card.body.blocks);
  await workspace.restart();
  await workspace.open(page);
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(
    card.body.blocks,
  );
  await info.attach("ui-http-mcp-complete-json", {
    body: Buffer.from(
      JSON.stringify({
        revision,
        body: card.body,
        http: JSON.parse(json),
        mcp,
      }),
    ),
    contentType: "application/json",
  });
});
