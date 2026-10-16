import { test, expect, place } from "./writing-board-fixture";
import { twoFrameGif } from "./image-reading-fixtures";
import {
  createCanvas,
  loadImage,
} from "../../backend/node_modules/@napi-rs/canvas/index.js";
test("host缺少ImageDecoder时真实首帧与能力说明在重绘和motion变化后保持", async ({
  page,
  workspace,
}, info) => {
  await page.evaluate(() =>
    Object.defineProperty(window, "ImageDecoder", {
      value: undefined,
      configurable: true,
    }),
  );
  expect(await page.evaluate(() => typeof (window as any).ImageDecoder)).toBe(
    "undefined",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await place(page, "首帧能力说明");
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  await page.getByRole("textbox", { name: "卡片正文", exact: true }).click();
  await page.getByRole("button", { name: "插入块", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "首帧红绿.gif",
    mimeType: "image/gif",
    buffer: twoFrameGif(),
  });
  const block = page.locator(".body-image"),
    frame = block.locator("canvas"),
    button = block.getByRole("button");
  await expect(frame).toBeVisible();
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.some(
        (b) => b.type === "image",
      ),
    )
    .toBe(true);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const baseline = await workspace.state(),
    initial = await button.getAttribute("aria-label");
  async function samples(label: string) {
    const colors: number[][] = [];
    for (let i = 0; i < 6; i++) {
      const png = await frame.screenshot(),
        image = await loadImage(png),
        canvas = createCanvas(image.width, image.height);
      canvas.getContext("2d").drawImage(image, 0, 0);
      colors.push(
        Array.from(canvas.getContext("2d").getImageData(40, 30, 1, 1).data),
      );
      if (i === 0)
        await info.attach(label, { body: png, contentType: "image/png" });
      await page.waitForTimeout(70);
    }
    return colors;
  }
  const before = await samples("fallback-before");
  await frame.click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const after = await samples("fallback-after");
  expect(before.every((c) => String(c) === "255,0,0,255")).toBe(true);
  expect(after).toEqual(before);
  await expect(button).toBeDisabled();
  const state = await workspace.state();
  expect(state.project.revision).toBe(baseline.project.revision);
  expect(state.cards[0]!.body).toEqual(baseline.cards[0]!.body);
  await info.attach("fallback-capability-observation", {
    body: Buffer.from(
      JSON.stringify({
        initial,
        afterLabel: await button.getAttribute("aria-label"),
        before,
        after,
        revision: state.project.revision,
        capability:
          "ImageDecoder undefined via host capability setup; not second OS",
      }),
    ),
    contentType: "application/json",
  });
  await expect(button).toHaveAccessibleName("当前浏览器仅显示动图首帧");
});
