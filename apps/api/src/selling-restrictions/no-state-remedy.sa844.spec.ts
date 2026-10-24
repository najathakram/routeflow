/**
 * Row 672 / SA-844 (amends SA-836 §2.4): a sale whose governing state can't be resolved, through the REAL
 * `assertLinesSellable` over a mocked prisma. The DB-backed twin (0 rows written, re-judge after a state is added) is
 * `no-state-remedy.sa844.db.spec.ts`.
 *
 *   R1  DELIVERY, STAFF, switch ON, customer with no address, legal STATE ban -> INDETERMINATE warning whose line names its
 *       remedy (`ADD_CUSTOMER_STATE` + `customerId`); a driver's hard block carries the same line.
 *   R2  as R1, the default address's state flagged for review ("California" unnormalised) -> same as R1.
 *   R3  as R1 with the owner-only switch OFF -> OFF, no warning (owner ruling 09-25; pinned so nobody "fixes" it).
 *   R4  the buyer portal on ROUTE / SHIP (the order-create seam): a portal-only limit is ALLOWED for a no-state buyer
 *       (owner Option A, "Owner ruling 2"); a legal ban fails closed with the "add your delivery state" copy and the
 *       B612 names-only body (no remedy, no customer id).
 *   R5  DELIVERY with no customer (an order-less staff judgement) and a legal ban -> INDETERMINATE, no remedy to offer.
 *   R6  the customer gets NV (not banned) -> no warning; CA (banned) -> BLOCK, which needs no remedy.
 *   +   a sale judged at the STORE (counter, pickup, the walk-in) with no store state -> `ADD_STORE_STATE`, no customer.
 *
 * `sale-fulfilment.ts` stays pure (SA-844 ruling 1): which state judges is unchanged; only the INDETERMINATE answer gains
 * its remedy, set in the core where INDETERMINATE is produced.
 */
import { ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PORTAL_NEEDS_STATE_MESSAGE } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { saleFulfilmentKind } from "./sale-fulfilment";
import { restrictionChannelForPrincipal } from "./selling-restrictions.core";
import {
  SellingRestrictionsService,
  type SellableLinesParams,
} from "./selling-restrictions.service";

const T = "tenant-1";
const NOW = new Date("2026-10-23T12:00:00Z");
const OPERATOR = { role: "OPERATOR", sub: "u-op" };
const DRIVER = { role: "DRIVER", sub: "u-drv" };
/** The buyer portal's pseudo-user, as `makePseudoUser` hands it to `create()`. */
const BUYER = { type: "BUYER" as const, role: "CUSTOMER" as const };

const rule = (over: Record<string, unknown> = {}) => ({
  id: "r-ca",
  categoryId: "cat-thc",
  productId: null,
  jurisdiction: "STATE",
  states: ["CA"],
  surface: "ALL",
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveTo: null,
  liftedAt: null,
  reason: "State limit",
  targets: [],
  _count: { targets: 0 },
  ...over,
});
const LEGAL_BAN = rule({ id: "ban", surface: "ALL" });
const PORTAL_ONLY = rule({ id: "portal", surface: "BUYER_PORTAL" });

const addr = (over: Record<string, unknown> = {}) => ({
  isDefault: true,
  addressType: "BILLING",
  stateCode: "CA",
  stateNeedsReview: false,
  ...over,
});

/** The three ways a customer has no usable state today (each resolves UNRESOLVED). */
const NO_STATE: Array<[string, unknown[]]> = [
  ["no address at all", []],
  ["a default address with no state code", [addr({ stateCode: null })]],
  ["a default address whose state needs review", [addr({ stateNeedsReview: true })]],
];

