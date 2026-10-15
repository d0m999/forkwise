import type { Page, TestInfo } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// This fixture uses the browser clipboard API. It never replaces that API.
// Keep original exposed flavors in memory and restore only our last observed write.
export async function preserveClipboard(
  page: Page,
  info: TestInfo,
  declaredText?: string,
  structured = true,
) {
  const native = process.env.FORKWISE_NATIVE_CLIPBOARD_GUARD;
  const directory = native ? mkdtempSync(join(tmpdir(), 'clipboard-guard-')) : undefined;
  const original = directory && join(directory, 'original.json');
  let own: string | undefined,
    sequence = 0;
  const command = (...args: string[]) => execFileSync(native!, args, { encoding: 'utf8' }).trim();
  if (native) command('save', original!);
  const captureOwn = (text: string) => {
    if (!native) return;
    if (spawnSync(native, ['check', original!]).status === 0) return;
    const next = join(directory!, `own-${sequence++}.json`);
    // Deliberately accept only this complete, declared native item. A native
    // HTML/UTF16/vendor flavor is an unknown write, even if UTF8 text matches.
    const expected = join(directory!, `expected-${sequence}.json`);
    writeFileSync(
      expected,
      JSON.stringify({
        changeCount: -1,
        items: [
          [
            {
              type: 'public.utf8-plain-text',
              base64: Buffer.from(text, 'utf8').toString('base64'),
            },
          ],
        ],
      }),
      { flag: 'wx', mode: 0o600 },
    );
    command('save-own-exact', next, expected);
    own = next; // Record ownership before any behavior assertions.
  };
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
                await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
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
      if (declaredText !== undefined && declaredText !== expectedText)
        throw new Error('Synthetic text differs from the declared write');
      await page.evaluate(async (text) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((await navigator.clipboard.readText()) === text) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('Expected synthetic browser write not observed');
      }, expectedText);
      captureOwn(expectedText);
      return page.evaluate(
        async ({ expectedText, structured }) => {
          const guard = (window as any).__clipboardGuard;
          const items = await navigator.clipboard.read();
          const html = await (
            await items.find((item) => item.types.includes('text/html'))?.getType('text/html')
          )?.text();
          if (
            (await navigator.clipboard.readText()) !== expectedText ||
            (structured && !html?.includes('data-forkwise-blocks='))
          )
            throw new Error(
              'Clipboard changed before own-write observation; preserve external value',
            );
          if (
            !structured &&
            (items.length !== 1 ||
              items[0]!.types.length !== 1 ||
              items[0]!.types[0] !== 'text/plain')
          )
            throw new Error('Unexpected complete browser flavor set; external value retained');
          guard.last = await guard.fingerprint(items);
          return {
            api: 'navigator.clipboard.read/write',
            types: items.flatMap((item) => item.types),
          };
        },
        { expectedText, structured },
      );
    },
    async restore() {
      if (native) {
        // Never reacquire ownership during cleanup: an external rewrite may
        // contain identical bytes with a different changeCount.
        const unchanged = spawnSync(native, ['check', original!]).status === 0;
        if (!unchanged) {
          if (!own)
            throw new Error(
              'Native clipboard changed without owned write; external value retained',
            );
          const result = command('restore', original!, own);
          await info.attach('native-clipboard-restoration', {
            body: JSON.stringify({ result, original, own, atomicCAS: false }),
            contentType: 'application/json',
          });
          return;
        }
      }
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
      if (native) command('check', original!);
    },
  };
}
