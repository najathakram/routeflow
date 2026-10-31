import { isNsfLine, type NsfLineFacts } from "./nsf-line";

/**
 * SA-1058 (A-1): the ONE order an invoice's lines are shown in, on every copy: the detail screen, the
 * buyer's copy, the PDF and the emails. Display only. The keys are stored text, so nothing is selected
 * for it, a renamed product can't move a line, and an issued invoice reads the same on every reprint.
 *
 *   1. Group: lines with a product, then lines without, then system lines (the NSF fee, through
 *      nsf-line.ts's dual-read).
 *   2. Printed name: the stored `description`, the words the reader sees. One range reads together,
 *      whatever `Product.category` says: that is free text, and a sort on it can split a range.
 *   3. Pack size, largest first: the case, then the loose pieces of the same name.
 *   4. `id`, so the order is total and no two reads can differ.
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

/** One fixed locale, so the order cannot vary by machine: `8oz` before `12oz`, and case never splits. */
const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const GROUP_PRODUCT = 0;
const GROUP_NO_PRODUCT = 1;
const GROUP_SYSTEM = 2;

function lineGroup(line: InvoiceLineOrderFacts): number {
  if (isNsfLine(line)) return GROUP_SYSTEM;
  return line.productId ? GROUP_PRODUCT : GROUP_NO_PRODUCT;
}

/** Pieces per selling unit: a line sold in boxes is that box, a loose line is one piece. */
function packSize(line: InvoiceLineOrderFacts): number {
  const perBox = Number(line.unitsPerBox ?? 0);
  return Number(line.boxes ?? 0) > 0 && perBox > 1 ? perBox : 1;
}

function sortKey(line: InvoiceLineOrderFacts) {
  return {
    group: lineGroup(line),
    name: (line.description ?? "").trim().replace(/\s+/g, " "),
    pack: packSize(line),
    id: line.id,
  };
}

type SortKey = ReturnType<typeof sortKey>;

function compare(a: SortKey, b: SortKey): number {
  return (
    a.group - b.group ||
    COLLATOR.compare(a.name, b.name) ||
    b.pack - a.pack ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The lines in display order, as a NEW array; the input and its rows are left untouched. */
export function sortInvoiceLines<T extends InvoiceLineOrderFacts>(items: readonly T[]): T[] {
  return items
    .map((line) => ({ line, key: sortKey(line) }))
    .sort((a, b) => compare(a.key, b.key))
    .map(({ line }) => line);
}
