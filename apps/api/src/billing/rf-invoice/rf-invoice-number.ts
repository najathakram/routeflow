import { withAdvisoryLock } from "../../common/db-locks";
import { uniqueViolationOn } from "../../common/prisma-unique";
import { RF_INVOICE_NUMBER_INDEX } from "./rf-invoice.constants";

const NUMBER_RE = /^RF-(\d{4})-(\d+)$/;

/** `RF-YYYY-NNNN` (UTC issue year, zero-padded to 4; wider once past 9999). */
export function formatRfInvoiceNumber(year: number, seq: number): string {
  return `RF-${year}-${String(seq).padStart(4, "0")}`;
}

/**
 * The next number in the UTC year of `now`: max existing sequence + 1, so a number is never reused
 * (a void keeps its number). Meant to run inside {@link withRfInvoiceNumberLock}, in the same
 * transaction that inserts the row; `RfInvoice.number @unique` is the backstop. The sequence is
 * compared as an integer, never as a string ("10000" sorts before "9999").
 */
export async function mintRfInvoiceNumber(
  db: { rfInvoice: { findMany: (args: any) => Promise<{ number: string }[]> } },
  now: Date,
): Promise<string> {
  const year = now.getUTCFullYear();
  const rows = await db.rfInvoice.findMany({
    where: { number: { startsWith: `RF-${year}-` } },
    select: { number: true },
  });
  let max = 0;
  for (const { number } of rows) {
    const m = NUMBER_RE.exec(number);
    if (m && Number(m[1]) === year) max = Math.max(max, Number(m[2]));
  }
  return formatRfInvoiceNumber(year, max + 1);
}

/** Serialises number minting across replicas (billing family, wait mode, 5 s). */
export async function withRfInvoiceNumberLock<T>(fn: () => Promise<T>): Promise<T> {
  const r = await withAdvisoryLock(
    { family: "billing", key: "rf-invoice-number", mode: "wait", waitMs: 5000 },
    fn,
  );
  if (!r.acquired) throw new Error("rf-invoice-number lock was not acquired");
  return r.value;
}

/**
 * Runs `attempt` (mint + insert); on a unique violation of THE NUMBER INDEX ONLY it runs once more
 * (a second mint sees the row that beat it). Any other P2002, and a second number collision, propagate.
 */
export async function withRfInvoiceNumber<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (e) {
    if (uniqueViolationOn(e, RF_INVOICE_NUMBER_INDEX, { exact: true })) return attempt();
    throw e;
  }
}
