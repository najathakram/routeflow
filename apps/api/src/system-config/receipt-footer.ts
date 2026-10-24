import { BadRequestException } from "@nestjs/common";

/** SA-762r F6: the longest receipt footer, counted in characters (code points) AFTER the strip below. */
export const RECEIPT_FOOTER_MAX_CHARS = 200;

/**
 * C0 controls except \n (\t and \r go too), DEL, the C1 block, and the bidi overrides/isolates
 * U+202A-202E and U+2066-2069 (a footer printed on a customer receipt must not be able to reorder the
 * text around it). The footer is rendered as React text only, never as HTML.
 */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const STRIPPED = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

/**
 * `settings.receiptFooter` (PATCH /settings): non-string -> 400; the control and bidi characters are stripped;
 * more than RECEIPT_FOOTER_MAX_CHARS left -> 400. Returns the value to store ("" clears it).
 */
export function sanitizeReceiptFooter(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new BadRequestException("receiptFooter must be text");
  }
  const clean = raw.replace(STRIPPED, "");
  if (Array.from(clean).length > RECEIPT_FOOTER_MAX_CHARS) {
    throw new BadRequestException(
      `receiptFooter can be at most ${RECEIPT_FOOTER_MAX_CHARS} characters`,
    );
  }
  return clean;
}
