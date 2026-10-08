/**
 * MIRROR of `apps/api/src/common/document-prefix.ts` (B1188 / SA-723): the API owns the rule, web
 * mirrors it because the API cannot value-import `@routeflow/types`. Pure and dependency-free so
 * the api parity spec (`document-prefix-parity.spec.ts`) can load this file and fail on any
 * divergence. Change both files together. Rule: length 1-16, `^[A-Za-z0-9][A-Za-z0-9._/-]*$`, and
 * never ending in a digit (it would merge into the padded number).
 */
export const DOCUMENT_PREFIX_MAX_LENGTH = 16;

const DOCUMENT_PREFIX_CHARSET = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** `null` when valid, else a user-facing message (shown verbatim by the api 400 and the web form). */
export function validateDocumentPrefix(prefix: unknown): string | null {
  if (typeof prefix !== "string") return "The prefix must be text.";
  if (prefix.length < 1) return "Enter a prefix, for example INV-.";
  if (prefix.length > DOCUMENT_PREFIX_MAX_LENGTH) {
    return `The prefix must be at most ${DOCUMENT_PREFIX_MAX_LENGTH} characters.`;
  }
  if (!DOCUMENT_PREFIX_CHARSET.test(prefix)) {
    return "The prefix must start with a letter or number and may only contain letters, numbers and . _ / -";
  }
  if (/\d$/.test(prefix)) {
    return "The prefix cannot end with a digit — it would merge into the document number. End it with a separator such as - (for example INV-).";
  }
  return null;
}
