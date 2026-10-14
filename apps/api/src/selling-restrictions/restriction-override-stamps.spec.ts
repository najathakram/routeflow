import { stampRestrictionOverrides, type StampContext } from "./restriction-override-stamps";
import type { CarriedStamp, StampPlan, StaffWriteDecision } from "./restriction-warning";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";

/**
 * Row 510: the transaction half of the override protocol, on an in-memory fake of the line table and the audit log. It
 * proves the stamp lands on every live line of an acknowledged product (one audit row each, in the same tx), a held
 * stamp is re-applied to recreated / new lines only, a substitution clears the stamp, and a write with nothing to do
 * costs no read at all.
 */
type Row = {
  id: string;
  orderId: string;
  productId: string | null;
  status?: string;
  restrictionOverrideReason: string | null;
  restrictionOverrideBy: string | null;
  restrictionOverrideAt: Date | null;
  restrictionOverrideRuleIds: string[];
};
const CLEAR = {
  restrictionOverrideReason: null,
  restrictionOverrideBy: null,
  restrictionOverrideAt: null,
  restrictionOverrideRuleIds: [] as string[],
};
const row = (id: string, productId: string | null, over: Partial<Row> = {}): Row => ({
  id,
  orderId: "ord-1",
  productId,
  status: "PENDING",
  ...CLEAR,
  ...over,
});
const stampedRow = (id: string, productId: string, over: Partial<Row> = {}): Row =>
  row(id, productId, {
    restrictionOverrideReason: "earlier",
    restrictionOverrideBy: "u-old",
    restrictionOverrideAt: new Date("2026-10-01T00:00:00Z"),
    restrictionOverrideRuleIds: ["r1"],
    ...over,
  });

function fakeTx(rows: Row[]) {
  const audit: any[] = [];
  const updateMany = jest.fn(async ({ where, data }: any) => {
    const ids: string[] = where.id.in;
    for (const r of rows)
      if (ids.includes(r.id) && r.orderId === where.orderId) Object.assign(r, data);
    return { count: ids.length };
  });
  const findMany = jest.fn(async ({ where }: any) =>
    rows.filter((r) => r.orderId === where.orderId).map((r) => ({ ...r })),
  );
  const tx = {
    orderItem: { findMany, updateMany },
    auditLog: { create: jest.fn(async ({ data }: any) => audit.push(data)) },
  };
  return { tx, audit, rows, findMany, updateMany };
}
const decision = (over: {
  stamps?: StampPlan[];
  carried?: CarriedStamp[];
  heldStamped?: Map<string, string | null>;
}): StaffWriteDecision =>
  ({
    stamps: over.stamps ?? [],
    carried: over.carried ?? [],
    heldStamped: over.heldStamped ?? new Map(),
    warningHash: "rw1:abc",
    basis: "CUSTOMER",
    active: true,
    recheck: () => {
      throw new Error("unused");
    },
    stamp: () => Promise.resolve(0),
  }) as StaffWriteDecision;
const ctx = (over: Partial<StampContext> = {}): StampContext => ({
  model: "orderItem",
  parentId: "ord-1",
  documentType: "ORDER",
  tenantId: "t-1",
  by: "u-op",
  at: new Date("2026-10-14T12:00:00Z"),
  ...over,
});
const plan = (lineKey: string, productId: string, over: Partial<StampPlan> = {}): StampPlan => ({
  lineKey,
  productId,
  reason: "Customer is licensed",
  ruleIds: ["r1", "r2"],
  ...over,
});

