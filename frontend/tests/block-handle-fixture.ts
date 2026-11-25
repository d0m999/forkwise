import type { Locator } from '@playwright/test';

export async function clickBlockHandle(handle: Locator, extend = false) {
  await handle.locator('..').hover();
  await handle.click(extend ? { modifiers: ['Shift'] } : {});
}
