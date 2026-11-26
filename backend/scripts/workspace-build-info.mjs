import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';

const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const fingerprint = createHash('sha256');

async function hashBuild(directory, prefix) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1)) {
    const name = prefix + entry.name;
    const path = new URL(encodeURIComponent(entry.name) + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) await hashBuild(path, name + '/');
    else fingerprint.update(JSON.stringify([name, createHash('sha256').update(await readFile(path)).digest('hex')]));
  }
}

await hashBuild(new URL('../dist/src/', import.meta.url), 'backend/');
await hashBuild(new URL('../../frontend/dist/', import.meta.url), 'workspace/');
await hashBuild(new URL('../dist/search-vendor/', import.meta.url), 'search-vendor/');
for (const name of ['../package-lock.json', '../../frontend/package-lock.json'])
  fingerprint.update(JSON.stringify([name, createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex')]));
await writeFile(
  new URL('../dist/workspace/build-info.json', import.meta.url),
  JSON.stringify({ version: `${version} (${fingerprint.digest('hex').slice(0, 12)})` }),
);
