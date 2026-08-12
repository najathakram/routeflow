import { createHash } from "crypto";
import { roundMoney } from "../common/pricing";
import { normalizeInvoiceNumber } from "../import/duplicate-match.service";

/**
 * The three duplicate keys an invoice scan is filed under, strongest first.
 * `hashFile` identifies identical bytes; `lineFingerprint` identifies the same
 * paper re-photographed (the numbers survive an OCR that words the descriptions
 * differently, which is what defeated text comparison); the normalized supplier
 * invoice number identifies the printed document when it is legible.
 *
 * `normalizeInvoiceNumber` is re-exported rather than re-implemented: the
 * backfill script `scripts/backfill-supplier-invoice-number.mjs` greps
 * `duplicate-match.service.ts` for the normalization literal and aborts if it
 * moves, so that file has to stay the one place the rule is written.
 */
export { normalizeInvoiceNumber };

/** Line precision mirrors the storage columns: qty Decimal(10,3), unitCost Decimal(10,4). */
const QTY_DECIMALS = 3;
const UNIT_COST_DECIMALS = 4;

export interface FingerprintLine {
  qty?: number | string | null;
  unitCost?: number | string | null;
}

/**
 * sha256 over the uploaded bytes, concatenated in the order received.
 *
 * Order-sensitive by design: the same pages uploaded in a different order hash
 * differently and are therefore treated as a DIFFERENT document. Re-scanning a
 * re-ordered upload costs one model call; wrongly merging two documents that
 * only share pages costs a mis-posted bill.
 */
export function hashFile(buffers: Buffer[]): string {
  const hash = createHash("sha256");
  for (const buffer of buffers) hash.update(buffer);
  return hash.digest("hex");
}

/**
 * sha256 over the SORTED "qty@unitCost" pairs plus the document total.
 *
 * Deliberately blind to every transcription: no descriptions, no SKUs, no line
 * order. Two scans of the same paper whose OCR worded the items differently
 * still land on the same fingerprint, which is the whole reason this key exists
 * alongside the file hash.
 *
 * Returns null when the numbers cannot identify anything — no usable lines, or
 * a line set worth nothing. A zero-value fingerprint would collide across
 * unrelated documents, and a lines match is treated as identity (it can block a
 * create), so it must never be produced from noise.
 */
export function lineFingerprint(
  lines: FingerprintLine[],
  total?: number | string | null,
): string | null {
  const usable = (lines ?? [])
    .map((line) => ({ qty: Number(line?.qty), unitCost: Number(line?.unitCost) }))
    .filter(
      (line) =>
        Number.isFinite(line.qty) &&
        line.qty > 0 &&
        Number.isFinite(line.unitCost) &&
        line.unitCost >= 0,
    );
  if (usable.length === 0) return null;

  const extension = roundMoney(
    usable.reduce((sum, line) => sum + roundMoney(line.qty * line.unitCost), 0),
  );
  if (extension <= 0) return null;

  const pairs = usable
    .map((line) => `${line.qty.toFixed(QTY_DECIMALS)}@${line.unitCost.toFixed(UNIT_COST_DECIMALS)}`)
    .sort();

  // The printed total when it was read, otherwise the line extension — so a
  // scan that missed the total still fingerprints, at the cost of not matching
  // a scan of the same paper that read one.
  const parsedTotal = Number(total);
  const documentTotal =
    Number.isFinite(parsedTotal) && parsedTotal > 0 ? roundMoney(parsedTotal) : extension;

  return createHash("sha256")
    .update(`${pairs.join("|")}#${documentTotal.toFixed(2)}`)
    .digest("hex");
}
