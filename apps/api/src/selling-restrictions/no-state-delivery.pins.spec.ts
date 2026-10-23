/**
 * Row 672 pin — a buyer order on ROUTE or SHIP for a customer with NO usable state on file, through the same seam
 * `OrdersService.create` uses (`saleFulfilmentKind({ fulfillPath })` + `restrictionChannelForPrincipal(buyer)`) into the
 * REAL `assertLinesSellable` engine. It pins TODAY's behaviour, test-only:
 *
 *   - every matched STATE rule is a portal-only limit (surface BUYER_PORTAL) -> ALLOWED ("Owner ruling 2");
 *   - any matched STATE rule is a legal ban (surface ALL)                    -> 409 SELLING_RESTRICTED (fail closed).
 *
 * The owner may reverse the first line for route/ship sales (672, SA queue); if so, that diff flips the ALLOW cases
 * here on purpose. The call site itself (create() asks with DELIVERY for ROUTE/SHIP) is pinned by
 * `orders/orders.create-restrictions.spec.ts`; this file pins what the engine answers on that call.
 */
import { ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { saleFulfilmentKind } from "./sale-fulfilment";
import { restrictionChannelForPrincipal } from "./selling-restrictions.core";
import { SellingRestrictionsService } from "./selling-restrictions.service";

const T = "tenant-1";
const NOW = new Date("2026-10-22T12:00:00Z");
/** The buyer portal's pseudo-user, as `makePseudoUser` hands it to `create()`. */
const BUYER = { type: "BUYER" as const, role: "CUSTOMER" as const };

const writeGuardedModel = (findMany: jest.Mock) => ({
  findMany,
  create: jest.fn(),
  update: jest.fn(),
  upsert: jest.fn(),
  delete: jest.fn(),
  updateMany: jest.fn(),
  deleteMany: jest.fn(),
});

const rule = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  categoryId: "cat-thc",
  productId: null,
  jurisdiction: "STATE",
  states: ["TX"],
  surface: "ALL",
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveTo: null,
  liftedAt: null,
  reason: "State limit",
  targets: [],
  _count: { targets: 0 },
  ...over,
});
const PORTAL_ONLY = rule({ id: "portal", surface: "BUYER_PORTAL" });
const LEGAL_BAN = rule({ id: "ban", surface: "ALL" });

const addr = (over: Record<string, unknown> = {}) => ({
  isDefault: true,
  addressType: "BILLING",
  stateCode: "TX",
  stateNeedsReview: false,
  ...over,
});

/** The three ways a customer has no usable state today (each resolves UNRESOLVED). */
const NO_STATE: Array<[string, unknown[]]> = [
  ["no address at all", []],
  ["a default address with no state code", [addr({ stateCode: null })]],
  ["a default address flagged for state review", [addr({ stateNeedsReview: true })]],
];

describe("row 672 pin: a ROUTE/SHIP buyer order for a customer with no state (today's behaviour)", () => {
  let service: SellingRestrictionsService;
  let prisma: any;

  const serve = (rules: unknown[], addresses: unknown[]) => {
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: "selling_restrictions.enabled", value: "true" },
      { key: "selling_restrictions.governing_address", value: "BILLING_FIRST" },
    ]);
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        name: "Gummies",
        parentProductId: null,
        categoryLabels: [{ categoryId: "cat-thc", mode: "INCLUDE" }],
      },
    ]);
    prisma.sellingRestriction.findMany.mockResolvedValue(rules);
    prisma.customer.findFirst.mockResolvedValue({ isWalkIn: false, addresses });
  };

  /** Exactly the params `OrdersService.create` builds for a buyer's non-draft order on `fulfillPath`. */
  const createJudges = (fulfillPath: "ROUTE" | "SHIP") =>
    service.assertLinesSellable({
      tenantId: T,
      customerId: "cust-1",
      lines: [{ productId: "p1" }],
      channel: restrictionChannelForPrincipal(BUYER),
      fulfilmentKind: saleFulfilmentKind({ counterSale: undefined, fulfillPath }),
      at: NOW,
    });

  beforeEach(async () => {
    const mock = createMockPrisma();
    mock.getTenantId.mockReturnValue(null);
    prisma = mock.forTenant();
    prisma.sellingRestriction = writeGuardedModel(jest.fn().mockResolvedValue([]));
    prisma.productCategory = writeGuardedModel(
      jest.fn().mockResolvedValue([{ id: "cat-thc", name: "THC" }]),
    );
    const mod = await Test.createTestingModule({
      providers: [
        SellingRestrictionsService,
        ProductLabelsService,
        { provide: PrismaService, useValue: mock },
      ],
    }).compile();
    service = mod.get(SellingRestrictionsService);
  });

  it("the seam: ROUTE and SHIP are DELIVERY sales on the BUYER_PORTAL channel (judged by the customer's own state)", () => {
    expect(saleFulfilmentKind({ fulfillPath: "ROUTE" })).toBe("DELIVERY");
    expect(saleFulfilmentKind({ fulfillPath: "SHIP" })).toBe("DELIVERY");
    expect(restrictionChannelForPrincipal(BUYER)).toBe("BUYER_PORTAL");
  });

  describe.each(["ROUTE", "SHIP"] as const)("%s", (path) => {
    it("control: a customer IN the limited state is refused by the portal-only limit (the fixture really matches)", async () => {
      serve([PORTAL_ONLY], [addr({ stateCode: "TX" })]);
      await expect(createJudges(path)).rejects.toBeInstanceOf(ConflictException);
    });

    it.each(NO_STATE)(
      "ALLOWED today: every matched rule is portal-only and the customer has %s",
      async (_label, addresses) => {
        serve([PORTAL_ONLY], addresses);
        await expect(createJudges(path)).resolves.toBeUndefined();
        // the customer's address really was read: the ALLOW is the no-state exemption, not a skipped lookup
        expect(prisma.customer.findFirst).toHaveBeenCalledTimes(1);
      },
    );

    it.each(NO_STATE)(
      "FAIL CLOSED: a legal ban (surface ALL) refuses a customer with %s (409 SELLING_RESTRICTED)",
      async (_label, addresses) => {
        serve([LEGAL_BAN], addresses);
        const err = await createJudges(path).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).getResponse()).toMatchObject({
          code: "SELLING_RESTRICTED",
          blockedLines: [{ productId: "p1" }],
        });
      },
    );

    it.each(NO_STATE)(
      "FAIL CLOSED: a legal ban beside a portal-only limit still refuses a customer with %s",
      async (_label, addresses) => {
        serve([PORTAL_ONLY, LEGAL_BAN], addresses);
        await expect(createJudges(path)).rejects.toBeInstanceOf(ConflictException);
      },
    );
  });
});
