import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import {
  OverrideAuditContext,
  OverrideAuditLine,
  overrideAuditRows,
  writeOverrideAuditRows,
} from "./restriction-override-audit";

const ctx: OverrideAuditContext = {
  tenantId: "t-1",
  by: "u-op",
  entityType: "OrderItem",
  documentType: "ORDER",
  documentId: "o-1",
  warningHash: "rw1:abc",
  basis: "CUSTOMER",
};
const line = (over: Partial<OverrideAuditLine> = {}): OverrideAuditLine => ({
  lineId: "li-1",
  productId: "p-1",
  lineKey: "n:0",
  ruleIds: ["r2", "r1"],
  reason: "Customer holds a licence",
  ...over,
});

function fakeTx() {
  const create = jest.fn().mockResolvedValue({});
  return { tx: { auditLog: { create } }, create };
}

describe("restriction override audit (row 510)", () => {
  it("writes ONE row per newly stamped line through the tx client, with the plan's fields", async () => {
    const { tx, create } = fakeTx();
    const n = await writeOverrideAuditRows(tx, ctx, [
      line(),
      line({ lineId: "li-2", lineKey: "n:1", productId: "p-2", ruleIds: ["r3"] }),
    ]);
    expect(n).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toEqual({
      data: {
        tenantId: "t-1",
        userId: "u-op",
        impersonatedBy: null,
        action: AUDIT_ACTIONS.SELLING_RESTRICTION_OVERRIDDEN,
        entityType: "OrderItem",
        entityId: "li-1",
        meta: {
          documentType: "ORDER",
          documentId: "o-1",
          productId: "p-1",
          ruleIds: ["r1", "r2"],
          reason: "Customer holds a licence",
          lineKey: "n:0",
          warningHash: "rw1:abc",
          basis: "CUSTOMER",
        },
      },
    });
    expect(create.mock.calls[1][0].data.entityId).toBe("li-2");
    expect(create.mock.calls[1][0].data.meta.lineKey).toBe("n:1");
  });

  it("zero lines writes nothing (a carried stamp is not passed in)", async () => {
    const { tx, create } = fakeTx();
    await expect(writeOverrideAuditRows(tx, ctx, [])).resolves.toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("records the impersonating operator and an InvoiceItem entity", () => {
    const [row] = overrideAuditRows(
      { ...ctx, impersonatedBy: "sa-9", entityType: "InvoiceItem", documentType: "INVOICE" },
      [line()],
    );
    expect(row.impersonatedBy).toBe("sa-9");
    expect(row.entityType).toBe("InvoiceItem");
    expect(row.meta.documentType).toBe("INVOICE");
  });

  it("does not mutate the caller's rule id list", () => {
    const ruleIds = ["r2", "r1"];
    overrideAuditRows(ctx, [line({ ruleIds })]);
    expect(ruleIds).toEqual(["r2", "r1"]);
  });

  it.each([
    ["tenantId", { ...ctx, tenantId: "" }, line()],
    ["by", { ...ctx, by: " " }, line()],
    ["documentId", { ...ctx, documentId: "" }, line()],
    ["lineId", ctx, line({ lineId: "" })],
    ["productId", ctx, line({ productId: "" })],
  ])("a missing %s throws before ANY insert", async (_name, c, l) => {
    const { tx, create } = fakeTx();
    await expect(writeOverrideAuditRows(tx, c, [line({ lineId: "ok" }), l])).rejects.toThrow(
      /required/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("a failed insert propagates (the tx rolls back), unlike AuditService.log", async () => {
    const tx = { auditLog: { create: jest.fn().mockRejectedValue(new Error("db down")) } };
    await expect(writeOverrideAuditRows(tx, ctx, [line()])).rejects.toThrow("db down");
  });
});
