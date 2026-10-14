import { expect, type Locator } from "@playwright/test";

// Observe the public text control. Legacy title/conflict textareas still use
// their value; the paragraph textbox exposes rendered text and native breaks.
export async function expectTextValue(locator: Locator, value: string | RegExp) {
  if (await locator.getAttribute("contenteditable") !== null)
    await expect(locator).toHaveText(value, { useInnerText: true });
  else await expect(locator).toHaveValue(value);
}
export async function readTextValue(locator: Locator) {
  return await locator.getAttribute("contenteditable") !== null
    ? locator.innerText() : locator.inputValue();
}
export function commandBodyText(command: { payload: { text?: string; blocks?: { text?: string }[] } }): string | undefined {
  return command.payload.blocks?.map(b => b.text ?? "").join("\n") ?? command.payload.text;
}
