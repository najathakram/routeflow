/**
 * The document-number prefix rule (B1188 / SA-723). The API owns this source (the server is the
 * authority): `UpdateNumberingDto.prefix` and `NumberingService.previewPrefix` call it. Web keeps a
 * MIRROR at `apps/web/lib/document-prefix.ts` (the API cannot value-import `@routeflow/types`, see
 * `no-runtime-workspace-imports.spec.ts`); `document-prefix-parity.spec.ts` runs one table of
 * prefixes and messages against both and fails on any divergence. Change both files together.
 *
 * A prefix is the literal text before the zero-padded number (`INV-` + `0043` -> `INV-0043`).
 * - Length 1-16 (the DTO's cap; empty is not a prefix).
 * - Charset `^[A-Za-z0-9][A-Za-z0-9._/-]*$`: starts with a letter or digit, then letters, digits
 *   and `. _ / -`. No whitespace, quotes or `#`.
 * - Must NOT end in a digit: `INV2` + `0043` reads back as `INV20043`, which the numeric-max scan
 *   parses as prefix `INV` number 20043, corrupting the series. A separator (`INV2-`) fixes it.
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
