import { test, expect, place } from "./writing-board-fixture";
import { twoFrameGif } from "./image-reading-fixtures";
import {
  createCanvas,
  loadImage,
} from "../../backend/node_modules/@napi-rs/canvas/index.js";
test("普通动态偏好下可见正文GIF默认播放，离开写字板后释放媒体呈现", async ({
  page,
  workspace,
}, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await place(page, "默认动图播放");
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  await page.getByRole("textbox", { name: "卡片正文", exact: true }).click();
  await page.getByRole("button", { name: "插入块", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "默认播放.gif",
    mimeType: "image/gif",
    buffer: twoFrameGif(),
  });
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const frame = page.locator(".body-image canvas");
  await expect(frame).toBeVisible();
  await expect(
    page.getByRole("button", { name: "暂停动图", exact: true }),
  ).toBeVisible();
  const values: number[][] = [],
    saved = new Set<string>();
  for (let i = 0; i < 9; i++) {
    const screenshot = await frame.screenshot(),
      image = await loadImage(screenshot),
      canvas = createCanvas(image.width, image.height);
    canvas.getContext("2d").drawImage(image, 0, 0);
    const color = Array.from(
      canvas.getContext("2d").getImageData(40, 30, 1, 1).data,
    );
    values.push(color);
    if (!saved.has(String(color))) {
      saved.add(String(color));
      await info.attach(`normal-motion-${saved.size}`, {
        body: screenshot,
        contentType: "image/png",
      });
    }
    await page.waitForTimeout(70);
  }
  expect(values).toContainEqual([255, 0, 0, 255]);
  expect(values).toContainEqual([0, 255, 0, 255]);
  const revision = (await workspace.state()).project.revision;
  await page.getByRole("button", { name: "关闭正文", exact: true }).click();
  await expect(frame).toHaveCount(0);
  expect((await workspace.state()).project.revision).toBe(revision);
  await info.attach("normal-motion-pixels", {
    body: Buffer.from(JSON.stringify(values)),
    contentType: "application/json",
  });
});
