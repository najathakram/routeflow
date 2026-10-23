/**
 * SA-879 rule 3 (OP-7) - the inventory of every writer of `AdvancePayment.sourcePaymentId`.
 *
 * The duplicate-reference guard (payment-ref-dedupe.ts `groupExcessAdvances`) reads the column as "this advance is the
 * excess its payment group booked": a group's own advance is never "the existing payment", and it counts in the group's
 * total. A writer with another meaning (the documented future one: a bounced-check replacement advance) would be pulled
 * into that match, so a new writer fails this spec until it is classified, and its ruling keeps it out of the match.
 *
 * Comments are blanked, the detector has a self-test, and an empty scan fails.
 */
import { findCalls, resolveLiteral, scanSource, type CallSite } from "../testing/source-scan";

const ADVANCE_WRITE = /\badvancePayment\s*\.\s*(create|createMany|update|updateMany|upsert)\s*\(/;

/** True when the call's DATA (never its `where`) sets `sourcePaymentId`. */
export function setsSourcePaymentId(site: Pick<CallSite, "args" | "scope">): boolean {
  const literal = resolveLiteral(site).replace(/\bwhere\s*:\s*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, " ");
  return /(?:^|[\s{,])sourcePaymentId\s*(?::|,|\}|$)/.test(literal);
}

/** The exact (file#function) writers. */
export const SOURCE_PAYMENT_WRITERS: readonly { id: string; calls: number; reason: string }[] = [
  {
    id: "invoices/invoices.service.ts#writeStandalonePayment",
    calls: 1,
    reason: "SA-879: a standalone payment's excess advance, linked to the group's first row",
  },
];

const siteId = (s: Pick<CallSite, "file" | "fn">) => `${s.file}#${s.fn}`;

describe("SA-879 - every writer of AdvancePayment.sourcePaymentId is classified", () => {
  it("the scan sees the advance writers (an empty scan must not report green)", () => {
    expect(scanSource(ADVANCE_WRITE).length).toBeGreaterThanOrEqual(3);
  });

  it("the detector flags a data write and ignores a where, a select and a comment", () => {
    // methods at two spaces, as the scanner's METHOD pattern reads a class body
    const planted = [
      "class P {",
      "  async writes(tx: any) {",
      "    await tx.advancePayment.create({ data: { customerId, amount, sourcePaymentId: rowId } });",
      "  }",
      "  async harmless(tx: any) {",
      "    await tx.advancePayment.update({ where: { sourcePaymentId: rowId }, data: { balance: 0 } });",
      "    await tx.advancePayment.create({ data: { customerId, amount, method } });",
      "    // await tx.advancePayment.create({ data: { sourcePaymentId: x } });",
      "  }",
      "}",
    ].join("\n");
    const sites = findCalls("planted.ts", planted, ADVANCE_WRITE).filter(setsSourcePaymentId);
    expect(sites.map((s) => s.fn)).toEqual(["writes"]);
  });

  it("R5 the writers are exactly the classified list (count and name)", () => {
    const counts = new Map<string, number>();
    for (const s of scanSource(ADVANCE_WRITE).filter(setsSourcePaymentId))
      counts.set(siteId(s), (counts.get(siteId(s)) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual(
      Object.fromEntries(SOURCE_PAYMENT_WRITERS.map((w) => [w.id, w.calls])),
    );
  });
});
