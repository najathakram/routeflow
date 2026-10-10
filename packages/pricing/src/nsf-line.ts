/**
 * #2392 / SA-478 (A): THE client-safe predicate for "is this invoice line the system NSF bounce-fee
 * line". The API (apps/api/src/invoices/nsf-line.ts — which keeps HAS_TRANSITION_LEG and the Prisma
 * where-builders), web and mobile all use it, so the rule can never drift between them. It mirrors
 * #2169 / SA-395's rule exactly:
 *
 *   NSF ⇔ systemKind === "NSF_FEE"
 *        OR (while the TRANSITION leg is on) systemKind is null AND description startsWith the prefix.
 *
 * `NSF_FEE_SYSTEM_KIND` is a LOCAL value, not a runtime import of @routeflow/types: that package's
 * entry is raw TypeScript (no build step), and the API loads this package's compiled CJS from
 * `node dist/main.js` — a value import would emit `require("@routeflow/types")` and crash API
 * startup (the apps/api/src/common/check-transitions.ts precedent). nsf-line.spec.ts pins it as a
 * member of `INVOICE_ITEM_SYSTEM_KIND_VALUES`, which enum-parity.spec pins to the Prisma enum.
 */

import { inferredFlatRate, type InferredFlatRate } from "./inferred-flat-rate";
import { roundMoney } from "./pricing";

/** The InvoiceItem.systemKind value that stamps the NSF fee line (Prisma `InvoiceItemSystemKind`). */
export const NSF_FEE_SYSTEM_KIND = "NSF_FEE" as const;

/** The description every NSF fee line starts with (the only marker on pre-#2169 rows). */
export const NSF_FEE_DESCRIPTION_PREFIX = "NSF fee — returned check";

/** What the predicate reads from a line — any shape carrying these two fields fits. */
export interface NsfLineFactsInput {
  systemKind?: string | null;
  description?: string | null;
}

/**
 * Whether `line` is the NSF fee line. `hasTransitionLeg` is the API's HAS_TRANSITION_LEG: while it
 * is true, a pre-backfill row (systemKind null) is recognised by its description PREFIX; a line
 * stamped with any other kind never falls back to the prefix.
 */
export function isNsfLineFacts(line: NsfLineFactsInput, hasTransitionLeg: boolean): boolean {
  if (line.systemKind === NSF_FEE_SYSTEM_KIND) return true;
  if (!hasTransitionLeg) return false;
  if (line.systemKind != null) return false;
  return (line.description ?? "").startsWith(NSF_FEE_DESCRIPTION_PREFIX);
}

/**
 * The client-side transition flag — the SAME state as the API's HAS_TRANSITION_LEG
 * (apps/api/src/invoices/nsf-line.ts), which a parity pin in that module's spec keeps equal: the
 * prefix leg is deleted on both sides together, after the owner's #2169 backfill report shows 0
 * prefix-matched NULL rows.
 */
export const NSF_HAS_TRANSITION_LEG = true;

/** Web / mobile: whether a fetched invoice line is the NSF fee line, with the live transition flag. */
export function isNsfLine(line: NsfLineFactsInput): boolean {
  return isNsfLineFacts(line, NSF_HAS_TRANSITION_LEG);
}

/**
 * #2656 / SA-549: THE goods-only inferred flat rate (B294's rule, over the invoice's GOODS). The NSF
 * bounce-fee line is untaxed and booked into the header subtotal, so it is excluded — its line AND
 * its money — or it dilutes the rate ($7.50 on $100 goods + a $25 fee would read 0.06, not 0.075) and
 * is then stamped with it. `subtotal − ΣNSF` is ROUNDED to cents: the API writes, so its rounding is
 * the truth. The API's applyPriceAdjustment, mobile's invoice edit and the b294 backfill all call
 * this; app source never calls `inferredFlatRate` directly (no-mirrors-nsf.spec).
 */
export function inferredGoodsFlatRate(invoice: {
  subtotal: unknown;
  taxAmount: unknown;
  lines: ReadonlyArray<
    NsfLineFactsInput & { taxRate?: unknown; categoryTaxAmount?: unknown; subtotal?: unknown }
  >;
}): InferredFlatRate | null {
  const lines = invoice.lines ?? [];
  const nsf = lines.map((l) => isNsfLine(l));
  const fees = lines.reduce((s, l, i) => (nsf[i] ? s + (Number(l.subtotal) || 0) : s), 0);
  return inferredFlatRate({
    subtotal: roundMoney((Number(invoice.subtotal) || 0) - fees),
    taxAmount: invoice.taxAmount,
    lines: lines.filter((_, i) => !nsf[i]),
  });
}
