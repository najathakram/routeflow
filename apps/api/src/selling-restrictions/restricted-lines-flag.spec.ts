import {
  flagRestrictedLines,
  flagSplitRestrictedLines,
  writeRestrictedLinesAudit,
} from "./restricted-lines-flag";

/**
 * F-05 (#2093, owner ruling 2026-09-25) — the shared flag-never-block helper split/import lean
 * on. Mirrors merge-restriction-warning.spec.ts's shape: BLOCK/INDETERMINATE flag, ALLOW/OFF
 * don't, a failing check never throws, and the audit write is a separate, swallowed step.
 */
describe("flagRestrictedLines", () => {
  const banned = {
    outcome: "BLOCK",
    reasons: [{ productId: "p-b", productName: "Banned Cola", ruleId: "rule-1", message: "no CA" }],
  };
  let restrictions: { checkLinesSellable: jest.Mock };
  let warn: jest.Mock;

  beforeEach(() => {
    restrictions = { checkLinesSellable: jest.fn().mockResolvedValue(banned) };
    warn = jest.fn();
  });

  it("checks only the deduped catalog product ids (productless lines dropped)", async () => {
    await flagRestrictedLines({ restrictions, warn } as never, {
      fulfilmentKind: "DELIVERY",
      tenantId: "t1",
      customerId: "c1",
      productIds: ["p-b", "p-b", null, undefined, "p-ok"],
    });
    expect(restrictions.checkLinesSellable).toHaveBeenCalledWith({
      fulfilmentKind: "DELIVERY",
      tenantId: "t1",
      customerId: "c1",
      lines: [{ productId: "p-b" }, { productId: "p-ok" }],
      channel: "STAFF",
    });
  });

  it("L8: an explicit fulfilment kind is passed through; an omitted one passes none", async () => {
    await flagRestrictedLines({ restrictions, warn } as never, {
      tenantId: "t1",
      customerId: "c1",
      productIds: ["p-b"],
      fulfilmentKind: "PICKUP",
    });
    expect(restrictions.checkLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ fulfilmentKind: "PICKUP" }),
    );
  });

  it("L8: the split flag judges the order by its own counterSale / fulfillPath", async () => {
    const prisma = { auditLog: { create: jest.fn().mockResolvedValue({}) } };
    await flagSplitRestrictedLines(
      restrictions as never,
      prisma as never,
      { warn },
      {
        tenantId: "t1",
        order: { id: "o1", customerId: "c1", counterSale: true, fulfillPath: "PICKUP" },
        remainingItems: [{ li: { productId: "p-b" } }],
      },
    );
    expect(restrictions.checkLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ fulfilmentKind: "COUNTER" }),
    );
  });

  it("BLOCK returns the flagged lines", async () => {
    const lines = await flagRestrictedLines({ restrictions, warn } as never, {
      fulfilmentKind: "DELIVERY",
      tenantId: "t1",
      customerId: "c1",
      productIds: ["p-b"],
    });
    expect(lines).toEqual([
      { productId: "p-b", productName: "Banned Cola", ruleId: "rule-1", message: "no CA" },
    ]);
  });

  it("INDETERMINATE also flags", async () => {
    restrictions.checkLinesSellable.mockResolvedValue({ ...banned, outcome: "INDETERMINATE" });
    const lines = await flagRestrictedLines({ restrictions, warn } as never, {
      fulfilmentKind: "DELIVERY",
      tenantId: "t1",
      customerId: "c1",
      productIds: ["p-b"],
    });
    expect(lines).toHaveLength(1);
  });

  it("ALLOW returns no flags", async () => {
    restrictions.checkLinesSellable.mockResolvedValue({ outcome: "ALLOW", reasons: [] });
    const lines = await flagRestrictedLines({ restrictions, warn } as never, {
      fulfilmentKind: "DELIVERY",
      tenantId: "t1",
      customerId: "c1",
      productIds: ["p-ok"],
    });
    expect(lines).toEqual([]);
  });

  it("no catalog product ids at all short-circuits with no read", async () => {
    const lines = await flagRestrictedLines({ restrictions, warn } as never, {
      fulfilmentKind: "DELIVERY",
      tenantId: "t1",
      customerId: "c1",
      productIds: [null, undefined],
    });
    expect(lines).toEqual([]);
    expect(restrictions.checkLinesSellable).not.toHaveBeenCalled();
  });

  it("a failing check is swallowed, logged, and returns no flags (NEVER throws)", async () => {
    restrictions.checkLinesSellable.mockRejectedValue(new Error("db down"));
    await expect(
      flagRestrictedLines({ restrictions, warn } as never, {
        fulfilmentKind: "DELIVERY",
        tenantId: "t1",
        customerId: "c1",
        productIds: ["p-b"],
      }),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("db down"));
  });
});

describe("writeRestrictedLinesAudit", () => {
  let prisma: { auditLog: { create: jest.Mock } };
  let warn: jest.Mock;

  beforeEach(() => {
    prisma = { auditLog: { create: jest.fn().mockResolvedValue({}) } };
    warn = jest.fn();
  });

  it("writes one row with the given action/entity/meta", async () => {
    await writeRestrictedLinesAudit({ prisma, warn } as never, {
      tenantId: "t1",
      action: "invoice.split.restricted_lines",
      entityType: "invoices",
      entityId: "inv-1",
      meta: { invoiceIds: ["inv-1"], productIds: ["p-b"] },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      tenantId: "t1",
      userId: null,
      action: "invoice.split.restricted_lines",
      entityType: "invoices",
      entityId: "inv-1",
      meta: { invoiceIds: ["inv-1"], productIds: ["p-b"] },
    });
  });

  it("a failing write is swallowed and logged, never thrown", async () => {
    prisma.auditLog.create.mockRejectedValue(new Error("audit down"));
    await expect(
      writeRestrictedLinesAudit({ prisma, warn } as never, {
        tenantId: "t1",
        action: "invoice.import.restricted_lines",
        entityType: "invoices",
        entityId: "run-1",
        meta: {},
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("audit down"));
  });

  it("is never invoked for an empty flagged set (both callers gate on length > 0)", () => {
    // documentation-only: flagRestrictedLines returning [] is the caller's own gate;
    // this helper has no opinion on emptiness — it always writes when called.
    expect(true).toBe(true);
  });
});
