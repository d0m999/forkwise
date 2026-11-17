import { readFileSync } from 'node:fs';
import { verifyPackage } from '../backend/src/mapping/package-verify.js';

const packagePath = process.argv[2];
if (!packagePath) {
  console.log('USAGE path expected=package actual=missing');
  process.exit(2);
}
const failures = verifyPackage(readFileSync(packagePath));
for (const failure of failures) console.log(`${failure.code} ${failure.path} expected=${failure.expected} actual=${failure.actual}`);
process.exit(failures.length === 0 ? 0 : 1);
