/**
 * The ONE document-number prefix rule (B1188 / SA-723). The api DTO
 * (`UpdateNumberingDto.prefix`) and the web forms both call `validateDocumentPrefix`, so the two
 * can never drift. A prefix is the literal text before the zero-padded number
 * (`INV-` + `0043` -> `INV-0043`).
 *
 * - Max length 16: the limit the numbering DTO has always enforced.
 * - Charset: letters, digits and `- _ . / #`. No whitespace, quotes or control characters: the
 *   prefix is printed on documents and matched literally inside a Postgres regex by the
 *   numeric-max scan (the service regex-escapes it; this keeps the stored value boring).
 * - Must NOT end in a digit: `INV2` + `0043` reads back as `INV20043`, which the scan parses as
 *   prefix `INV` number 20043, corrupting the series. A separator (`INV2-`) fixes it.
 * - Empty is allowed (a bare numeric series), as before.
 */
export const DOCUMENT_PREFIX_MAX_LENGTH = 16;

const DOCUMENT_PREFIX_CHARSET = /^[A-Za-z0-9\-_./#]*$/;

/** `null` when valid, else a user-facing message (shown verbatim by web and the api 400). */
export function validateDocumentPrefix(prefix: unknown): string | null {
  if (typeof prefix !== "string") return "The prefix must be text.";
  if (prefix.length > DOCUMENT_PREFIX_MAX_LENGTH) {
    return `The prefix must be at most ${DOCUMENT_PREFIX_MAX_LENGTH} characters.`;
  }
  if (!DOCUMENT_PREFIX_CHARSET.test(prefix)) {
    return "The prefix may only contain letters, numbers and - _ . / #.";
  }
  if (/\d$/.test(prefix)) {
    return "The prefix cannot end with a digit — it would merge into the document number. End it with a separator such as - (for example INV-).";
  }
  return null;
}