describe("row 672 / SA-844: a sale whose state can't be resolved names its remedy", () => {
  let service: SellingRestrictionsService;
  let mock: any;
  let prisma: any;

  const switchOn = (on: boolean) =>
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: "selling_restrictions.enabled", value: on ? "true" : "false" },
      { key: "selling_restrictions.governing_address", value: "BILLING_FIRST" },
    ]);
  const rules = (...rs: unknown[]) => prisma.sellingRestriction.findMany.mockResolvedValue(rs);
  const customer = (addresses: unknown[], isWalkIn = false) =>
    prisma.customer.findFirst.mockResolvedValue({ isWalkIn, addresses });
  const storeIn = (state: string | null) =>
    mock.tenantConfig.findUnique.mockResolvedValue(state ? { state } : null);

  const staff = (over: Partial<SellableLinesParams> = {}): SellableLinesParams => ({
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
  /** Exactly the params `OrdersService.create` builds for a buyer's non-draft order on `fulfillPath`. */
  const buyerCreate = (fulfillPath: "ROUTE" | "SHIP"): SellableLinesParams => ({
    tenantId: T,
    customerId: "c1",
    lines: [{ productId: "p1" }],
    channel: restrictionChannelForPrincipal(BUYER),
    fulfilmentKind: saleFulfilmentKind({ counterSale: undefined, fulfillPath }),
    at: NOW,
  });
  const reject = async (p: SellableLinesParams): Promise<any> => {
    try {
      await service.assertLinesSellable(p);
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      return (e as ConflictException).getResponse();
    }
    throw new Error("expected a 409");
  };

  beforeEach(async () => {
    mock = createMockPrisma();
    mock.getTenantId.mockReturnValue(null);
    prisma = mock.forTenant();
    prisma.sellingRestriction = { findMany: jest.fn().mockResolvedValue([LEGAL_BAN]) };
    prisma.productCategory = {
      findMany: jest.fn().mockResolvedValue([{ id: "cat-thc", name: "THC" }]),
    };
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        name: "Gummies",
        parentProductId: null,
        categoryLabels: [{ categoryId: "cat-thc", mode: "INCLUDE" }],
      },
    ]);
    switchOn(true);
    customer([]);
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

  describe("R1/R2: a staff DELIVERY sale to a customer with no usable state (switch ON, legal ban)", () => {
    it.each(NO_STATE)(
      "the warning line is INDETERMINATE and names ADD_CUSTOMER_STATE for that customer (%s)",
      async (_label, addresses) => {
        customer(addresses);
        const body = await reject(staff());
        expect(body).toMatchObject({
          code: "RESTRICTION_WARNING",
          lines: [
            {
              lineKey: "n:0",
              productId: "p1",
              outcome: "INDETERMINATE",
              remedy: "ADD_CUSTOMER_STATE",
              customerId: "c1",
            },
          ],
        });
      },
    );

    it("a driver's hard block carries the same remedy on its line and on the staff blocked line", async () => {
      const body = await reject(staff({ principal: DRIVER }));
      expect(body).toMatchObject({
        code: "SELLING_RESTRICTED",
        blockedLines: [
          {
            productId: "p1",
            reason: "INDETERMINATE_ADDRESS",
            remedy: "ADD_CUSTOMER_STATE",
            customerId: "c1",
          },
        ],
        lines: [{ outcome: "INDETERMINATE", remedy: "ADD_CUSTOMER_STATE", customerId: "c1" }],
      });
    });

    it("an acknowledged warning still stamps the unresolved key (the remedy changes no stamp)", async () => {
      const first = await reject(staff());
      const decision = await service.assertLinesSellable(
        staff({
          ack: {
            warningHash: first.warningHash,
            restrictionOverrides: [{ lineKey: "n:0", reason: "Will add the address" }],
          },
        }),
      );
      expect(decision.stamps).toEqual([
        expect.objectContaining({ lineKey: "n:0", ruleIds: ["ban:UNKNOWN"] }),
      ]);
    });
  });

  it("R3: switch OFF, the staff channel is not judged at all: no warning, no remedy (owner ruling 09-25)", async () => {
    switchOn(false);
    await expect(service.assertLinesSellable(staff())).resolves.toMatchObject({
      off: true,
      stamps: [],
    });
  });

  describe.each(["ROUTE", "SHIP"] as const)(
    "R4: the buyer portal, %s (the order-create seam)",
    (path) => {
      it("the seam: a DELIVERY sale on the BUYER_PORTAL channel, judged by the customer's own state", () => {
        expect(saleFulfilmentKind({ fulfillPath: path })).toBe("DELIVERY");
        expect(restrictionChannelForPrincipal(BUYER)).toBe("BUYER_PORTAL");
      });

      it("control: a buyer IN the limited state is refused by the portal-only limit (the fixture really matches)", async () => {
        rules(PORTAL_ONLY);
        customer([addr({ stateCode: "CA" })]);
        await reject(buyerCreate(path));
      });

      it.each(NO_STATE)(
        "ALLOWED: every matched rule is portal-only and the buyer has %s (owner Option A)",
        async (_label, addresses) => {
          rules(PORTAL_ONLY);
          customer(addresses);
          await service.assertLinesSellable(buyerCreate(path)); // resolves: no 409
          // the address really was read: the ALLOW is the no-state exemption, not a skipped lookup
          expect(prisma.customer.findFirst).toHaveBeenCalledTimes(1);
        },
      );

      it.each(NO_STATE)(
        "FAIL CLOSED: a legal ban refuses a buyer with %s, asking for their delivery state (names only, B612)",
        async (_label, addresses) => {
          customer(addresses);
          const body = await reject(buyerCreate(path));
          expect(body).toEqual({
            code: "SELLING_RESTRICTED",
            message: PORTAL_NEEDS_STATE_MESSAGE,
            blockedLines: [{ productId: "p1", productName: "Gummies" }],
            remedy: "ADD_CUSTOMER_STATE",
          });
        },
      );

      it.each(NO_STATE)(
        "FAIL CLOSED: a legal ban beside a portal-only limit still refuses a buyer with %s",
        async (_label, addresses) => {
          rules(PORTAL_ONLY, LEGAL_BAN);
          customer(addresses);
          expect((await reject(buyerCreate(path))).message).toBe(PORTAL_NEEDS_STATE_MESSAGE);
        },
      );
    },
  );

  it("R4: a buyer refused for a known ban keeps the ordinary copy (the state copy is only for a missing state)", async () => {
    customer([addr({ stateCode: "CA" })]);
    const body = await reject(buyerCreate("ROUTE"));
    expect(body.message).toBe('"Gummies" can\'t be ordered right now.');
    expect(body).not.toHaveProperty("remedy");
  });

  it("R5: no customer at all (an order-less staff judgement) is INDETERMINATE with no remedy to offer", async () => {
    const body = await reject(staff({ customerId: null }));
    expect(body.lines).toEqual([expect.objectContaining({ outcome: "INDETERMINATE" })]);
    expect(body.lines[0]).not.toHaveProperty("remedy");
    expect(body.lines[0]).not.toHaveProperty("customerId");
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it("R6: once the customer has NV (not banned) there is no warning; with CA the BLOCK needs no remedy", async () => {
    customer([addr({ stateCode: "NV" })]);
    await expect(service.assertLinesSellable(staff())).resolves.toMatchObject({ stamps: [] });
    customer([addr({ stateCode: "CA" })]);
    const body = await reject(staff());
    expect(body.lines).toEqual([expect.objectContaining({ outcome: "BLOCK" })]);
    expect(body.lines[0]).not.toHaveProperty("remedy");
  });

  describe("a sale judged at the STORE with no store state names ADD_STORE_STATE (never a customer)", () => {
    it.each(["COUNTER", "PICKUP"] as const)("%s", async (fulfilmentKind) => {
      customer([addr({ stateCode: "NV" })]); // the customer's own state never judges a store sale
      const body = await reject(staff({ fulfilmentKind }));
      expect(body.lines).toEqual([
        expect.objectContaining({ outcome: "INDETERMINATE", remedy: "ADD_STORE_STATE" }),
      ]);
      expect(body.lines[0]).not.toHaveProperty("customerId");
    });

    it("the system walk-in on a DELIVERY is judged at the store too", async () => {
      customer([], true);
      const body = await reject(staff());
      expect(body.lines[0]).toMatchObject({ outcome: "INDETERMINATE", remedy: "ADD_STORE_STATE" });
      expect(body.lines[0]).not.toHaveProperty("customerId");
    });
  });
});
