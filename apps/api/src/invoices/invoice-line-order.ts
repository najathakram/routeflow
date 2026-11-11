import { sortPrintedLines } from "@routeflow/pricing";
import type { NsfLineFacts } from "./nsf-line";

/**
 * SA-1058 (A-1): the ONE order an invoice's lines are shown in, on every copy: the detail screen, the
 * buyer's copy, the PDF and the emails. Display only. The keys are stored text, so nothing is selected
 * for it, a renamed product can't move a line, and an issued invoice keeps its line order on every reprint.
 * Sort FIRST, compose after: the family name (`withFamilyNames`) is added to the sorted copy, never sorted on.
 * What a reprint PRINTS can still change for a legacy line: one whose stored text is the bare variant name
 * reads "<Family> - <Variant>" from the product's CURRENT family, so a family rename shows on it. A line
 * written since the fix stores its composed name and never moves.
 *
 *   1. Group: lines with a product, then lines without, then system lines (the NSF fee, through
 *      nsf-line.ts's dual-read).
 *   2. Printed name: the stored `description`, the words the reader sees. One range reads together,
 *      whatever `Product.category` says: that is free text, and a sort on it can split a range.
 *   3. Pack size, largest first: the case, then the loose pieces of the same name.
 *   4. `id`, so the order is total and no two reads can differ.
 *
 * W-1187: the comparator itself lives in `@routeflow/pricing` (`line-order.ts`), the one copy the order's Sort A to Z and every
 * screen share; this module keeps the invoice-shaped types and the permanent fallback call.
 *
 * MUST return a NEW array. `SendSnapshot` is the one object behind the PDF, the email and the send
 * fingerprint, and `invoiceFingerprint` hashes `items` in array order (SA-874): sorting it in place
 * would show every sent invoice as changed since sent.
 */

/** What the order reads from a line. Components are not lines here: they stay under their parent. */
export interface InvoiceLineOrderFacts extends NsfLineFacts {
  id: string;
  productId?: string | null;
  boxes?: unknown;
  unitsPerBox?: unknown;
}

/** The lines in display order, as a NEW array; the input and its rows are left untouched. */
export function sortInvoiceLines<T extends InvoiceLineOrderFacts>(items: readonly T[]): T[] {
  return sortPrintedLines(items);
}
