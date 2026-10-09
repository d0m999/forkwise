import { initialFilingsFixture } from './initial-filings.js';
export const historyName = 'CIK0000000001-submissions-001.json';
export const historyText = JSON.stringify({
  accessionNumber: ['0000000099-20-000001'],
  primaryDocument: ['old.htm'],
  form: ['10-Q'],
  filingDate: ['2020-04-01'],
  reportDate: ['2020-03-31'],
});
export function submissionHistoryFixture(origin?: string) {
  const f = initialFilingsFixture(origin),
    requests: string[] = [];
  const hooks: {
    fail?: boolean;
    duringHistory?: () => Promise<void>;
    raw?: string;
    overlap?: boolean;
  } = {};
  f.filingHooks.filter = { filedFrom: '2020-04-01', filedThrough: '2020-04-30' };
  f.filingHooks.includeHistory = true;
  f.hooks.response = async (url) => {
    requests.push(url);
    if (url.endsWith('/CIK0000000001.json'))
      return Response.json({
        cik: 1,
        name: 'Synthetic',
        filings: {
          recent: hooks.overlap ? JSON.parse(historyText) : {},
          files: [
            { name: historyName, filingFrom: '2020-01-01', filingTo: '2020-12-31', filingCount: 1 },
            {
              name: 'CIK0000000001-submissions-002.json',
              filingFrom: '2019-01-01',
              filingTo: '2019-12-31',
              filingCount: 10,
            },
          ],
        },
      });
    if (url.endsWith(historyName)) {
      await hooks.duringHistory?.();
      return hooks.fail
        ? new Response('', { status: 403 })
        : new Response(hooks.raw ?? historyText, {
            headers: { 'content-type': 'application/json' },
          });
    }
    return new Response('<html><body><p>Synthetic revenue: 12.</p></body></html>', {
      headers: { 'content-type': 'text/html' },
    });
  };
  return { ...f, requests, historyHooks: hooks };
}
