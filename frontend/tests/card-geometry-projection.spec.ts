import { test, expect, place } from "./card-appearance-fixture";
import { writeFile } from "node:fs/promises";

type MeasurementGate = {
  held: number;
  delivered: number;
  release: () => void;
};

test("A9-G1 首次节点测量未完成时手调尺寸与同版本Pose一致，有限正文显示更多整行", async ({
  page,
  workspace,
}, info) => {
  // Delay the browser's outer-node notification, not its geometry or the
  // card/title observers. Mapping, persistence and DOM layout remain real.
  await page.addInitScript(() => {
    const NativeObserver = window.ResizeObserver;
    let released = false;
    const waiting = new Map<
      ResizeObserver,
      { callback: ResizeObserverCallback; entries: ResizeObserverEntry[] }
    >();
    const gate = {
      held: 0,
      delivered: 0,
      release() {
        released = true;
        for (const [observer, pending] of waiting) {
          const entries = pending.entries.filter((e) => e.target.isConnected);
          if (entries.length) {
            gate.delivered += entries.length;
            pending.callback(entries, observer);
          }
        }
        waiting.clear();
      },
    };
    window.ResizeObserver = class extends NativeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          const held = entries.filter(
            (e) => !released && e.target.matches(".react-flow__node"),
          );
          if (held.length) {
            gate.held += held.length;
            waiting.set(observer, { callback, entries: held });
          }
          const ready = entries.filter((e) => !held.includes(e));
          if (ready.length) callback(ready, observer);
        });
      }
      disconnect() {
        waiting.delete(this);
        super.disconnect();
      }
      unobserve(target: Element) {
        const pending = waiting.get(this);
        if (pending)
          pending.entries = pending.entries.filter((e) => e.target !== target);
        super.unobserve(target);
      }
    };
    Object.assign(window, { __cardMeasurementGate: gate });
  });
  const observations: unknown[] = [];
  async function projection() {
    const state = await workspace.state();
    await expect(page.locator(".workspace")).toHaveAttribute(
      "data-revision",
      String(state.project.revision),
    );
    const dom = await page.locator(".react-flow__node").evaluate((element) => {
      const node = element as HTMLElement;
      const card = node.querySelector<HTMLElement>(".thought-card")!;
      const preview = card.querySelector<HTMLElement>(".preview");
      const gate = (
        window as Window & { __cardMeasurementGate: MeasurementGate }
      ).__cardMeasurementGate;
      return {
        revision: Number(
          document.querySelector<HTMLElement>(".workspace")!.dataset.revision,
        ),
        itemId: node.dataset.id,
        node: { width: node.offsetWidth, height: node.offsetHeight },
        inline: { width: node.style.width, height: node.style.height },
        card: { width: card.offsetWidth, height: card.offsetHeight },
        preview: preview && {
          text: preview.textContent,
          lines: Number(preview.dataset.previewLines),
          height: preview.clientHeight,
          lineHeight: parseFloat(getComputedStyle(preview).lineHeight),
        },
        gate: { held: gate.held, delivered: gate.delivered },
      };
    });
    expect(dom.revision).toBe(state.project.revision);
    expect(dom.itemId).toBe(state.cards[0]!.item.id);
    const value = {
      revision: state.project.revision,
      card: state.cards[0]!,
      dom,
    };
    observations.push(value);
    return value;
  }
  try {
    await workspace.open(page);
    await place(page, "测量中的有限预览");
    const compact = await projection();
    expect(compact.card.item.heightPolicy?.necessaryHeight).toBe(59);
    expect(compact.card.item.pose.height).toBe(59);
    expect(compact.dom.node.height).toBe(59);
    expect(compact.dom.card.height).toBe(59);
    const heightHandle = page.getByRole("button", {
      name: "调整卡片尺寸：下",
      exact: true,
    });
    await heightHandle.focus();
    while ((await workspace.state()).cards[0]!.item.pose.height < 160) {
      await heightHandle.press("ArrowDown");
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
    }
    await page.getByRole("button", { name: "写字板", exact: true }).click();
    const text = Array.from(
      { length: 60 },
      (_, i) => `第${i + 1}行：完整正文保留，不另存摘要。`,
    ).join("\n");
    await page.getByLabel("卡片正文", { exact: true }).fill(text);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await expect(page.locator(".preview")).toHaveText(text);
    const before = await projection();
    expect(before.dom.gate.held).toBeGreaterThan(0);
    expect(before.dom.gate.delivered).toBe(0);
    await heightHandle.focus();
    for (let i = 0; i < 6; i++) {
      await heightHandle.press("ArrowDown");
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
    }
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.item.pose.height)
      .toBe(220);
    const after = await projection();
    expect(after.card.item.heightPolicy?.manualHeight).toBe(220);
    expect(after.dom.node.height).toBe(after.card.item.pose.height);
    expect(after.dom.card.height).toBe(after.card.item.pose.height);
    expect(after.dom.preview!.lines).toBeGreaterThan(before.dom.preview!.lines);
    expect(after.dom.preview!.height).toBe(
      after.dom.preview!.lines * after.dom.preview!.lineHeight,
    );
    expect(after.card.body).toEqual(before.card.body);
    const widthHandle = page.getByRole("button", {
      name: "调整卡片尺寸：右",
      exact: true,
    });
    await widthHandle.focus();
    await widthHandle.press("ArrowRight");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const wider = await projection();
    expect(wider.card.item.pose.width).toBe(290);
    expect(wider.dom.node.width).toBe(290);
    expect(wider.dom.card.width).toBe(290);
    expect(wider.card.item.pose.height).toBe(220);
    expect(wider.card.item.heightPolicy?.manualHeight).toBe(220);
    expect(wider.card.item.pose.x).toBe(before.card.item.pose.x);
    expect(wider.card.item.pose.y).toBe(before.card.item.pose.y);
    await page.evaluate(() =>
      (
        window as Window & { __cardMeasurementGate: MeasurementGate }
      ).__cardMeasurementGate.release(),
    );
    const measured = await projection();
    expect(measured.dom.gate.delivered).toBeGreaterThan(0);
    expect(measured.dom.node).toEqual(wider.dom.node);
    expect(measured.dom.card).toEqual(wider.dom.card);
    expect(measured.card.body).toEqual(before.card.body);
  } finally {
    // Release native notifications even on RED; fixture owns and closes the
    // context, compiled host, port and temporary SQLite directory.
    if (!page.isClosed()) {
      await page.evaluate(() =>
        (
          window as Window & { __cardMeasurementGate?: MeasurementGate }
        ).__cardMeasurementGate?.release(),
      );
    }
    const path = info.outputPath("same-revision-geometry-chain.json");
    await writeFile(path, JSON.stringify(observations), { mode: 0o600 });
    await info.attach("same-revision-geometry-chain", {
      path,
      contentType: "application/json",
    });
  }
});
