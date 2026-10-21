import { API_ERROR_CODES } from "@routeflow/types";

/**
 * B980 (no server text in the UI): fixed copy for a product import that was refused or stopped. The server sends a
 * CODE (the 409 / 400 body, or the failed job's `errorCode`); this maps a closed set of codes to plain sentences and
 * everything else to one fallback. Nothing here ever prints a server message.
 */

export const IMPORT_FAMILY_PRICING_ON_COPY =
  "Family pricing is on, so grouping would change these products' prices. Turn family pricing off, or group them in the product editor.";

export const IMPORT_FAMILY_TOO_MANY_ROWS_COPY =
  "This file has too many rows to group into families in one go. Split it into smaller files.";

export const IMPORT_JOB_FALLBACK_COPY = "Something went wrong while importing.";

/** Shown when the page could not reach the job any more: it may still be running, so it does not say re-running is safe. */
export const IMPORT_LOST_CONTACT_COPY =
  "We lost contact with the import. It may still be running — check Products before importing again.";

/** A refusal of the whole file, by code: shown on the page before anything is written. */
export const IMPORT_REFUSAL_COPY: Readonly<Record<string, string>> = {
  [API_ERROR_CODES.IMPORT_FAMILY_PRICING_ON]: IMPORT_FAMILY_PRICING_ON_COPY,
  [API_ERROR_CODES.IMPORT_FAMILY_TOO_MANY_ROWS]: IMPORT_FAMILY_TOO_MANY_ROWS_COPY,
};

const JOB_ERROR_COPY: Readonly<Record<string, string>> = {
  ...IMPORT_REFUSAL_COPY,
  [API_ERROR_CODES.WORKSPACE_READ_ONLY]:
    "This workspace is read-only right now, so the import didn't run.",
};

/** The refusal copy for a response code, or null when it is not one of the import's file refusals. */
export function importRefusalCopy(code: unknown): string | null {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(IMPORT_REFUSAL_COPY, code)
    ? IMPORT_REFUSAL_COPY[code]
    : null;
}

/** The copy for a failed job's `errorCode`; an unknown or missing code is the fixed fallback. */
export function importJobErrorCopy(code: unknown): string {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(JOB_ERROR_COPY, code)
    ? JOB_ERROR_COPY[code]
    : IMPORT_JOB_FALLBACK_COPY;
}
