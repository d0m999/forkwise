export interface Snapshot {
  schemaVersion: number;
  sourceId: string;
  adapterVersion: string;
  url: string;
  dataset: string;
  cik: string;
  raw: string;
  hash: string;
  retrievedAt: string;
  httpLastModified: string | null;
  publishedAt: null;
  cached: boolean;
  path: string;
  lineage?: FilingRecord & { indexUrl: string; indexHash: string };
  history?: HistoryRecord & { indexUrl: string; indexHash: string };
}
export class SourceError extends Error {
  code: string;
  details: unknown;
}
export class SecClient {
  constructor(options: {
    userAgent: string;
    cacheDirectory: string;
    request?: typeof fetch;
  });
  fetchFiling(
    index: IndexSnapshot,
    accessionNumber: string,
    options?: {
      signal?: AbortSignal;
      cachedHash?: string;
      historyRoot?: IndexSnapshot;
    },
  ): Promise<Snapshot>;
  fetchHistory(
    index: IndexSnapshot,
    name: string,
    options?: { signal?: AbortSignal; cachedHash?: string },
  ): Promise<Snapshot>;
  fetch(
    cik: string,
    dataset?: "companyfacts" | "submissions",
    options?: { signal?: AbortSignal; cachedHash?: string },
  ): Promise<Snapshot>;
}
export function secUrl(cik: string, dataset?: string): string;
export function companyFacts(
  snapshot: Snapshot,
  query: { taxonomy: string; tag: string; unit: string; knownByDate?: string },
): { status: string; facts: Record<string, unknown>[]; gaps: string[] };
export function compareFacts(
  left: Record<string, any>,
  right: Record<string, any>,
): { status: string; differences: string[]; reason: string };
export interface CompanyFactPassage {
  start: number;
  end: number;
  text: string;
  structure: {
    format: "sec_companyfacts_v1";
    pointer: string;
    role:
      | "subject"
      | "taxonomy"
      | "concept"
      | "label"
      | "description"
      | "unit"
      | "fact";
  };
}
export interface CompanyFactSelection {
  method: "sec_companyfacts_v1";
  passages: CompanyFactPassage[];
  records: { pointer: string; gaps: string[] }[];
  matchedRecords: number;
  selectedCharacters: number;
  budgetLimited: boolean;
  candidateLimitReached: boolean;
  gaps: string[];
}
export function selectCompanyFactPassages(
  raw: string,
  options: {
    queries: string[];
    maxCharacters: number;
    expectedCik?: string;
    maxRecords?: number;
  },
): CompanyFactSelection;
export function validateCompanyFactPassages(
  raw: string,
  passages: CompanyFactPassage[],
  expectedCik?: string,
): void;
export const sourceCatalog: {
  schemaVersion: number;
  version: string;
  sources: {
    id: string;
    name: string;
    status: string;
    coverage: string[];
    limitations: string[];
    [key: string]: unknown;
  }[];
};

export interface SubmissionPassage {
  start: number;
  end: number;
  text: string;
  structure: {
    format: "sec_submissions_v1";
    pointer: string;
    role: "subject" | "filing" | "filing_field" | "history_index";
    recordPointer?: string;
  };
}
export interface SubmissionRecord {
  pointer: string;
  row: number;
  accessionNumber: string | null;
  documentUrl: string | null;
  gaps: string[];
}
export interface SubmissionSelection {
  method: "sec_submissions_v1";
  passages: SubmissionPassage[];
  records: SubmissionRecord[];
  matchedRecords: number;
  selectedCharacters: number;
  budgetLimited: boolean;
  candidateLimitReached: boolean;
  historyFileCount: number;
  gaps: string[];
}
export function selectSubmissionPassages(
  raw: string,
  options: {
    queries: string[];
    maxCharacters: number;
    expectedCik?: string;
    maxRecords?: number;
    history?: boolean;
  },
): SubmissionSelection;
export function validateSubmissionPassages(
  raw: string,
  passages: SubmissionPassage[],
  expectedCik?: string,
  options?: { history?: boolean },
): { records: SubmissionRecord[]; historyFileCount: number };

export interface FilingRecord {
  url: string;
  accessionNumber: string;
  recordPointer: string;
  primaryDocument: string;
  form: string | null;
  filingDate: string | null;
  reportDate: string | null;
}
export function resolveSubmissionDocument(
  raw: string,
  expectedCik: string,
  accessionNumber: string,
  options?: { history?: boolean },
): FilingRecord;

export interface FilingFilter {
  forms: string[];
  filedFrom: string;
  filedThrough: string;
}
export function selectSubmissionDocuments(
  raw: string,
  options: FilingFilter & {
    expectedCik: string;
    maxDocuments?: number;
    history?: boolean;
  },
): {
  documents: FilingRecord[];
  unavailable: {
    recordPointer: string;
    accessionNumber: unknown;
    error: string;
  }[];
  matchedRecords: number;
  historyFileCount: number;
  gaps: string[];
};

export type IndexSnapshot = Pick<
  Snapshot,
  "sourceId" | "dataset" | "cik" | "url" | "raw" | "hash" | "history"
>;
export interface HistoryRecord {
  name: string;
  url: string;
  recordPointer: string;
  filingFrom: string | null;
  filingTo: string | null;
  filingCount: number | null;
}
export function historyUrl(cik: string, name: string): string;
export function resolveSubmissionHistory(
  raw: string,
  expectedCik: string,
  name: string,
): HistoryRecord;
export function selectSubmissionHistory(
  raw: string,
  options: {
    expectedCik: string;
    filedFrom: string;
    filedThrough: string;
    maxFiles?: number;
  },
): {
  files: HistoryRecord[];
  listedFiles: number;
  excludedFiles: number;
  gaps: string[];
};
export function assertIndexSnapshot(
  index: IndexSnapshot,
  historyRoot?: IndexSnapshot,
): void;
