/** W-1443 (SA-1516): the line a send toast adds when the sender's private copy was delivered. */
export const INVOICE_COPY_TOAST = "A copy went to you.";

/** `text` plus the copy line, only when the api reports `copiedTo` (never claim a copy that was not delivered). */
export function withCopyNote(text: string, copiedTo?: string | null): string {
  if (!copiedTo) return text;
  return `${text.endsWith(".") ? text : `${text}.`} ${INVOICE_COPY_TOAST}`;
}
