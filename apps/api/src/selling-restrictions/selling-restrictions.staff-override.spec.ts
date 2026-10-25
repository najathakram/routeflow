import { ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import * as rGate from "../orders/order-restriction-gate";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { createMockPrisma } from "../testing/prisma-mock";
import {
  DRIVER_RESTRICTION_BLOCK_MESSAGE,
  SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE,
} from "./override-constants";
import {
  SellingRestrictionsService,
  type SellableLinesParams,
} from "./selling-restrictions.service";

/**
 * Row 510 through the real service over a mocked prisma: what a STAFF write of a restricted product gets back from
 * `assertLinesSellable` (warning / hard block / decision), the buyer channel unchanged, the jurisdiction (store vs
 * customer) and the owner-only tenant switch (`selling_restrictions.enabled`, D-2026-09-25-banned-items-rules): ON keeps the
 * row-510 protocol, OFF means no warning or block on ANY staff path. The DB-backed proofs (locks, stamps, audit rows) are in the
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
    fulfilmentKind: "DELIVERY",
    ...over,
  });
  const switchRow = (value: string | null) =>
    prisma.systemConfig.findMany.mockResolvedValue(
      value === null ? [] : [{ key: "selling_restrictions.enabled", value }],
    );
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
    mock.user.findFirst.mockResolvedValue({ deniedPermissionGroups: [], permissionsVersion: 1 }); // W-870: the operator's live row
    prisma = mock.forTenant();
    prisma.sellingRestriction = { findMany: jest.fn().mockResolvedValue([dbRule()]) };
    prisma.productCategory = {
      findMany: jest.fn().mockResolvedValue([{ id: "cat-thc", name: "THC" }]),
    };
    switchRow("true"); // the owner turned the tenant switch ON: the row-510 protocol applies
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

  describe("W-870: the override reads the operator's live denied groups", () => {
    const deny = (groups: string[]) =>
      mock.user.findFirst.mockResolvedValue({
        deniedPermissionGroups: groups,
        permissionsVersion: 2,
      });
    const ackFor = async (principal: SellableLinesParams["principal"] = OPERATOR) => ({
      warningHash: ((await reject(args({ principal }))).getResponse() as any).warningHash,
      restrictionOverrides: [{ lineKey: "n:0", reason: "Licensed buyer" }],
    });

    it("an OPERATOR with ORDERS denied is hard-blocked (SELLING_RESTRICTED), even with a valid acknowledgement", async () => {
      deny([]);
      const ack = await ackFor();
      deny(["ORDERS"]);
      const e = await reject(args({ ack }));
      expect((e.getResponse() as any).code).toBe("SELLING_RESTRICTED");
    });

    it("an OPERATOR with another group denied, or none, still overrides", async () => {
      for (const groups of [[], ["PRICING"]]) {
        deny(groups);
        const decision = await service.assertLinesSellable(args({ ack: await ackFor() }));
        expect(decision.stamps).toHaveLength(1);
      }
    });

    it("an OPERATOR token with no sub fails closed: all groups denied, hard-blocked, never looked up", async () => {
      const noSub = { role: "OPERATOR" } as SellableLinesParams["principal"];
      const ack = await ackFor(OPERATOR);
      mock.user.findFirst.mockClear();
      const e = await reject(args({ principal: noSub, ack }));
      expect((e.getResponse() as any).code).toBe("SELLING_RESTRICTED");
      expect(mock.user.findFirst).not.toHaveBeenCalled();
    });

    it("a TENANT_ADMIN ignores denials and is never looked up", async () => {
      const admin = { role: "TENANT_ADMIN", sub: "ad-1" };
      deny(["ORDERS"]);
      const decision = await service.assertLinesSellable(
        args({ principal: admin, ack: await ackFor(admin) }),
      );
      expect(decision.stamps).toHaveLength(1);
      expect(mock.user.findFirst).not.toHaveBeenCalled();
    });
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

  it("a support session (a TENANT_ADMIN token carrying impersonatedBy) can't override: the shared 'ask the account admin' block with the per-rule lines", async () => {
    const principal = { role: "TENANT_ADMIN", sub: "admin-1", impersonatedBy: "support-1" };
    const hash = ((await reject(args())).getResponse() as any).warningHash;
    for (const ack of [
      undefined,
      { warningHash: hash, restrictionOverrides: [{ lineKey: "n:0", reason: "Licensed buyer" }] },
    ]) {
      const e = await reject(args({ principal, ack }));
      expect(e.getResponse()).toMatchObject({
        code: "SELLING_RESTRICTED",
        message: SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE,
        blockedLines: [expect.objectContaining({ productId: "p1", ruleId: "r-ca" })],
        lines: [expect.objectContaining({ lineKey: "n:0", productId: "p1" })],
      });
    }
    expect(SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE).toBe("Ask the account admin");
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

  it("switch ON keeps the row-510 warning", async () => {
    switchRow("true");
    expect((await reject(args())).getResponse()).toMatchObject({ code: "RESTRICTION_WARNING" });
  });

  describe("switch OFF (a `false` row, or no row at all): staff are never warned or blocked", () => {
    it.each([
      ["a false row", "false"],
      ["no row", null],
    ])(
      "%s: assertLinesSellable resolves to an inert decision and reads no rule",
      async (_n, value) => {
        switchRow(value);
        const decision = await service.assertLinesSellable(args());
        expect(decision.stamps).toEqual([]);
        expect(decision.off).toBe(true);
        expect(prisma.sellingRestriction.findMany).not.toHaveBeenCalled();
      },
    );

    it("a DRIVER and a support session, whom the protocol hard-blocks, are not blocked either", async () => {
      switchRow("false");
      for (const principal of [
        { role: "DRIVER", sub: "u-d" },
        { role: "TENANT_ADMIN", sub: "u-a", impersonatedBy: "sa-1" },
        undefined,
      ]) {
        await expect(service.assertLinesSellable(args({ principal }))).resolves.toBeDefined();
      }
    });

    it("judgeStaffWrite reports nothing breached", async () => {
      switchRow("false");
      expect(await service.judgeStaffWrite(args())).toMatchObject({
        outcome: "OFF",
        breaches: [],
      });
    });

    it("the BUYER channel is unchanged by the switch: the portal still refuses", async () => {
      switchRow("false");
      await expect(
        service.assertLinesSellable(args({ channel: "BUYER_PORTAL" })),
      ).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
    });
  });

  describe("every staff write path, through its real gate builder, follows the switch", () => {
    const user = { role: "OPERATOR", sub: "u-op" } as never;
    const create = (counterSale: boolean) =>
      rGate.create({
        tenant: T,
        customerId: "c1",
        user,
        lineItemsData: [{ productId: "p1" }],
        fulfillPath: counterSale ? "PICKUP" : "ROUTE",
        options: { counterSale },
        dto: undefined,
      });
    const order = {
      customerId: "c1",
      lineItems: [] as never[],
      fulfillPath: "ROUTE",
      counterSale: false,
    };

    it.each([
      ["order create", false],
      ["counter sale", true],
    ])("%s: switch OFF is never warned; switch ON is", async (_n, counter) => {
      switchRow("false");
      await expect(
        service.assertLinesSellable({ ...create(counter), channel: "STAFF" }),
      ).resolves.toMatchObject({ off: true });
      switchRow("true");
      expect((await reject({ ...create(counter), channel: "STAFF" })).getResponse()).toMatchObject({
        code: "RESTRICTION_WARNING",
      });
    });

    it("order edit: switch OFF plans nothing for staff (null), switch ON plans and judges", async () => {
      const plan = () =>
        rGate.editPlan(
          { restrictions: service, prisma: mock },
          {
            tenant: T,
            order,
            user,
            dto: { items: [{ productId: "p1", qty: 1 }] },
            isDiffPayload: false,
          },
        );
      switchRow("false");
      expect(await plan()).toBeNull();
      switchRow("true");
      const on = await plan();
      expect(on).not.toBeNull();
      await expect(
        service.assertLinesSellable({ ...on!.params, channel: "STAFF" }),
      ).rejects.toMatchObject({ response: { code: "RESTRICTION_WARNING" } });
    });

    it("change request: switch OFF plans nothing for staff (null), switch ON plans and judges", async () => {
      const cr = { id: "cr-1", type: "ADD_ITEM", productId: "p1" } as never;
      const plan = () => rGate.crPlan({ restrictions: service }, { tenant: T, order, cr, user });
      switchRow("false");
      expect(await plan()).toBeNull();
      switchRow("true");
      expect(await plan()).not.toBeNull();
    });
  });

  describe("jurisdiction: the store for a till / pickup sale, the customer's address for a delivery", () => {
    it("a PICKUP sale to a customer in an ALLOWED state is judged by the store: banned there, so it warns", async () => {
      customerIn("TX");
      storeIn("CA");
      const e = await reject(args({ fulfilmentKind: "PICKUP" }));
      const body = e.getResponse() as any;
      expect(body.code).toBe("RESTRICTION_WARNING");
      expect(body.lines[0].rules[0].reasonText).toBe("This product is banned in CA by law.");
    });

    it("the same customer on a DELIVERY is judged at their own address: TX is allowed, nothing to warn", async () => {
      customerIn("TX");
      storeIn("CA");
      expect(
        (await service.assertLinesSellable(args({ fulfilmentKind: "DELIVERY" }))).stamps,
      ).toEqual([]);
    });

    it("a customer in the BANNED state who picks up at a store in an allowed state is NOT warned", async () => {
      customerIn("CA");
      storeIn("TX");
      expect(
        (await service.assertLinesSellable(args({ fulfilmentKind: "PICKUP" }))).stamps,
      ).toEqual([]);
      expect((await reject(args({ fulfilmentKind: "DELIVERY" }))).getResponse()).toMatchObject({
        code: "RESTRICTION_WARNING",
      });
    });

    it("a counter sale to a NAMED customer is judged by the store, never reads the customer's address", async () => {
      customerIn("TX");
      storeIn("CA");
      expect((await reject(args({ fulfilmentKind: "COUNTER" }))).getResponse()).toMatchObject({
        code: "RESTRICTION_WARNING",
      });
      expect(prisma.customer.findFirst).not.toHaveBeenCalled();
    });

    it("a store with no usable business state is INDETERMINATE (warned), and says so about the STORE", async () => {
      storeIn(null);
      const body = (await reject(args({ fulfilmentKind: "PICKUP" }))).getResponse() as any;
      expect(body.lines[0]).toMatchObject({ outcome: "INDETERMINATE" });
      expect(body.lines[0].rules[0].reasonText).toMatch(/store's state can't be determined/);
    });

    it("the warning's hash differs between a store basis and a customer basis (a path switch re-warns)", async () => {
      customerIn("CA");
      storeIn("CA");
      const a = ((await reject(args({ fulfilmentKind: "DELIVERY" }))).getResponse() as any)
        .warningHash;
      const b = ((await reject(args({ fulfilmentKind: "PICKUP" }))).getResponse() as any)
        .warningHash;
      expect(a).not.toBe(b);
    });
  });

  it("judgeStaffWrite lists the breaches and the basis, and never throws for a business outcome", async () => {
    const judged = await service.judgeStaffWrite(args({ fulfilmentKind: "PICKUP" }));
    expect(judged.basis).toBe("STORE");
    expect(judged.breaches).toEqual([expect.objectContaining({ outcome: "INDETERMINATE" })]); // no store state
    storeIn("CA");
    const j2 = await service.judgeStaffWrite(args({ fulfilmentKind: "PICKUP" }));
    expect(j2.outcome).toBe("BLOCK");
    expect(j2.breaches[0]).toMatchObject({ productId: "p1", ruleIds: ["r-ca"], state: "CA" });
  });
});
