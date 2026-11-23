import { changedSinceSentNumbers, invoiceFingerprint } from "./invoice-send-state";

/**
 * B1372 (SA-1177 K2, owner box Q2 "Warn, re-send at hand-over"): an invoice an edit turned back into a draft is issued again
 * at hand-over or delivery, and that email says it changed: the numbers are the invoices that were EMAILED before (a tracked
 * send record) and whose CONTENT differs now. N1 (SA-1177 A2 K2): the stage (draft / final) is not content, so a draft
 * emailed and then sent final with the same lines is unchanged. Never emailed, or an untracked send: no line. A failed read
 * leaves the line out and never stops the email. Real fingerprints, placeholders only.
 */
const invoice = (id: string, total: number) => ({
  id,
  invoiceNumber: id.toUpperCase(),
  status: "SENT",
  total,
  subtotal: total,
  taxAmount: 0,
  discount: 0,
  shippingFee: 0,
  items: [{ id: `${id}-l1`, description: "Widget", qty: 5, unitPrice: total / 5, subtotal: total }],
  payments: [],
  customer: { businessName: "Acme Foods", contactName: null, phone: null, addresses: [] },
  order: null,
});
const fp = (inv: ReturnType<typeof invoice>, variant: "draft" | "final") =>
  invoiceFingerprint({ ...inv, variant });

function prismaWith(opts: {
  lastFp: Record<string, string | null | undefined>;
  invoices: Record<string, Record<string, unknown>>;
  throwOnAudit?: boolean;
}) {
  const db = {
    auditLog: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (opts.throwOnAudit) throw new Error("db down");
        const last = opts.lastFp[where.entityId];
        return last === undefined
          ? null
          : { createdAt: new Date("2026-11-01T10:00:00Z"), meta: { to: "a@acme.test", fp: last } };
      }),
    },
    invoice: {
      findUnique: jest.fn(async ({ where }: any) => opts.invoices[where.id] ?? null),
    },
  };
  return { forTenant: () => db, getTenantId: () => "t1", db };
}

describe("changedSinceSentNumbers (B1372 K2, N1)", () => {
  const sent = invoice("inv-1", 50);
  const edited = invoice("inv-1", 70); // the same invoice after an edit changed its lines

  it("N1 (a): emailed as a draft, then sent final with the same lines: no line", async () => {
    const p = prismaWith({ lastFp: { "inv-1": fp(sent, "draft") }, invoices: { "inv-1": sent } });
    expect(await changedSinceSentNumbers(p, ["inv-1"])).toEqual([]);
  });

  it("N1 (b): emailed as a draft, then the lines changed and it is sent final: the invoice is named", async () => {
    const p = prismaWith({ lastFp: { "inv-1": fp(sent, "draft") }, invoices: { "inv-1": edited } });
    expect(await changedSinceSentNumbers(p, ["inv-1"])).toEqual(["INV-1"]);
  });

  it("emailed final before and changed since: the invoice is named", async () => {
    const p = prismaWith({ lastFp: { "inv-1": fp(sent, "final") }, invoices: { "inv-1": edited } });
    expect(await changedSinceSentNumbers(p, ["inv-1"])).toEqual(["INV-1"]);
  });

  it("emailed final before and unchanged: no line", async () => {
    const p = prismaWith({ lastFp: { "inv-1": fp(sent, "final") }, invoices: { "inv-1": sent } });
    expect(await changedSinceSentNumbers(p, ["inv-1"])).toEqual([]);
  });

  it("never emailed (first send, or only marked sent): no line, and the invoice is not read", async () => {
    const p = prismaWith({ lastFp: {}, invoices: { "inv-1": edited } });
    expect(await changedSinceSentNumbers(p, ["inv-1"])).toEqual([]);
    expect(p.db.invoice.findUnique).not.toHaveBeenCalled();
  });

  it("an email before fingerprint tracking, or of another version, cannot be compared: no line", async () => {
    const p = prismaWith({
      lastFp: { "inv-1": null, "inv-2": "v0:legacy" },
      invoices: { "inv-1": edited, "inv-2": invoice("inv-2", 10) },
    });
    expect(await changedSinceSentNumbers(p, ["inv-1", "inv-2"])).toEqual([]);
    expect(p.db.invoice.findUnique).not.toHaveBeenCalled();
  });

  it("a completion email's invoices are each judged on their own content", async () => {
    const two = invoice("inv-2", 20);
    const three = invoice("inv-3", 30);
    const p = prismaWith({
      lastFp: {
        "inv-1": fp(sent, "final"),
        "inv-2": fp(two, "draft"),
        "inv-3": fp(three, "final"),
      },
      invoices: { "inv-1": edited, "inv-2": two, "inv-3": invoice("inv-3", 35) },
    });
    expect(await changedSinceSentNumbers(p, ["inv-1", "inv-2", "inv-3"])).toEqual([
      "INV-1",
      "INV-3",
    ]);
  });

  it("a failed read never stops the email: no line", async () => {
    const p = prismaWith({ lastFp: {}, invoices: {}, throwOnAudit: true });
    await expect(changedSinceSentNumbers(p, ["inv-1"])).resolves.toEqual([]);
  });
});
