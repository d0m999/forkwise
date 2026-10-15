import type { Page, TestInfo } from '@playwright/test';

// This fixture uses the browser clipboard API. It never replaces that API.
// Keep original exposed flavors in memory and restore only our last observed write.
export async function preserveClipboard(page: Page, info: TestInfo) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(async () => {
    const fingerprint = async (items: ClipboardItem[]) =>
      JSON.stringify(
        await Promise.all(
          items
            .filter((item) => item.types.length)
            .map(async (item) =>
              Promise.all(
                item.types.map(async (type) => [
                  type,
                  Array.from(
                    new Uint8Array(
                      await crypto.subtle.digest(
                        'SHA-256',
                        await (await item.getType(type)).arrayBuffer(),
                      ),
                    ),
                  ),
                ]),
              ),
            ),
        ),
      );
    const items = await Promise.all(
      (await navigator.clipboard.read())
        .filter((item) => item.types.length)
        .map(
          async (item) =>
            new ClipboardItem(
              Object.fromEntries(
                await Promise.all(
                  item.types.map(async (type) => [type, await item.getType(type)]),
                ),
              ),
            ),
        ),
    );
    (window as any).__clipboardGuard = {
      items,
      fingerprint,
      initial: await fingerprint(items),
      last: null,
    };
  });
  return {
    async wrote(expectedText: string) {
      return page.evaluate(async (expectedText) => {
        const guard = (window as any).__clipboardGuard;
        const items = await navigator.clipboard.read();
        const html = await (
          await items.find((item) => item.types.includes('text/html'))?.getType('text/html')
        )?.text();
        if (
          (await navigator.clipboard.readText()) !== expectedText ||
          !html?.includes('data-forkwise-blocks=')
        )
          throw new Error(
            'Clipboard changed before own-write observation; preserve external value',
          );
        guard.last = await guard.fingerprint(items);
        return {
          api: 'navigator.clipboard.read/write',
          types: items.flatMap((item) => item.types),
        };
      }, expectedText);
    },
    async restore() {
      const result = await page.evaluate(async () => {
        const guard = (window as any).__clipboardGuard;
        const current = await guard.fingerprint(await navigator.clipboard.read());
        if (guard.last && current === guard.last) {
          if (guard.items.length) await navigator.clipboard.write(guard.items);
          else await navigator.clipboard.writeText('');
          return {
            restoration: 'restored original browser-exposed flavors',
            originalEmpty: !guard.items.length,
          };
        }
        return {
          restoration: current === guard.initial ? 'unchanged' : 'external change retained',
        };
      });
      await info.attach('clipboard-restoration', {
        body: JSON.stringify(result),
        contentType: 'application/json',
      });
    },
  };
}
