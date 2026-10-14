import { ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { DRIVER_RESTRICTION_BLOCK_MESSAGE } from "./override-constants";
import {
  SellingRestrictionsService,
  type SellableLinesParams,
} from "./selling-restrictions.service";

/**
 * Row 510 through the real service over a mocked prisma: what a STAFF write of a restricted product gets back from
 * `assertLinesSellable` (warning / hard block / decision), the buyer channel unchanged, the jurisdiction (store vs
 * customer) and the switch that no longer exists. The DB-backed proofs (locks, stamps, audit rows) are in the
 * `restriction-override*.db.spec.ts` files.
 */
const T = "tenant-1";
const NOW = new Date("2026-10-14T12:00:00Z");
const OPERATOR = { role: "OPERATOR", sub: "u-op" };

describe("SellingRestrictionsService: a STAFF write of a restricted product (row 510)", () => {
  let service: SellingRestrictionsService;
  let mock: any;
  let prisma: any;

  const dbRule = (over: Record<string, unknown> = {}) => ({
    id: "r-ca",
    categoryId: "cat-thc",
    productId: null,
    jurisdiction: "STATE",
    states: ["CA"],
    surface: "ALL",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    liftedAt: null,
    reason: "State ban",
    targets: [],
    _count: { targets: 0 },
    ...over,
  });
  const customerIn = (state: string) =>
    prisma.customer.findFirst.mockResolvedValue({
      isWalkIn: false,
      addresses: [
        { isDefault: true, addressType: "BILLING", stateCode: state, stateNeedsReview: false },
      ],
    });
  const storeIn = (state: string | null) =>
    mock.tenantConfig.findUnique.mockResolvedValue(state ? { state } : null);
  const args = (over: Partial<SellableLinesParams> = {}): SellableLinesParams => ({
    tenantId: T,
    customerId: "c1",
    lines: [{ productId: "p1", lineKey: "n:0" }],
    channel: "STAFF",
    principal: OPERATOR,
    document: "ORDER",
    at: NOW,
    ...over,
  });
  const reject = async (p: SellableLinesParams) => {
    try {
      await service.assertLinesSellable(p);
    } catch (e) {
      return e as ConflictException;
    }
    throw new Error("expected a rejection");
  };

  beforeEach(async () => {
    mock = createMockPrisma();
    mock.getTenantId.mockReturnValue(null);
    prisma = mock.forTenant();
    prisma.sellingRestriction = { findMany: jest.fn().mockResolvedValue([dbRule()]) };
    prisma.productCategory = {
      findMany: jest.fn().mockResolvedValue([{ id: "cat-thc", name: "THC" }]),
    };
    prisma.systemConfig.findMany.mockResolvedValue([]); // NO switch row: the switch is gone
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        name: "Gummies",
        parentProductId: null,
        categoryLabels: [{ categoryId: "cat-thc", mode: "INCLUDE" }],
      },
    ]);
    customerIn("CA");
    storeIn(null);
    const mod = await Test.createTestingModule({
      providers: [
        SellingRestrictionsService,
        ProductLabelsService,
        { provide: PrismaService, useValue: mock },
      ],
    }).compile();
    service = mod.get(SellingRestrictionsService);
  });

  it("an OPERATOR is warned (409 RESTRICTION_WARNING) with the legal copy, a hash and the warned line", async () => {
    const e = await reject(args());
    expect(e.getResponse()).toMatchObject({
      code: "RESTRICTION_WARNING",
      warningHash: expect.stringMatching(/^rw1:/),
      lines: [
        {
          lineKey: "n:0",
          productId: "p1",
          displayName: "Gummies",
          outcome: "BLOCK",
          rules: [
            {
              id: "r-ca",
              states: ["CA"],
              legal: true,
              reasonText: "This product is banned in CA by law.",
            },
          ],
        },
      ],
    });
  });

  it("warning, then the resubmit with the hash and a reason: a decision that stamps the line", async () => {
    const hash = ((await reject(args())).getResponse() as any).warningHash;
    const decision = await service.assertLinesSellable(
      args({
        ack: {
          warningHash: hash,
          restrictionOverrides: [{ lineKey: "n:0", reason: "Licensed buyer" }],
        },
      }),
    );
    expect(decision.stamps).toEqual([
      { lineKey: "n:0", productId: "p1", reason: "Licensed buyer", ruleIds: ["r-ca:CA"] },
    ]);
    expect(decision.warningHash).toBe(hash);
    expect(decision.basis).toBe("CUSTOMER");
  });

  it("a stale hash is a fresh 409", async () => {
    const e = await reject(
      args({
        ack: {
          warningHash: "rw1:stale",
          restrictionOverrides: [{ lineKey: "n:0", reason: "Licensed buyer" }],
        },
      }),
    );
    expect((e.getResponse() as any).code).toBe("RESTRICTION_WARNING");
  });

  it("a DRIVER is hard-blocked: 409 SELLING_RESTRICTED with exactly the shared 'ask the office' message", async () => {
    const e = await reject(args({ principal: { role: "DRIVER", sub: "d1" } }));
    expect(e.getResponse()).toMatchObject({
      code: "SELLING_RESTRICTED",
      message: DRIVER_RESTRICTION_BLOCK_MESSAGE,
      blockedLines: [expect.objectContaining({ productId: "p1", ruleId: "r-ca" })],
    });
    expect(DRIVER_RESTRICTION_BLOCK_MESSAGE).toBe("Ask the office to approve this sale");
  });

  it("a SUPER_ADMIN and a system caller (no principal) cannot override: the ordinary staff 409", async () => {
    for (const principal of [{ role: "SUPER_ADMIN", sub: "sa" }, undefined, null]) {
      const e = await reject(args({ principal }));
      const body = e.getResponse() as any;
      expect(body.code).toBe("SELLING_RESTRICTED");
      expect(body.message).not.toBe(DRIVER_RESTRICTION_BLOCK_MESSAGE);
      expect(body.blockedLines[0].ruleId).toBe("r-ca"); // staff detail, not the buyer's redacted body
    }
  });

  it("a BUYER channel is unchanged: the hard 409 with the redacted body, never a warning", async () => {
    const e = await reject(args({ channel: "BUYER_PORTAL", principal: { role: "CUSTOMER" } }));
    const body = e.getResponse() as any;
    expect(body.code).toBe("SELLING_RESTRICTED");
    expect(body.blockedLines).toEqual([{ productId: "p1", productName: "Gummies" }]);
    expect(JSON.stringify(body)).not.toContain("r-ca");
  });

  it("nothing breached resolves to a decision with nothing to stamp", async () => {
    customerIn("TX"); // the rule bans CA only
    const decision = await service.assertLinesSellable(args());
    expect(decision.stamps).toEqual([]);
    expect(decision.active).toBe(false);
  });

  it("the tenant switch is gone: no selling_restrictions.enabled row still means the rule applies", async () => {
    prisma.systemConfig.findMany.mockResolvedValue([]);
    expect((await reject(args())).getResponse()).toMatchObject({ code: "RESTRICTION_WARNING" });
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: "selling_restrictions.enabled", value: "false" },
    ]);
    expect((await reject(args())).getResponse()).toMatchObject({ code: "RESTRICTION_WARNING" });
  });

  describe("jurisdiction: the store for a till / pickup sale, the customer's address for a delivery", () => {
    it("a PICKUP sale to a customer in an ALLOWED state is judged by the store: banned there, so it warns", async () => {
      customerIn("TX");
      storeIn("CA");
      const e = await reject(args({ path: "PICKUP" }));
      const body = e.getResponse() as any;
      expect(body.code).toBe("RESTRICTION_WARNING");
      expect(body.lines[0].rules[0].reasonText).toBe("This product is banned in CA by law.");
    });

    it("the same customer on a DELIVERY is judged at their own address: TX is allowed, nothing to warn", async () => {
      customerIn("TX");
      storeIn("CA");
      expect((await service.assertLinesSellable(args({ path: "DELIVERY" }))).stamps).toEqual([]);
    });

    it("a customer in the BANNED state who picks up at a store in an allowed state is NOT warned", async () => {
      customerIn("CA");
      storeIn("TX");
      expect((await service.assertLinesSellable(args({ path: "PICKUP" }))).stamps).toEqual([]);
      expect((await reject(args({ path: "SHIP" }))).getResponse()).toMatchObject({
        code: "RESTRICTION_WARNING",
      });
    });

    it("a counter sale to a NAMED customer is judged by the store, never reads the customer's address", async () => {
      customerIn("TX");
      storeIn("CA");
      expect((await reject(args({ path: "COUNTER" }))).getResponse()).toMatchObject({
        code: "RESTRICTION_WARNING",
      });
      expect(prisma.customer.findFirst).not.toHaveBeenCalled();
    });

    it("a store with no usable business state is INDETERMINATE (warned), and says so about the STORE", async () => {
      storeIn(null);
      const body = (await reject(args({ path: "PICKUP" }))).getResponse() as any;
      expect(body.lines[0]).toMatchObject({ outcome: "INDETERMINATE" });
      expect(body.lines[0].rules[0].reasonText).toMatch(/store's state can't be determined/);
    });

    it("the warning's hash differs between a store basis and a customer basis (a path switch re-warns)", async () => {
      customerIn("CA");
      storeIn("CA");
      const a = ((await reject(args({ path: "DELIVERY" }))).getResponse() as any).warningHash;
      const b = ((await reject(args({ path: "PICKUP" }))).getResponse() as any).warningHash;
      expect(a).not.toBe(b);
    });
  });

  it("judgeStaffWrite lists the breaches and the basis, and never throws for a business outcome", async () => {
    const judged = await service.judgeStaffWrite(args({ path: "PICKUP" }));
    expect(judged.basis).toBe("STORE");
    expect(judged.breaches).toEqual([expect.objectContaining({ outcome: "INDETERMINATE" })]); // no store state
    storeIn("CA");
    const j2 = await service.judgeStaffWrite(args({ path: "PICKUP" }));
    expect(j2.outcome).toBe("BLOCK");
    expect(j2.breaches[0]).toMatchObject({ productId: "p1", ruleIds: ["r-ca"], state: "CA" });
  });
});
