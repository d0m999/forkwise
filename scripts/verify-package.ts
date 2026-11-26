import { readFileSync } from 'node:fs';

const packagePath = process.argv[2];
if (!packagePath) {
  console.log('USAGE path expected=package actual=missing');
  process.exit(2);
}
void import('../backend/src/mapping/package-verify.js').then(({ verifyPackage }) => {
  const failures = verifyPackage(readFileSync(packagePath));
  for (const failure of failures) console.log(`${failure.code} ${failure.path} expected=${failure.expected} actual=${failure.actual}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
});
