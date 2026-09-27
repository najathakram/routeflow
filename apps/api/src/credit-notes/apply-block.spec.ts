import { blockedPairs, clearApplyBlocks, pairKey, writeApplyBlocks } from "./apply-block";

/**
 * SA-436b (LOW): every CreditNoteApplyBlock row carries its tenantId. Without a tenant context the
 * writer writes nothing (the memory fails open; no money moves on this path), never a
 * tenant-orphaned row.
 */
describe("apply-block — the CreditNoteApplyBlock helpers", () => {
  const db = () => ({
    creditNoteApplyBlock: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  });

  it("every written row carries the tenantId it was given", async () => {
    const d = db();
    await writeApplyBlocks(d, {
      tenantId: "t-1",
      creditNoteId: "cn-a",
      invoiceIds: ["inv-1", "inv-2"],
      reason: "UNTICKED",
    });
    const rows = d.creditNoteApplyBlock.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.tenantId === "t-1")).toBe(true);
  });

  it("no tenant context ⇒ writes nothing (never a tenant-orphaned row)", async () => {
    const d = db();
    await writeApplyBlocks(d, {
      tenantId: null,
      creditNoteId: "cn-a",
      invoiceIds: ["inv-1"],
      reason: "UNAPPLIED",
    });
    expect(d.creditNoteApplyBlock.createMany).not.toHaveBeenCalled();
  });

  it("no invoices ⇒ no reads or writes", async () => {
    const d = db();
    expect(await blockedPairs(d, [])).toEqual(new Set());
    await clearApplyBlocks(d, "cn-a", []);
    await writeApplyBlocks(d, {
      tenantId: "t-1",
      creditNoteId: "cn-a",
      invoiceIds: [],
      reason: "UNTICKED",
    });
    expect(d.creditNoteApplyBlock.findMany).not.toHaveBeenCalled();
    expect(d.creditNoteApplyBlock.deleteMany).not.toHaveBeenCalled();
    expect(d.creditNoteApplyBlock.createMany).not.toHaveBeenCalled();
  });

  it("blockedPairs keys each (note, invoice) pair", async () => {
    const d = db();
    d.creditNoteApplyBlock.findMany.mockResolvedValue([
      { creditNoteId: "cn-a", invoiceId: "inv-1" },
    ]);
    const set = await blockedPairs(d, ["inv-1", "inv-2"]);
    expect(set.has(pairKey("cn-a", "inv-1"))).toBe(true);
    expect(set.has(pairKey("cn-a", "inv-2"))).toBe(false);
  });
});
