import { expect, type Locator } from "@playwright/test";

// Compare a real glyph with an independent 18px reference in the same canvas
// zoom. This checks visible size without depending on a CSS transform formula.
export async function expectTextFontSize(text: Locator, expected: number) {
  await expect.poll(() => text.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let glyph: Text | null = null;
    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.trim()) { glyph = walker.currentNode as Text; break; }
    }
    if (!glyph) return 0;
    const range = document.createRange(); range.setStart(glyph, 0); range.setEnd(glyph, 1);
    const actual = range.getBoundingClientRect().height;
    const style = getComputedStyle(glyph.parentElement!);
    const reference = document.createElement("span");
    Object.assign(reference.style, {
      position: "absolute", left: "-10000px", top: "-10000px", whiteSpace: "pre",
      fontFamily: style.fontFamily, fontSize: "18px", fontWeight: style.fontWeight,
      fontStyle: style.fontStyle, fontStretch: style.fontStretch,
      fontFeatureSettings: style.fontFeatureSettings, fontVariationSettings: style.fontVariationSettings,
      fontKerning: style.fontKerning, letterSpacing: style.letterSpacing,
    });
    reference.textContent = glyph.textContent![0]!;
    (element.closest(".react-flow__viewport") ?? document.body).append(reference);
    try {
      const measured = document.createRange(); measured.selectNodeContents(reference);
      return 18 * actual / measured.getBoundingClientRect().height;
    } finally { reference.remove(); }
  })).toBeCloseTo(expected, 2);
}
