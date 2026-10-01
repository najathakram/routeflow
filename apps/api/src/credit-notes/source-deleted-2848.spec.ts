import { unlinkSourcedCredits, SOURCE_DELETED_ACTION } from "./sourced-credit-guard";

/**
 * #2848 (SA-608c follow-up): every door that destroys an invoice leaves ONE durable
 * SOURCE_DELETED AuditLog row per credit note it unlinks, so the reissue and the PATCH-expiry
 * can refuse the orphan entirely (a note's columns alone cannot say "its source was deleted").
 */
describe("unlinkSourcedCredits (#2848)", () => {
  const makeTx = (notes: Array<{ id: string; invoiceId: string }>) => {
    const calls: string[] = [];
    const tx = {
      creditNote: {
        findMany: jest.fn().mockImplementation(() => {
          calls.push("read");
          return Promise.resolve(notes);
        }),
        updateMany: jest.fn().mockImplementation(() => {
          calls.push("unlink");
          return Promise.resolve({ count: notes.length });
        }),
      },
      auditLog: {
        createMany: jest.fn().mockImplementation(() => {
          calls.push("audit");
          return Promise.resolve({ count: notes.length });
        }),
      },
    };
    return { tx, calls };
  };

  it("writes one SOURCE_DELETED row per unlinked note, then unlinks exactly those ids", async () => {
    const { tx, calls } = makeTx([
      { id: "cn-1", invoiceId: "inv-1" },
      { id: "cn-2", invoiceId: "inv-1" },
    ]);

    await unlinkSourcedCredits(tx, [{ id: "inv-1", invoiceNumber: "INV-7" }], "t-1");

    expect(SOURCE_DELETED_ACTION).toBe("SOURCE_DELETED");
    expect(tx.auditLog.createMany).toHaveBeenCalledWith({
      data: [
        {
          tenantId: "t-1",
          userId: null,
          action: "SOURCE_DELETED",
          entityType: "CreditNote",
          entityId: "cn-1",
          meta: { invoiceId: "inv-1", invoiceNumber: "INV-7" },
        },
        {
          tenantId: "t-1",
          userId: null,
          action: "SOURCE_DELETED",
          entityType: "CreditNote",
          entityId: "cn-2",
          meta: { invoiceId: "inv-1", invoiceNumber: "INV-7" },
        },
      ],
    });
    // never an unscoped many-write: the ids read first are the ids unlinked
    expect(tx.creditNote.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["cn-1", "cn-2"] } },
      data: { invoiceId: null },
    });
    expect(calls).toEqual(["read", "audit", "unlink"]); // the marker lands BEFORE the link goes
  });

  it("covers several invoices, each note carrying its own invoice's number", async () => {
    const { tx } = makeTx([
      { id: "cn-1", invoiceId: "inv-1" },
      { id: "cn-9", invoiceId: "inv-2" },
    ]);
    await unlinkSourcedCredits(
      tx,
      [
        { id: "inv-1", invoiceNumber: "INV-1" },
        { id: "inv-2", invoiceNumber: "INV-2" },
      ],
      "t-1",
    );
    const rows = tx.auditLog.createMany.mock.calls[0][0].data;
    expect(rows.map((r: any) => [r.entityId, r.meta.invoiceNumber])).toEqual([
      ["cn-1", "INV-1"],
      ["cn-9", "INV-2"],
    ]);
  });

  it("writes nothing when no note was sourced by these invoices", async () => {
    const { tx } = makeTx([]);
    await unlinkSourcedCredits(tx, [{ id: "inv-1", invoiceNumber: "INV-7" }], "t-1");
    expect(tx.auditLog.createMany).not.toHaveBeenCalled();
    expect(tx.creditNote.updateMany).not.toHaveBeenCalled();
  });

  it("an empty invoice list is a no-op (no read either)", async () => {
    const { tx } = makeTx([]);
    await unlinkSourcedCredits(tx, [], "t-1");
    expect(tx.creditNote.findMany).not.toHaveBeenCalled();
  });
});
