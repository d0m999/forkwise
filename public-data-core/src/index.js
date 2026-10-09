import { readFileSync } from "node:fs";
export { SecClient, SourceError, secUrl } from "./sec.js";
export { companyFacts, compareFacts } from "./facts.js";
export {
  selectCompanyFactPassages,
  validateCompanyFactPassages,
} from "./companyfact-passages.js";
export const sourceCatalog = JSON.parse(
  readFileSync(new URL("../catalog.json", import.meta.url), "utf8"),
);
export {
  resolveSubmissionDocument,
  selectSubmissionPassages,
  validateSubmissionPassages,
} from "./submission-passages.js";

export { selectSubmissionDocuments } from "./submission-documents.js";

export {
  selectSubmissionHistory,
  resolveSubmissionHistory,
  assertIndexSnapshot,
  historyUrl,
} from "./submission-history.js";
