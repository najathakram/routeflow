import { changedSinceSentNumbers, invoiceFingerprintOf } from "./invoice-send-state";

/**
 * B1372 (SA-1177 K2, owner box Q2 "Warn, re-send at hand-over"): an invoice an edit turned back into a draft is issued again
 * at hand-over or delivery, and that email says it changed: the numbers are the invoices that were EMAILED before (a tracked
 * send record) and now fingerprint differently (`decideSendState` "changedSinceSent", the state the detail read shows).
 * Never emailed, or unchanged: no line. A failed read leaves the line out and never stops the email. Placeholders only.
 */
function prismaWith(opts: {
  lastFp: Record<string, string | null | undefined>;
  invoices?: Record<string, Record<string, unknown>>;
  throwOnAudit?: boolean;
}) {
  const db = {
    auditLog: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (opts.throwOnAudit) throw new Error("db down");
        const fp = opts.lastFp[where.entityId];
        return fp === undefined
          ? null
          : { createdAt: new Date("2026-11-01T10:00:00Z"), meta: { to: "a@acme.test", fp } };
      }),
    },
    invoice: {
      findUnique: jest.fn(async ({ where }: any) => opts.invoices?.[where.id] ?? null),
    },
  };
  return { forTenant: () => db, getTenantId: () => "t1", db };
}
const sibling = (n: string, total: number) => ({
  id: n,
  invoiceNumber: n,
  status: "SENT",
  total,
  subtotal: total,
  taxAmount: 0,
  discount: 0,
  shippingFee: 0,
  items: [],
  payments: [],
  creditNotes: [],
  customer: null,
  order: null,
});

describe("changedSinceSentNumbers (B1372 K2)", () => {
  const first = { id: "inv-1", invoiceNumber: "INV-1", fingerprint: "v1:after-edit" };

  it("emailed before and changed since: the invoice is named", async () => {
    const p = prismaWith({ lastFp: { "inv-1": "v1:before-edit" } });
    expect(await changedSinceSentNumbers(p, {}, first)).toEqual(["INV-1"]);
  });

  it("emailed before and unchanged: no line", async () => {
    const p = prismaWith({ lastFp: { "inv-1": "v1:after-edit" } });
    expect(await changedSinceSentNumbers(p, {}, first)).toEqual([]);
  });

  it("never emailed (first send, or only marked sent): no line", async () => {
    const p = prismaWith({ lastFp: {} });
    expect(await changedSinceSentNumbers(p, {}, first)).toEqual([]);
  });

  it("an email before fingerprint tracking cannot be compared: no line", async () => {
    const p = prismaWith({ lastFp: { "inv-1": null } });
    expect(await changedSinceSentNumbers(p, {}, first)).toEqual([]);
  });

  it("a completion email's other invoices are judged on their FINAL copy, each on its own", async () => {
    const invoices = { "inv-2": sibling("INV-2", 50), "inv-3": sibling("INV-3", 70) };
    const probe = prismaWith({ lastFp: {}, invoices });
    const fp3 = await invoiceFingerprintOf(probe, {}, "inv-3", "final");
    const p = prismaWith({
      lastFp: { "inv-1": "v1:after-edit", "inv-2": "v1:stale", "inv-3": fp3 },
      invoices,
    });
    expect(await changedSinceSentNumbers(p, {}, first, ["inv-2", "inv-3"])).toEqual(["INV-2"]);
  });

  it("a failed read never stops the email: no line", async () => {
    const p = prismaWith({ lastFp: {}, throwOnAudit: true });
    await expect(changedSinceSentNumbers(p, {}, first)).resolves.toEqual([]);
  });
});