describe("stampRestrictionOverrides", () => {
  it("stamps EVERY live line of an acknowledged product, with one audit row each in the same tx", async () => {
    const f = fakeTx([
      row("a", "p1"),
      row("b", "p1"),
      row("c", "p2"),
      row("d", "p1", { status: "CANCELLED" }),
    ]);
    const n = await stampRestrictionOverrides(
      f.tx,
      decision({ stamps: [plan("n:0", "p1")] }),
      ctx(),
    );
    expect(n).toBe(2);
    expect(f.rows.filter((r) => r.restrictionOverrideAt).map((r) => r.id)).toEqual(["a", "b"]);
    expect(f.rows[0]).toMatchObject({
      restrictionOverrideReason: "Customer is licensed",
      restrictionOverrideBy: "u-op",
      restrictionOverrideRuleIds: ["r1", "r2"],
    });
    expect(f.audit).toHaveLength(2);
    expect(f.audit[0]).toMatchObject({
      tenantId: "t-1",
      userId: "u-op",
      action: AUDIT_ACTIONS.SELLING_RESTRICTION_OVERRIDDEN,
      entityType: "OrderItem",
      entityId: "a",
      meta: expect.objectContaining({
        documentType: "ORDER",
        documentId: "ord-1",
        productId: "p1",
        ruleIds: ["r1", "r2"],
        reason: "Customer is licensed",
        lineKey: "n:0",
        warningHash: "rw1:abc",
        basis: "CUSTOMER",
      }),
    });
  });

  it("a new override REPLACES an older stamp (new reason, by, at, rule ids) and audits it", async () => {
    const f = fakeTx([stampedRow("a", "p1")]);
    await stampRestrictionOverrides(f.tx, decision({ stamps: [plan("l:a", "p1")] }), ctx());
    expect(f.rows[0]).toMatchObject({
      restrictionOverrideReason: "Customer is licensed",
      restrictionOverrideBy: "u-op",
      restrictionOverrideRuleIds: ["r1", "r2"],
    });
    expect(f.audit).toHaveLength(1);
    expect(f.audit[0].meta.lineKey).toBe("l:a");
  });

  it("each line takes the reason of ITS OWN warned key when the keys differ", async () => {
    const f = fakeTx([row("a", "p1"), row("b", "p1")]);
    await stampRestrictionOverrides(
      f.tx,
      decision({
        stamps: [plan("l:a", "p1", { reason: "first" }), plan("l:b", "p1", { reason: "second" })],
      }),
      ctx(),
    );
    expect(f.rows.map((r) => r.restrictionOverrideReason)).toEqual(["first", "second"]);
  });

  it("a held stamp is re-applied by product to live lines that LACK one (recreated / new), without an audit row", async () => {
    const f = fakeTx([
      row("new1", "p1"),
      stampedRow("keep", "p1", { restrictionOverrideReason: "keep me" }),
      row("other", "p2"),
    ]);
    const carried: CarriedStamp = {
      productId: "p1",
      stamp: {
        restrictionOverrideReason: "earlier",
        restrictionOverrideBy: "u-old",
        restrictionOverrideAt: new Date("2026-10-01T00:00:00Z"),
        restrictionOverrideRuleIds: ["r1"],
      },
    };
    const n = await stampRestrictionOverrides(
      f.tx,
      decision({ carried: [carried] }),
      ctx({ by: null }),
    );
    expect(n).toBe(0);
    expect(f.audit).toEqual([]);
    expect(f.rows[0]).toMatchObject({
      restrictionOverrideBy: "u-old",
      restrictionOverrideRuleIds: ["r1"],
    });
    expect(f.rows[1].restrictionOverrideReason).toBe("keep me"); // an existing stamp is not overwritten
    expect(f.rows[2].restrictionOverrideAt).toBeNull(); // another product is untouched
  });

  it("a line whose product changed since the lock-time read loses its stamp (a substitution re-warns)", async () => {
    const f = fakeTx([stampedRow("a", "p2")]); // now p2, was p1 when stamped
    await stampRestrictionOverrides(
      f.tx,
      decision({
        heldStamped: new Map([["a", "p1"]]),
        carried: [{ productId: "p1", stamp: {} as never }],
      }),
      ctx({ by: null }),
    );
    expect(f.rows[0]).toMatchObject(CLEAR);
  });

  it("a substituted line is cleared first, so a carried stamp of its NEW product can land on it", async () => {
    const f = fakeTx([stampedRow("a", "p2")]);
    const carried: CarriedStamp = {
      productId: "p2",
      stamp: {
        restrictionOverrideReason: "p2 was acknowledged elsewhere",
        restrictionOverrideBy: "u-x",
        restrictionOverrideAt: new Date("2026-10-02T00:00:00Z"),
        restrictionOverrideRuleIds: ["r9"],
      },
    };
    await stampRestrictionOverrides(
      f.tx,
      decision({ heldStamped: new Map([["a", "p1"]]), carried: [carried] }),
      ctx({ by: null }),
    );
    expect(f.rows[0].restrictionOverrideReason).toBe("p2 was acknowledged elsewhere");
  });

  it("a decision with nothing to stamp or carry reads and writes nothing", async () => {
    const f = fakeTx([row("a", "p1")]);
    expect(await stampRestrictionOverrides(f.tx, decision({}), ctx())).toBe(0);
    expect(await stampRestrictionOverrides(f.tx, undefined, ctx())).toBe(0);
    expect(await stampRestrictionOverrides(f.tx, null, ctx())).toBe(0);
    expect(f.findMany).not.toHaveBeenCalled();
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it("never issues an updateMany without ids: a missing parent id is refused before any read", async () => {
    const f = fakeTx([row("a", "p1")]);
    await expect(
      stampRestrictionOverrides(
        f.tx,
        decision({ stamps: [plan("n:0", "p1")] }),
        ctx({ parentId: "" }),
      ),
    ).rejects.toThrow(/parentId/);
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it("a new override without the overriding user's id is refused (the audit row must name who)", async () => {
    const f = fakeTx([row("a", "p1")]);
    await expect(
      stampRestrictionOverrides(f.tx, decision({ stamps: [plan("n:0", "p1")] }), ctx({ by: null })),
    ).rejects.toThrow(/user id/);
  });

  it("an audit failure propagates so the caller's transaction rolls the stamp back", async () => {
    const f = fakeTx([row("a", "p1")]);
    f.tx.auditLog.create.mockRejectedValueOnce(new Error("audit down"));
    await expect(
      stampRestrictionOverrides(f.tx, decision({ stamps: [plan("n:0", "p1")] }), ctx()),
    ).rejects.toThrow("audit down");
  });

  it("an invoice's lines are stamped through the invoiceItem delegate and audited as InvoiceItem / INVOICE", async () => {
    const rows = [{ ...row("i1", "p1"), orderId: undefined, invoiceId: "inv-1" } as unknown as Row];
    const audit: any[] = [];
    const updateMany = jest.fn(async ({ where, data }: any) => {
      for (const r of rows as any[])
        if (where.id.in.includes(r.id) && r.invoiceId === where.invoiceId) Object.assign(r, data);
      return { count: 1 };
    });
    const tx = {
      invoiceItem: {
        findMany: jest.fn(async () => rows.map((r) => ({ ...r }))),
        updateMany,
      },
      auditLog: { create: jest.fn(async ({ data }: any) => audit.push(data)) },
    };
    await stampRestrictionOverrides(
      tx,
      decision({ stamps: [plan("n:0", "p1")] }),
      ctx({ model: "invoiceItem", documentType: "INVOICE", parentId: "inv-1" }),
    );
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: { in: ["i1"] }, invoiceId: "inv-1" });
    expect(audit[0]).toMatchObject({
      entityType: "InvoiceItem",
      meta: expect.objectContaining({ documentType: "INVOICE", documentId: "inv-1" }),
    });
    // an invoice line has no status column: it must not be selected
    expect((tx.invoiceItem.findMany.mock.calls[0] as any)[0].select.status).toBeUndefined();
  });
});
