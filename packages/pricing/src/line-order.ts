import { isNsfLine, type NsfLineFactsInput } from "./nsf-line";

/**
 * W-1187 (SA ruling 7) / SA-1058: the ONE comparator for "Sort A to Z" and for an invoice's legacy A to Z order. PRESENTATION,
 * not money: no money helper imports it. The API (the order sort, the invoice fallback) and every screen run this single copy.
 *
 *   1. Group: lines with a product, then lines without, then system lines (the NSF fee, via nsf-line.ts's dual-read).
 *   2. Printed name: the stored `description`, the words the reader sees, with the `en` numeric collator (`8oz` before `12oz`).
 *   3. Pack size, largest first: the case, then the loose pieces of the same name.
 *   4. `id`, so the order is total and no two reads can differ.
 *
 * `sortPrintedLines` returns a NEW array (the send fingerprint hashes lines in array order: never sort in place).
 */
export interface PrintedLineFacts extends NsfLineFactsInput {
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

function lineGroup(line: PrintedLineFacts): number {
  if (isNsfLine(line)) return GROUP_SYSTEM;
  return line.productId ? GROUP_PRODUCT : GROUP_NO_PRODUCT;
}

/** Pieces per selling unit: a line sold in boxes is that box, a loose line is one piece. */
function packSize(line: PrintedLineFacts): number {
  const perBox = Number(line.unitsPerBox ?? 0);
  return Number(line.boxes ?? 0) > 0 && perBox > 1 ? perBox : 1;
}

function sortKey(line: PrintedLineFacts) {
  return {
    group: lineGroup(line),
    name: (line.description ?? "").trim().replace(/\s+/g, " "),
    pack: packSize(line),
    id: line.id,
  };
}

/** Negative when `a` is listed before `b`. */
export function comparePrintedLines(a: PrintedLineFacts, b: PrintedLineFacts): number {
  const x = sortKey(a);
  const y = sortKey(b);
  return (
    x.group - y.group ||
    COLLATOR.compare(x.name, y.name) ||
    y.pack - x.pack ||
    (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
  );
}

/** The lines in A to Z order, as a NEW array; the input and its rows are left untouched. */
export function sortPrintedLines<T extends PrintedLineFacts>(items: readonly T[]): T[] {
  return [...items].sort(comparePrintedLines);
}
