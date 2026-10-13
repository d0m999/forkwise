import { openMapping } from '../src/mapping/storage.js';
import type { Principal } from '../src/services/access.js';

const mapping = openMapping(process.argv[2]!, {
  checkpoint: (phase) => {
    if (phase === 'versions') {
      process.send?.({ locked: true });
      // Keep the real writer transaction open while the competing process enters.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  },
});
process.send?.({ ready: true });
process.once('message', (message: { command: unknown; actor: Principal }) => {
  try {
    const receipt = mapping.execute(message.command, message.actor);
    process.send?.({ receipt });
  } catch (error) {
    process.send?.({ code: (error as { code?: string }).code ?? String(error) });
  } finally {
    mapping.close();
    process.disconnect();
  }
});
