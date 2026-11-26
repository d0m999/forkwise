import { readFileSync } from 'node:fs';
import { SecClient } from '@forkwise/public-data-core';
import { startWorkspace } from '../../dist/src/workspace-server.js';

const raw = readFileSync(new URL('./verification-companyfacts.json', import.meta.url), 'utf8');
const withoutDisclosures = (...accessions) => raw.split('\n')
  .filter(line => !accessions.some(accession => line.includes(`"accn":"${accession}"`))).join('\n');
const conflictingAccession = '0000001234-25-000002';
const retrySnapshots = [
  raw,
  withoutDisclosures('0000001234-25-000001', conflictingAccession),
  withoutDisclosures(conflictingAccession),
];
let accesses = 0;
const client = new SecClient({
  userAgent: 'Forkwise fixture contact@example.test',
  cacheDirectory: null,
  request: async (input, options) => {
    if (String(input) !== 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000001234.json' ||
        options?.redirect !== 'error' || !new Headers(options?.headers).get('user-agent')?.includes('example.test'))
      throw new Error('测试仅允许受控 SEC 传输');
    const attempt = ++accesses;
    const scenario = process.env.FORKWISE_TEST_SEC_RETRY_SCENARIO;
    if (scenario === 'denied-retry' && attempt > 1) return new Response(null, { status: 403 });
    const snapshot = scenario === 'gaps-on-retry' ? retrySnapshots[Math.min(attempt - 1, 2)] : raw;
    return new Response(snapshot, { headers: { 'Content-Type': 'application/json', 'Last-Modified': 'Wed, 19 Mar 2025 20:00:00 GMT' } });
  },
});
await startWorkspace({ verificationSource: { client, fixture: true } });
