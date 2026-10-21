import * as fs from "fs";
import * as path from "path";
import { ConflictException, InternalServerErrorException, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as core from "./selling-restrictions.core";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { createMockPrisma } from "../testing/prisma-mock";
import {
  activeRuleWhere,
  restrictedSummary,
  restrictionChannelForPrincipal,
} from "./selling-restrictions.core";
import {
  SellingRestrictionsService,
  SYSTEM_CONFIG_GOVERNING_ADDRESS,
} from "./selling-restrictions.service";

const T = "tenant-1";
/** A stored row of the removed switch: never read (row 510), kept in fixtures to prove it is ignored. */
const ENABLED_KEY = "selling_restrictions.enabled";
const GOVERNING_KEY = SYSTEM_CONFIG_GOVERNING_ADDRESS;
const NOW = new Date("2026-09-19T12:00:00Z");

/** A hand-stubbed model with a findMany plus write verbs the read-only test asserts stay untouched. */
const writeGuardedModel = (findMany: jest.Mock) => ({
  findMany,
  create: jest.fn(),
  update: jest.fn(),
  upsert: jest.fn(),
  delete: jest.fn(),
  updateMany: jest.fn(),
  deleteMany: jest.fn(),
});

describe("SellingRestrictionsService.evaluate", () => {
  let service: SellingRestrictionsService;
  let prisma: any;
  let mock: any;
  const mockAmbient = (id: string | null) => mock.getTenantId.mockReturnValue(id);

  const ENABLED = "selling_restrictions.enabled";
  const GOVERNING = "selling_restrictions.governing_address";
  const policyRows = (rows: Array<[string, string]>) =>
    prisma.systemConfig.findMany.mockResolvedValue(rows.map(([key, value]) => ({ key, value })));
  const enable = (on: boolean, shippingFirst = false) =>
    policyRows([
      [ENABLED, on ? "true" : "false"],
      [GOVERNING, shippingFirst ? "SHIPPING_FIRST" : "BILLING_FIRST"],
    ]);

  const dbRule = (over: Record<string, unknown> = {}) => ({
    id: "r1",
    categoryId: "cat-thc",
    productId: null,
    jurisdiction: "STATE",
    states: ["TX"],
    surface: "ALL",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    liftedAt: null,
    reason: "State ban",
    // row 509: a pre-targets rule (no target rows: the legacy-column fallback)
    targets: [],
    _count: { targets: 0 },
    ...over,
  });

  /** The rule-loading query (the one with targets), not the one-row "is there any rule" probe before it. */
  const rulesQuery = () =>
    prisma.sellingRestriction.findMany.mock.calls
      .map((c: unknown[]) => c[0] as any)
      .find((a: any) => a?.select?.targets);
  /** A tenant that has set at least one rule (the evaluation proceeds past the no-rule fast path). */
  const someRule = () => prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);

  const withAddresses = (addresses: unknown[]) =>
    prisma.customer.findFirst.mockResolvedValue({ addresses });

  const withProduct = (
    labels: Array<{ categoryId: string; mode: string }> = [
      { categoryId: "cat-thc", mode: "INCLUDE" },
    ],
  ) =>
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", name: "Gummies", parentProductId: null, categoryLabels: labels },
    ]);

  beforeEach(async () => {
    mock = createMockPrisma();
    // The service reaches models through forTenant(), which the mock serves from one shared model
    // surface — stub that surface (the shared mock has no sellingRestriction/productCategory yet).
    mock.getTenantId.mockReturnValue(null); // cron/system path: no ambient tenant
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

  it("row 510: no SystemConfig row — the tenant switch gates nothing, a STAFF evaluation is judged", async () => {
    policyRows([]);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([
      dbRule({ jurisdiction: "FEDERAL", states: [] }),
    ]);
    const res = await service.evaluate(T, "c1", [{ productId: "p1" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
      channel: "STAFF",
    });
    expect(res.outcome).toBe("BLOCK");
  });

  it("row 510: a leftover switch row set to false changes nothing — a live FEDERAL rule still BLOCKs staff", async () => {
    enable(false);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([
      dbRule({ jurisdiction: "FEDERAL", states: [] }),
    ]);
    expect(
      (await service.evaluate(T, "c1", [{ productId: "p1" }], { at: NOW, channel: "STAFF" }))
        .outcome,
    ).toBe("BLOCK");
  });

  it("row 510: a tenant with NO active rule is ALLOW after one probe for STAFF too, with no product read", async () => {
    policyRows([]);
    prisma.sellingRestriction.findMany.mockResolvedValue([]);
    const res = await service.evaluate(T, "c1", [{ productId: "p1" }], {
      at: NOW,
      channel: "STAFF",
    });
    expect(res).toEqual({ outcome: "ALLOW", reasons: [] });
    expect(prisma.sellingRestriction.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it("PORTAL: the switch is staff-channel only — switch off, a live FEDERAL rule still BLOCKs the portal", async () => {
    enable(false);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([
      dbRule({ jurisdiction: "FEDERAL", states: [] }),
    ]);
    const res = await service.evaluate(T, "c1", [{ productId: "p1" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
      channel: "BUYER_PORTAL",
    });
    expect(res.outcome).toBe("BLOCK");
  });

  it("PORTAL: no channel given fails closed to the portal — the switch cannot turn it off", async () => {
    enable(false);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([
      dbRule({ jurisdiction: "FEDERAL", states: [] }),
    ]);
    const res = await service.evaluate(T, "c1", [{ productId: "p1" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
    });
    expect(res.outcome).toBe("BLOCK");
  });

  it("PORTAL, switch off, a tenant with NO active rule: ALLOW after one rule probe, no product reads", async () => {
    enable(false);
    prisma.sellingRestriction.findMany.mockResolvedValue([]);
    const res = await service.evaluate(T, "c1", [{ productId: "p1" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
      channel: "BUYER_PORTAL",
    });
    expect(res).toEqual({ outcome: "ALLOW", reasons: [] });
    expect(prisma.sellingRestriction.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it("skipPortalOnlyRules: a BUYER_PORTAL-surface rule is ignored, a legal ban (ALL) still binds", async () => {
    enable(true);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([
      dbRule({ id: "portal", jurisdiction: "FEDERAL", states: [], surface: "BUYER_PORTAL" }),
    ]);
    const opts = {
      at: NOW,
      channel: "BUYER_PORTAL" as const,
      skipPortalOnlyRules: true,
      fulfilmentKind: "DELIVERY" as const,
    };
    expect((await service.evaluate(T, "c1", [{ productId: "p1" }], opts)).outcome).toBe("ALLOW");
    // same call without the option: the portal rule binds
    expect(
      (
        await service.evaluate(T, "c1", [{ productId: "p1" }], {
          ...opts,
          skipPortalOnlyRules: false,
        })
      ).outcome,
    ).toBe("BLOCK");
    prisma.sellingRestriction.findMany.mockResolvedValue([
      dbRule({ id: "ban", jurisdiction: "FEDERAL", states: [], surface: "ALL" }),
    ]);
    expect((await service.evaluate(T, "c1", [{ productId: "p1" }], opts)).outcome).toBe("BLOCK");
  });

  it("skipPortalOnlyRules, switch off: the no-rule probe excludes portal-only rules, so one alone costs nothing", async () => {
    enable(false);
    prisma.sellingRestriction.findMany.mockResolvedValue([]);
    const res = await service.evaluate(T, "c1", [{ productId: "p1" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
      channel: "BUYER_PORTAL",
      skipPortalOnlyRules: true,
    });
    expect(res).toEqual({ outcome: "ALLOW", reasons: [] });
    expect(prisma.sellingRestriction.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.sellingRestriction.findMany.mock.calls[0][0].where).toMatchObject({
      surface: { not: "BUYER_PORTAL" },
    });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it("ALLOW: enabled, no lines → ALLOW without touching the catalog", async () => {
    enable(true);
    expect(await service.evaluate(T, "c1", [])).toEqual({ outcome: "ALLOW", reasons: [] });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it("ALLOW: enabled, no rule matches, the customer's addresses are never loaded", async () => {
    enable(true);
    withProduct();
    const res = await service.evaluate(T, "c1", [{ productId: "p1" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
    });
    expect(res.outcome).toBe("ALLOW");
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it("BLOCK: a state rule on a label the product carries, in the default address's state", async () => {
    enable(true);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
    withAddresses([
      { isDefault: true, addressType: "BILLING", stateCode: "TX", stateNeedsReview: false },
    ]);
    const res = await service.evaluate(T, "c1", [{ productId: "p1" }, { productId: "p1" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
    });
    expect(res.outcome).toBe("BLOCK");
    expect(res.reasons).toHaveLength(1);
    expect(res.reasons[0]).toMatchObject({ reason: "STATE_BAN", state: "TX", categoryName: "THC" });
  });

  it("BLOCK: a FEDERAL rule never loads addresses", async () => {
    enable(true);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([
      dbRule({ jurisdiction: "FEDERAL", states: [] }),
    ]);
    const res = await service.evaluate(T, null, [{ productId: "p1" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
    });
    expect(res.outcome).toBe("BLOCK");
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it("INDETERMINATE: state rule matches but the customer has no addresses", async () => {
    enable(true);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
    withAddresses([]);
    expect(
      (
        await service.evaluate(T, "c1", [{ productId: "p1" }], {
          fulfilmentKind: "DELIVERY",
          at: NOW,
        })
      ).outcome,
    ).toBe("INDETERMINATE");
  });

  it("INDETERMINATE: a walk-in (null customer) with a matching state rule; no address query", async () => {
    enable(true);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
    expect(
      (
        await service.evaluate(T, null, [{ productId: "p1" }], {
          fulfilmentKind: "DELIVERY",
          at: NOW,
        })
      ).outcome,
    ).toBe("INDETERMINATE");
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  describe("system walk-in at the counter is judged by the TENANT's business state (CQ-04, ruling a)", () => {
    const walkInRow = { isWalkIn: true, addresses: [] as unknown[] };
    const stateRule = (states: string[]) => dbRule({ states, reason: "State ban" });
    const businessState = (state: string | null) =>
      prisma.tenantConfig.findUnique.mockResolvedValue(state === null ? null : { state });
    const sale = (customerId: string | null = "walk-in-id") =>
      service.evaluate(T, customerId, [{ productId: "p1" }], {
        fulfilmentKind: "DELIVERY",
        at: NOW,
        channel: "STAFF",
      });

    beforeEach(() => {
      enable(true);
      withProduct();
      prisma.systemConfig.findFirst.mockResolvedValue(null);
    });

    it("a covered product in an ALLOWED state is sold (no block)", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
      prisma.customer.findFirst.mockResolvedValue(walkInRow);
      businessState("FL");
      expect((await sale()).outcome).toBe("ALLOW");
    });

    it("a PROHIBITED state blocks with the rule's own reason", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
      prisma.customer.findFirst.mockResolvedValue(walkInRow);
      businessState("TX");
      const res = await sale();
      expect(res.outcome).toBe("BLOCK");
      expect(res.reasons[0]).toMatchObject({
        reason: "STATE_BAN",
        state: "TX",
        ruleId: "r1",
        categoryName: "THC",
      });
    });

    it("a state typed as a name resolves like a code; an unusable value is no state", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
      prisma.customer.findFirst.mockResolvedValue(walkInRow);
      businessState("Texas");
      expect((await sale()).outcome).toBe("BLOCK");
      businessState("ZZ");
      expect((await sale()).outcome).toBe("INDETERMINATE");
    });

    it("falls back to the legacy settings.state when the tenant config has none (Settings > Business's own read)", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
      prisma.customer.findFirst.mockResolvedValue(walkInRow);
      prisma.tenantConfig.findUnique.mockResolvedValue({ state: null });
      prisma.systemConfig.findFirst.mockResolvedValue({ value: "TX" });
      expect((await sale()).outcome).toBe("BLOCK");
    });

    it("a tenant with NO business state: the walk-in stays INDETERMINATE (unchanged)", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
      prisma.customer.findFirst.mockResolvedValue(walkInRow);
      businessState(null);
      expect((await sale()).outcome).toBe("INDETERMINATE");
    });

    it("a NAMED customer without an address is still INDETERMINATE and never gets the tenant state", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
      prisma.customer.findFirst.mockResolvedValue({ isWalkIn: null, addresses: [] });
      businessState("FL");
      expect((await sale("c1")).outcome).toBe("INDETERMINATE");
      expect(prisma.tenantConfig.findUnique).not.toHaveBeenCalled();
    });

    it("a customer NAMED 'Walk-in' that is not the system customer does NOT get the tenant state", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
      prisma.customer.findFirst.mockResolvedValue({
        businessName: "Walk-in",
        isWalkIn: false,
        addresses: [],
      });
      businessState("FL");
      expect((await sale("lookalike")).outcome).toBe("INDETERMINATE");
      expect(prisma.tenantConfig.findUnique).not.toHaveBeenCalled();
    });

    it("the system flag is read in the customer's own tenant-scoped query", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
      prisma.customer.findFirst.mockResolvedValue(walkInRow);
      businessState("FL");
      await sale();
      expect(prisma.customer.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "walk-in-id", tenantId: T },
          select: expect.objectContaining({ isWalkIn: true }),
        }),
      );
      expect(prisma.tenantConfig.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: T } }),
      );
    });
  });

  it("honours the tenant's shipping-first precedence", async () => {
    enable(true, true);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([dbRule({ states: ["FL"] })]);
    withAddresses([
      { isDefault: true, addressType: "BILLING", stateCode: "TX", stateNeedsReview: false },
      { isDefault: true, addressType: "SHIPPING", stateCode: "FL", stateNeedsReview: false },
    ]);
    expect(
      (
        await service.evaluate(T, "c1", [{ productId: "p1" }], {
          fulfilmentKind: "DELIVERY",
          at: NOW,
        })
      ).outcome,
    ).toBe("BLOCK");
  });

  it("variant opt-out: a variant that excludes its parent's label is not blocked by the label rule", async () => {
    enable(true);
    someRule(); // the tenant has a rule (the label rule), so the evaluation proceeds past the probe
    prisma.product.findMany
      .mockResolvedValueOnce([
        {
          id: "v1",
          name: "THC-free",
          parentProductId: "p1",
          categoryLabels: [
            { categoryId: "cat-thc", mode: "EXCLUDE", parentProductIdAtWrite: "p1" },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "p1",
          name: "Gummies",
          parentProductId: null,
          categoryLabels: [{ categoryId: "cat-thc", mode: "INCLUDE" }],
        },
      ]);
    withAddresses([
      { isDefault: true, addressType: "BILLING", stateCode: "TX", stateNeedsReview: false },
    ]);
    const res = await service.evaluate(T, "c1", [{ productId: "v1" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
    });
    expect(res.outcome).toBe("ALLOW");
    // no label survives the opt-out, so no category-scoped rule query is even built; the
    // product-scoped prefilter covers the variant AND its parent (lineage)
    // row 509: the same scope OR, once on the legacy columns and once on the rule's target rows
    expect(rulesQuery().where.OR).toEqual([
      { productId: { in: ["v1", "p1"] } },
      {
        targets: {
          some: {
            AND: [
              {
                addedAt: { lte: expect.any(Date) },
                OR: [{ removedAt: null }, { removedAt: { gt: expect.any(Date) } }],
              },
              { OR: [{ productId: { in: ["v1", "p1"] } }] },
            ],
          },
        },
      },
    ]);
  });

  it("variant inherits the parent's label when it does not opt out", async () => {
    enable(true);
    prisma.product.findMany
      .mockResolvedValueOnce([
        { id: "v1", name: "Sour", parentProductId: "p1", categoryLabels: [] },
      ])
      .mockResolvedValueOnce([
        {
          id: "p1",
          name: "Gummies",
          parentProductId: null,
          categoryLabels: [{ categoryId: "cat-thc", mode: "INCLUDE" }],
        },
      ]);
    prisma.sellingRestriction.findMany.mockResolvedValue([
      dbRule({ jurisdiction: "FEDERAL", states: [] }),
    ]);
    expect(
      (
        await service.evaluate(T, "c1", [{ productId: "v1" }], {
          fulfilmentKind: "DELIVERY",
          at: NOW,
        })
      ).outcome,
    ).toBe("BLOCK");
  });

  it("scopes every query by the explicit tenantId (no ambient context on cron paths)", async () => {
    enable(true);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
    withAddresses([]);
    await service.evaluate(T, "c1", [{ productId: "p1" }], { fulfilmentKind: "DELIVERY", at: NOW });
    expect(prisma.systemConfig.findMany.mock.calls[0][0].where).toEqual({
      tenantId: T,
      key: GOVERNING,
    });
    expect(prisma.product.findMany.mock.calls[0][0].where.tenantId).toBe(T);
    expect(prisma.sellingRestriction.findMany.mock.calls[0][0].where.tenantId).toBe(T); // the probe
    expect(rulesQuery().where.tenantId).toBe(T);
    expect(prisma.customer.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: T });
    expect(prisma.productCategory.findMany.mock.calls[0][0].where.tenantId).toBe(T);
  });

  it("is read-only: no create/update/delete on any model", async () => {
    enable(true);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
    await service.evaluate(T, "c1", [{ productId: "p1" }], { fulfilmentKind: "DELIVERY", at: NOW });
    for (const model of [
      "systemConfig",
      "product",
      "customer",
      "sellingRestriction",
      "productCategory",
    ]) {
      for (const m of ["create", "update", "upsert", "delete", "updateMany", "deleteMany"]) {
        expect(prisma[model][m]).not.toHaveBeenCalled();
      }
    }
  });

  it("REGRESSION (review #4): a product rule pinned to the PARENT blocks an order for its variant", async () => {
    enable(true);
    prisma.product.findMany
      .mockResolvedValueOnce([
        { id: "v1", name: "Sour", parentProductId: "p1", categoryLabels: [] },
      ])
      .mockResolvedValueOnce([
        { id: "p1", name: "Gummies", parentProductId: null, categoryLabels: [] },
      ]);
    prisma.sellingRestriction.findMany.mockResolvedValue([
      dbRule({ categoryId: null, productId: "p1", jurisdiction: "FEDERAL", states: [] }),
    ]);
    const res = await service.evaluate(T, "c1", [{ productId: "v1" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
    });
    expect(res.outcome).toBe("BLOCK");
    expect(res.reasons[0].productId).toBe("v1");
  });

  it("REGRESSION (review #6): a product id not found in this tenant is INDETERMINATE, not ALLOW", async () => {
    enable(true);
    someRule(); // a tenant with no rule at all never reaches the label read (row 510, Q6)
    prisma.product.findMany.mockResolvedValue([]);
    const res = await service.evaluate(T, "c1", [{ productId: "ghost" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
    });
    expect(res.outcome).toBe("INDETERMINATE");
    expect(res.reasons[0]).toMatchObject({ reason: "UNKNOWN_PRODUCT", productId: "ghost" });
  });

  it("REGRESSION (review #8): an ancestor chain that cannot be fully loaded fails closed", async () => {
    enable(true);
    someRule();
    // v1's parent p1 is never returned (missing / another tenant's / beyond the depth cap)
    prisma.product.findMany
      .mockResolvedValueOnce([
        { id: "v1", name: "Sour", parentProductId: "p1", categoryLabels: [] },
      ])
      .mockResolvedValue([]);
    const res = await service.evaluate(T, "c1", [{ productId: "v1" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
    });
    expect(res.outcome).toBe("INDETERMINATE");
    expect(res.reasons[0].reason).toBe("UNKNOWN_PRODUCT");
  });

  it("a parent cycle terminates and fails closed", async () => {
    enable(true);
    someRule();
    prisma.product.findMany
      .mockResolvedValueOnce([{ id: "a", name: "A", parentProductId: "b", categoryLabels: [] }])
      .mockResolvedValueOnce([{ id: "b", name: "B", parentProductId: "a", categoryLabels: [] }])
      .mockResolvedValue([]);
    const res = await service.evaluate(T, "c1", [{ productId: "a" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
    });
    expect(res.outcome).toBe("INDETERMINATE");
  });

  it("REGRESSION (review #5): a customer that is not this tenant's yields no addresses → INDETERMINATE", async () => {
    enable(true);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
    prisma.customer.findFirst.mockResolvedValue(null);
    expect(
      (
        await service.evaluate(T, "someone-elses", [{ productId: "p1" }], {
          fulfilmentKind: "DELIVERY",
          at: NOW,
        })
      ).outcome,
    ).toBe("INDETERMINATE");
  });

  it("REGRESSION (review #9): refuses to evaluate for a tenant other than the ambient one", async () => {
    mockAmbient("tenant-2");
    await expect(service.evaluate(T, "c1", [{ productId: "p1" }])).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(prisma.systemConfig.findMany).not.toHaveBeenCalled();
  });

  it("an ambient tenant equal to the requested tenant is fine", async () => {
    mockAmbient(T);
    enable(false);
    expect(
      (await service.evaluate(T, null, [{ productId: "p1" }], { channel: "STAFF" })).outcome,
    ).toBe("ALLOW"); // no rule: the evaluation ran (it did not refuse the tenant), and nothing bound
  });

  describe("getPolicy (SystemConfig keys)", () => {
    it("absent -> BILLING_FIRST, and there is no `enabled` field (the switch is gone)", async () => {
      policyRows([]);
      expect(await service.getPolicy(T)).toEqual({ addressPrecedence: "BILLING_FIRST" });
    });

    it("governing_address: SHIPPING_FIRST (any case) selects shipping first; anything else is billing first", async () => {
      policyRows([
        [ENABLED_KEY, "true"],
        [GOVERNING_KEY, " shipping_first "],
      ]);
      expect((await service.getPolicy(T)).addressPrecedence).toBe("SHIPPING_FIRST");
      policyRows([
        [ENABLED_KEY, "true"],
        [GOVERNING_KEY, "bogus"],
      ]);
      expect((await service.getPolicy(T)).addressPrecedence).toBe("BILLING_FIRST");
      policyRows([[ENABLED_KEY, "true"]]);
      expect((await service.getPolicy(T)).addressPrecedence).toBe("BILLING_FIRST");
    });

    it("a DB error propagates — the governing-address precedence is never silently defaulted (read only when a STATE rule needs an address, row 510)", async () => {
      withProduct();
      someRule(); // the dbRule is a STATE rule on the label: the evaluation needs the customer's state
      withAddresses([]);
      prisma.systemConfig.findMany.mockRejectedValue(new Error("db down"));
      await expect(
        service.evaluate(T, "c1", [{ productId: "p1" }], { channel: "STAFF" }),
      ).rejects.toThrow("db down");
    });

    it("a tenant with no rule never reads the policy at all (one probe, nothing else)", async () => {
      prisma.systemConfig.findMany.mockRejectedValue(new Error("db down"));
      await expect(
        service.evaluate(T, "c1", [{ productId: "p1" }], { channel: "STAFF" }),
      ).resolves.toEqual({ outcome: "ALLOW", reasons: [] });
      expect(prisma.systemConfig.findMany).not.toHaveBeenCalled();
    });
  });

  describe("governing_address parsing", () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    it("an UNKNOWN value parses to BILLING_FIRST and logs a warning", async () => {
      policyRows([
        [ENABLED_KEY, "true"],
        [GOVERNING_KEY, "DELIVERY_FIRST"],
      ]);
      expect((await service.getPolicy(T)).addressPrecedence).toBe("BILLING_FIRST");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(GOVERNING_KEY);
    });

    it.each([["SHIPPING_FIRST"], ["billing_first"], [" Shipping_First "]])(
      "a valid value %j does not warn",
      async (value) => {
        policyRows([
          [ENABLED_KEY, "true"],
          [GOVERNING_KEY, value],
        ]);
        await service.getPolicy(T);
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it("an ABSENT value is BILLING_FIRST without a warning", async () => {
      policyRows([[ENABLED_KEY, "true"]]);
      expect((await service.getPolicy(T)).addressPrecedence).toBe("BILLING_FIRST");
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("parent DENY + variant opt-out = DENY: the variant opted out of the parent's label but a product rule on the parent still binds it", async () => {
    enable(true);
    prisma.product.findMany
      .mockResolvedValueOnce([
        {
          id: "v1",
          name: "THC-free",
          parentProductId: "p1",
          categoryLabels: [
            { categoryId: "cat-thc", mode: "EXCLUDE", parentProductIdAtWrite: "p1" },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "p1",
          name: "Gummies",
          parentProductId: null,
          categoryLabels: [{ categoryId: "cat-thc", mode: "INCLUDE" }],
        },
      ]);
    prisma.sellingRestriction.findMany.mockResolvedValue([
      dbRule({
        id: "parent-rule",
        categoryId: null,
        productId: "p1",
        jurisdiction: "FEDERAL",
        states: [],
      }),
    ]);
    const res = await service.evaluate(T, "c1", [{ productId: "v1" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
    });
    expect(res.outcome).toBe("BLOCK");
    expect(res.reasons[0]).toMatchObject({ productId: "v1", ruleId: "parent-rule" });
  });

  it("REPARENT (lead ruling): evaluate() uses the variant's CURRENT parent — an opt-out is inert once the variant sits under a parent without the label", async () => {
    enable(true);
    const variant = (parent: string) => ({
      id: "v1",
      name: "THC-free",
      parentProductId: parent,
      // approved (pinned) while the variant sat under P1
      categoryLabels: [{ categoryId: "cat-thc", mode: "EXCLUDE", parentProductIdAtWrite: "P1" }],
    });
    prisma.customer.findFirst.mockResolvedValue({
      addresses: [
        { isDefault: true, addressType: "BILLING", stateCode: "TX", stateNeedsReview: false },
      ],
    });

    // Under P1 (carries cat-thc): the opt-out is active → the cat-thc rule doesn't bind → ALLOW.
    prisma.product.findMany.mockResolvedValueOnce([variant("P1")]).mockResolvedValueOnce([
      {
        id: "P1",
        name: "Gummies",
        parentProductId: null,
        categoryLabels: [{ categoryId: "cat-thc", mode: "INCLUDE" }],
      },
    ]);
    prisma.sellingRestriction.findMany.mockResolvedValue([dbRule({ categoryId: "cat-thc" })]);
    expect(
      (
        await service.evaluate(T, "c1", [{ productId: "v1" }], {
          fulfilmentKind: "DELIVERY",
          at: NOW,
        })
      ).outcome,
    ).toBe("ALLOW");

    // Reparented under P2 (carries cat-vape, banned in TX): the stale opt-out of cat-thc has no
    // effect and does NOT exempt the variant from P2's ban.
    prisma.product.findMany.mockResolvedValueOnce([variant("P2")]).mockResolvedValueOnce([
      {
        id: "P2",
        name: "Vapes",
        parentProductId: null,
        categoryLabels: [{ categoryId: "cat-vape", mode: "INCLUDE" }],
      },
    ]);
    prisma.sellingRestriction.findMany.mockResolvedValue([
      dbRule({ id: "r-vape", categoryId: "cat-vape" }),
    ]);
    const res = await service.evaluate(T, "c1", [{ productId: "v1" }], {
      fulfilmentKind: "DELIVERY",
      at: NOW,
    });
    expect(res.outcome).toBe("BLOCK");
    expect(res.reasons[0]).toMatchObject({ ruleId: "r-vape", state: "TX" });
  });

  it("logs a warning for a STATE rule with an unreadable state entry (it blocks everywhere until fixed)", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      enable(true);
      withProduct();
      prisma.sellingRestriction.findMany.mockResolvedValue([
        dbRule({ id: "typo", states: ["Tex"] }),
      ]);
      const res = await service.evaluate(T, "c1", [{ productId: "p1" }], {
        fulfilmentKind: "DELIVERY",
        at: NOW,
      });
      expect(res.outcome).toBe("BLOCK");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("typo"));
    } finally {
      warn.mockRestore();
    }
  });

  describe("opt-out pin (PC-lead ruling, option A) through the engine", () => {
    const variantUnder = (parent: string, pin: string | null | undefined) => ({
      id: "v1",
      name: "THC-free",
      parentProductId: parent,
      categoryLabels: [
        {
          categoryId: "cat-thc",
          mode: "EXCLUDE",
          ...(pin !== undefined ? { parentProductIdAtWrite: pin } : {}),
        },
      ],
    });
    const carryingParent = (id: string) => ({
      id,
      name: "Gummies",
      parentProductId: null,
      categoryLabels: [{ categoryId: "cat-thc", mode: "INCLUDE" }],
    });
    const run = async (variant: unknown, parent: unknown) => {
      enable(true);
      prisma.product.findMany.mockResolvedValueOnce([variant]).mockResolvedValueOnce([parent]);
      prisma.sellingRestriction.findMany.mockResolvedValue([
        dbRule({ jurisdiction: "FEDERAL", states: [] }),
      ]);
      return service.evaluate(T, "c1", [{ productId: "v1" }], {
        fulfilmentKind: "DELIVERY",
        at: NOW,
      });
    };

    it("MATCHING pin: the opt-out is effective → ALLOW", async () => {
      expect((await run(variantUnder("P1", "P1"), carryingParent("P1"))).outcome).toBe("ALLOW");
    });

    it("NULL pin: inert → the parent's label ban applies → DENY", async () => {
      expect((await run(variantUnder("P1", null), carryingParent("P1"))).outcome).toBe("BLOCK");
    });

    it("no pin at all (column not yet present): inert → DENY", async () => {
      expect((await run(variantUnder("P1", undefined), carryingParent("P1"))).outcome).toBe(
        "BLOCK",
      );
    });

    it("MISMATCHED pin: approved under P1, reparented to P3 which carries the same label → still DENY", async () => {
      expect((await run(variantUnder("P3", "P1"), carryingParent("P3"))).outcome).toBe("BLOCK");
    });
  });

  it("does NOT warn about a malformed rule that does not bind this evaluation (no per-cart log spam)", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      enable(true);
      withProduct([]); // the product carries no labels, so the category rule does not match
      prisma.sellingRestriction.findMany.mockResolvedValue([
        dbRule({ id: "typo", states: ["Tex"] }),
      ]);
      const res = await service.evaluate(T, "c1", [{ productId: "p1" }], {
        fulfilmentKind: "DELIVERY",
        at: NOW,
      });
      expect(res.outcome).toBe("ALLOW");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  describe("review MAJOR 1: deterministic rule citation through the service", () => {
    const fed = (id: string, effectiveFrom: string) =>
      dbRule({ id, effectiveFrom: new Date(effectiveFrom), jurisdiction: "FEDERAL", states: [] });

    it("asks the DB for a total order (effectiveFrom desc, id asc)", async () => {
      enable(true);
      withProduct();
      someRule();
      await service.evaluate(T, "c1", [{ productId: "p1" }], { at: NOW });
      expect(rulesQuery().orderBy).toEqual([{ effectiveFrom: "desc" }, { id: "asc" }]);
    });

    it("cites the same rule whatever order the DB returns the rows in (tie on effectiveFrom broken by id)", async () => {
      enable(true);
      withProduct();
      const rules = [
        fed("r-old", "2026-01-01T00:00:00Z"),
        fed("r-b", "2026-06-01T00:00:00Z"),
        fed("r-a", "2026-06-01T00:00:00Z"),
      ];
      const orders = [
        rules,
        [...rules].reverse(),
        [rules[1], rules[0], rules[2]],
        [rules[2], rules[1], rules[0]],
      ];
      const citations: Array<Array<string | null>> = [];
      for (const order of orders) {
        prisma.sellingRestriction.findMany.mockResolvedValue(order);
        const res = await service.evaluate(T, null, [{ productId: "p1" }], {
          fulfilmentKind: "DELIVERY",
          at: NOW,
        });
        citations.push(res.reasons.map((r) => r.ruleId));
      }
      expect(citations).toEqual(orders.map(() => ["r-a"]));
    });
  });

  describe("review MINOR 2: the rule query filters to active rules in SQL too", () => {
    it("ANDs activeRuleWhere(at) with the tenant/scope OR", async () => {
      enable(true);
      withProduct();
      someRule();
      await service.evaluate(T, "c1", [{ productId: "p1" }], { at: NOW });
      const where = rulesQuery().where;
      expect(where.tenantId).toBe(T);
      const scope = [{ productId: { in: ["p1"] } }, { categoryId: { in: ["cat-thc"] } }];
      const activeTarget = {
        addedAt: { lte: NOW },
        OR: [{ removedAt: null }, { removedAt: { gt: NOW } }],
      };
      expect(where.OR).toEqual([
        ...scope,
        { targets: { some: { AND: [activeTarget, { OR: scope }] } } },
      ]); // row 509
      expect(where.AND).toEqual([activeRuleWhere(NOW)]);
    });

    it("still ignores an inactive rule the DB hands back (the in-JS check is a defensive second gate)", async () => {
      enable(true);
      withProduct();
      prisma.sellingRestriction.findMany.mockResolvedValue([
        dbRule({ jurisdiction: "FEDERAL", states: [], liftedAt: new Date("2026-09-01T00:00:00Z") }),
      ]);
      const res = await service.evaluate(T, null, [{ productId: "p1" }], {
        fulfilmentKind: "DELIVERY",
        at: NOW,
      });
      expect(res.outcome).toBe("ALLOW");
    });
  });

  describe("row 510: the stored switch is gone", () => {
    it("the switch constants no longer exist", () => {
      const mod = jest.requireActual("./selling-restrictions.service") as Record<string, unknown>;
      for (const name of [
        "SELLING_RESTRICTIONS_ENABLED_VALUE",
        "SELLING_RESTRICTIONS_DISABLED_VALUE",
        "SYSTEM_CONFIG_ENABLED",
      ])
        expect(mod).not.toHaveProperty(name);
    });

    it("a stored selling_restrictions.enabled row of any value is ignored: the policy carries the address precedence only", async () => {
      for (const stored of ["true", "false", "0", "garbage", ""]) {
        policyRows([[ENABLED_KEY, stored]]);
        expect(await service.getPolicy(T)).toEqual({ addressPrecedence: "BILLING_FIRST" });
      }
      // and the read itself asks for the governing-address row only
      const calls = prisma.systemConfig.findMany.mock.calls;
      const where = calls[calls.length - 1][0].where;
      expect(JSON.stringify(where)).not.toContain("selling_restrictions.enabled");
    });
  });

  describe("review MINOR 6: UNKNOWN_PRODUCT shows no raw id", () => {
    it.each(["ghost", "3f2b8c1e-9d4a-4e7b-8a15-6c0d2f9e7a41"])(
      "an unknown product %s: generic productName, message without the id, productId keeps it",
      async (id) => {
        enable(true);
        someRule();
        prisma.product.findMany.mockResolvedValue([]);
        const res = await service.evaluate(T, "c1", [{ productId: id }], {
          fulfilmentKind: "DELIVERY",
          at: NOW,
        });
        expect(res.outcome).toBe("INDETERMINATE");
        expect(res.reasons[0]).toMatchObject({
          reason: "UNKNOWN_PRODUCT",
          productId: id,
          productName: "Unknown product",
        });
        expect(res.reasons[0].message).not.toContain(id);
      },
    );
  });

  describe("round 1 (Opus): a KNOWN name survives when only an ancestor is missing", () => {
    it("a variant whose parent is gone reports the variant's own name (no id) so the operator can find the line", async () => {
      enable(true);
      someRule();
      prisma.product.findMany
        .mockResolvedValueOnce([
          { id: "v-uuid-1", name: "Bourbon 750ml", parentProductId: "gone", categoryLabels: [] },
        ])
        .mockResolvedValue([]);
      const res = await service.evaluate(T, "c1", [{ productId: "v-uuid-1" }], {
        fulfilmentKind: "DELIVERY",
        at: NOW,
      });
      expect(res.outcome).toBe("INDETERMINATE");
      expect(res.reasons[0]).toMatchObject({
        reason: "UNKNOWN_PRODUCT",
        productName: "Bourbon 750ml",
      });
      expect(res.reasons[0].message).toContain("Bourbon 750ml");
      expect(res.reasons[0].message).not.toContain("v-uuid-1");
    });
  });

  describe("businessStateMissing (the 'customers without a state' card; the readiness sweep and switch are gone, row 510)", () => {
    const stateRule = (over: Record<string, unknown> = {}) => dbRule({ states: ["TX"], ...over });
    const NOW_PAST = new Date("2026-01-01T00:00:00Z");

    beforeEach(() => {
      prisma.tenantConfig.findUnique.mockResolvedValue({ state: "TX" });
      prisma.systemConfig.findFirst.mockResolvedValue(null);
    });

    it("an active STATE rule + no business state is MISSING", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([stateRule()]);
      prisma.tenantConfig.findUnique.mockResolvedValue(null);
      expect(await service.businessStateMissing(T)).toBe(true);
    });

    it("asks the database only for the tenant's ACTIVE STATE rules", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([]);
      await service.businessStateMissing(T);
      const where = prisma.sellingRestriction.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ tenantId: T, jurisdiction: "STATE" });
      expect(JSON.stringify(where.AND)).toContain("liftedAt"); // activeRuleWhere(at), the SQL twin
    });

    it("no rules at all + no business state is NOT missing (nothing needs a state), and the state is not even read", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([]);
      prisma.tenantConfig.findUnique.mockResolvedValue(null);
      expect(await service.businessStateMissing(T)).toBe(false);
      expect(prisma.tenantConfig.findUnique).not.toHaveBeenCalled();
    });

    it("only FEDERAL rules + no business state is not missing", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([
        stateRule({ jurisdiction: "FEDERAL", states: [] }),
      ]);
      prisma.tenantConfig.findUnique.mockResolvedValue(null);
      expect(await service.businessStateMissing(T)).toBe(false);
    });

    it("an INACTIVE STATE rule (lifted, expired or buyer-portal-only) + no state is not missing", async () => {
      prisma.tenantConfig.findUnique.mockResolvedValue(null);
      for (const inactive of [
        stateRule({ liftedAt: NOW_PAST }),
        stateRule({ effectiveTo: NOW_PAST }),
        stateRule({ surface: "BUYER_PORTAL" }), // does not bind the counter (staff channel)
        stateRule({ states: [] }), // malformed: blocks everywhere, needs no state
      ]) {
        prisma.sellingRestriction.findMany.mockResolvedValue([inactive]);
        expect(await service.businessStateMissing(T)).toBe(false);
      }
    });

    it("an active STATE rule + a business state is not missing; an unreadable one counts as missing", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([stateRule()]);
      prisma.tenantConfig.findUnique.mockResolvedValue({ state: "TX" });
      expect(await service.businessStateMissing(T)).toBe(false);
      prisma.tenantConfig.findUnique.mockResolvedValue({ state: "  " });
      expect(await service.businessStateMissing(T)).toBe(true);
    });

    it("a business state in the legacy settings.state counts as present", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([stateRule()]);
      prisma.tenantConfig.findUnique.mockResolvedValue(null);
      prisma.systemConfig.findFirst.mockResolvedValue({ value: "fl" });
      expect(await service.businessStateMissing(T)).toBe(false);
    });

    it("businessStateMissing and evaluate() ask the SAME stateRuleInPlay (they cannot drift)", async () => {
      const spy = jest.spyOn(core, "stateRuleInPlay");
      try {
        prisma.sellingRestriction.findMany.mockResolvedValue([stateRule()]);
        prisma.tenantConfig.findUnique.mockResolvedValue({ state: "TX" });
        await service.businessStateMissing(T);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][1]).toBe("STAFF");
        spy.mockClear();
        withProduct();
        prisma.customer.findFirst.mockResolvedValue({ isWalkIn: true, addresses: [] });
        await service.evaluate(T, "walk-in-id", [{ productId: "p1" }], {
          at: NOW,
          channel: "STAFF",
        });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.results[0].value).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    describe("L8 M1: a tenant with a PICKUP path judges it by the store state, so a portal rule needs one", () => {
      const portalRule = () => stateRule({ surface: "BUYER_PORTAL" });
      const modelIs = (mode: string | null) =>
        prisma.tenantFeatureConfig.findFirst.mockResolvedValue(mode ? { mode } : null);

      it("pickup + a portal-only STATE rule + no store state is MISSING", async () => {
        modelIs("pickup");
        prisma.sellingRestriction.findMany.mockResolvedValue([portalRule()]);
        prisma.tenantConfig.findUnique.mockResolvedValue(null);
        expect(await service.businessStateMissing(T)).toBe(true);
      });

      it("pickup + a portal-only STATE rule + a store state is not missing", async () => {
        modelIs("pickup");
        prisma.sellingRestriction.findMany.mockResolvedValue([portalRule()]);
        prisma.tenantConfig.findUnique.mockResolvedValue({ state: "TX" });
        expect(await service.businessStateMissing(T)).toBe(false);
      });

      it("pickup_ship (MIXED) + a portal-only STATE rule + no store state is MISSING (its pickup path needs one)", async () => {
        modelIs("pickup_ship");
        prisma.sellingRestriction.findMany.mockResolvedValue([portalRule()]);
        prisma.tenantConfig.findUnique.mockResolvedValue(null);
        expect(await service.businessStateMissing(T)).toBe(true);
      });

      it.each(["ship", "both", "delivery", null])(
        "%s + a portal-only STATE rule + no store state is not missing (no pickup path)",
        async (mode) => {
          modelIs(mode);
          prisma.sellingRestriction.findMany.mockResolvedValue([portalRule()]);
          prisma.tenantConfig.findUnique.mockResolvedValue(null);
          expect(await service.businessStateMissing(T)).toBe(false);
        },
      );
    });

    it("the readiness probe, the assert-ready gate and the NOT_READY constant are gone from the engine", () => {
      expect(service).not.toHaveProperty("getEnableReadiness");
      expect(service).not.toHaveProperty("assertReadyToEnable");
      expect(Object.keys(jest.requireActual("./selling-restrictions.service"))).not.toEqual(
        expect.arrayContaining(["SELLING_RESTRICTIONS_NOT_READY"]),
      );
    });
  });

  describe("checkLinesSellable / assertLinesSellable (the step-2 choke point)", () => {
    // `qtyDelta` is `unknown` on purpose: the fail-closed cases below need null, NaN and strings,
    // which the typed interface (rightly) cannot express.
    const line = (productId: string, qtyDelta?: unknown) =>
      (qtyDelta === undefined ? { productId } : { productId, qtyDelta }) as {
        productId: string;
        qtyDelta?: number;
      };
    /** The no-op staff-write decision: nothing to stamp or carry, nothing breached. */
    const NO_OVERRIDE = { stamps: [], carried: [], active: false, warningHash: null };
    const args = (lines: Array<{ productId: string; qtyDelta?: number }>, over = {}) => ({
      tenantId: T,
      customerId: "c1",
      lines,
      // NB: specs are not type-checked, so the required `channel` is only enforced in source; most
      // fixtures here are `surface: "ALL"` (channel-agnostic) — a BUYER_PORTAL fixture must say so.
      channel: "STAFF" as const,
      fulfilmentKind: "DELIVERY" as const,
      at: NOW,
      ...over,
    });
    const fedRule = () => dbRule({ jurisdiction: "FEDERAL", states: [] });
    const inState = (stateCode: string) =>
      withAddresses([
        { isDefault: true, addressType: "BILLING", stateCode, stateNeedsReview: false },
      ]);
    const expectNoReads = () => {
      expect(prisma.systemConfig.findMany).not.toHaveBeenCalled();
      expect(prisma.product.findMany).not.toHaveBeenCalled();
      expect(prisma.sellingRestriction.findMany).not.toHaveBeenCalled();
      expect(prisma.customer.findFirst).not.toHaveBeenCalled();
    };

    it("decrease-only lines (qtyDelta <= 0) ALLOW with NO reads at all — even before the policy is read", async () => {
      const lines = [line("p1", -2), line("p1", 0), line("p2", -0.5)];
      expect(await service.checkLinesSellable(args(lines))).toEqual({
        outcome: "ALLOW",
        reasons: [],
      });
      await expect(service.assertLinesSellable(args(lines))).resolves.toMatchObject(NO_OVERRIDE);
      expectNoReads();
    });

    it("no lines, and lines with an empty product id, also ALLOW without reads", async () => {
      expect((await service.checkLinesSellable(args([]))).outcome).toBe("ALLOW");
      expect((await service.checkLinesSellable(args([line("")]))).outcome).toBe("ALLOW");
      expectNoReads();
    });

    it("a banned product that is only being REMOVED or REDUCED never blocks (the owner rule)", async () => {
      enable(true);
      withProduct();
      prisma.sellingRestriction.findMany.mockResolvedValue([
        dbRule({ jurisdiction: "FEDERAL", states: [] }),
      ]);
      await expect(
        service.assertLinesSellable(args([line("p1", -5), line("p1", 0)])),
      ).resolves.toMatchObject(NO_OVERRIDE);
      expectNoReads();
    });

    it("a NEW line (no qtyDelta) is checked: BLOCK throws a 409 SELLING_RESTRICTED with the blocked lines", async () => {
      enable(true);
      withProduct();
      prisma.sellingRestriction.findMany.mockResolvedValue([
        dbRule({ jurisdiction: "FEDERAL", states: [] }),
      ]);
      const evaluation = await service.checkLinesSellable(args([line("p1")]));
      expect(evaluation.outcome).toBe("BLOCK");

      const err: ConflictException = await service.assertLinesSellable(args([line("p1")])).then(
        () => {
          throw new Error("expected a rejection");
        },
        (e) => e,
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toEqual({
        code: "SELLING_RESTRICTED",
        message: restrictedSummary(evaluation.reasons),
        blockedLines: evaluation.reasons,
      });
      // a client with no blocked-lines panel toasts `message`: it must be a real sentence
      expect((err.getResponse() as { message: string }).message).toMatch(/can't be sold/);
      expect((err.getResponse() as any).blockedLines[0]).toMatchObject({
        productId: "p1",
        reason: "FEDERAL_BAN",
        ruleId: "r1",
      });
    });

    it("a quantity INCREASE (qtyDelta > 0) is checked", async () => {
      enable(true);
      withProduct();
      inState("TX");
      prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
      await expect(service.assertLinesSellable(args([line("p1", 3)]))).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it("INDETERMINATE (state rule, unresolvable address) also throws 409 SELLING_RESTRICTED — fail closed", async () => {
      enable(true);
      withProduct();
      prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
      withAddresses([]);
      const err: ConflictException = await service.assertLinesSellable(args([line("p1")])).then(
        () => {
          throw new Error("expected a rejection");
        },
        (e) => e,
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect((err.getResponse() as any).code).toBe("SELLING_RESTRICTED");
      expect((err.getResponse() as any).blockedLines[0]).toMatchObject({
        reason: "INDETERMINATE_ADDRESS",
      });
    });

    // ── B612: the 409 BODY is redacted by audience ───────────────────────────────────────────────
    // Everything below asserts on the exception's RESPONSE BODY (`getResponse()`), never on what a
    // component renders: the bug was the gap between what the UI shows and what the API sends.
    describe("B612 — the 409 body carries rule detail to STAFF only", () => {
      const ADMIN_REASON = "SECRET-ADMIN-REASON";
      const bodyOf = async (over: Record<string, unknown>, lines = [line("p1")]) => {
        const err: ConflictException = await service.assertLinesSellable(args(lines, over)).then(
          () => {
            throw new Error("expected a rejection");
          },
          (e) => e,
        );
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getStatus()).toBe(409);
        return err.getResponse() as {
          code: string;
          message: string;
          blockedLines: Array<Record<string, unknown>>;
        };
      };
      // every fragment of internal rule detail the fixtures below can put in a body
      const LEAKS = [
        /\br1\b/, // ruleId
        /FEDERAL_BAN|STATE_BAN|BUYER_PORTAL_ONLY|INDETERMINATE_ADDRESS|UNKNOWN_PRODUCT/, // reason
        /\bTX\b/, // state
        /\bTHC\b/, // categoryName
        new RegExp(ADMIN_REASON), // rule text inside a line's own message
        /"ruleId"|"reason"|"state"|"categoryName"/, // the keys themselves
      ];
      const expectRedacted = (body: unknown) => {
        const json = JSON.stringify(body);
        for (const leak of LEAKS) expect(json).not.toMatch(leak);
      };
      const banFederally = () => {
        enable(true);
        withProduct();
        prisma.sellingRestriction.findMany.mockResolvedValue([
          dbRule({ jurisdiction: "FEDERAL", states: [], reason: ADMIN_REASON }),
        ]);
      };

      it("STAFF keeps the full detail: ruleId, reason, categoryName and the rule text in message", async () => {
        banFederally();
        const body = await bodyOf({ channel: "STAFF" });
        expect(body.blockedLines[0]).toMatchObject({
          productId: "p1",
          productName: "Gummies",
          ruleId: "r1",
          reason: "FEDERAL_BAN",
          categoryName: "THC",
        });
        expect(body.message).toContain(ADMIN_REASON);
      });

      it("STAFF keeps the state on a state ban", async () => {
        enable(true);
        withProduct();
        inState("TX");
        prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
        const body = await bodyOf({ channel: "STAFF" });
        expect(body.blockedLines[0]).toMatchObject({ reason: "STATE_BAN", state: "TX" });
      });

      it("a BUYER gets ONLY {productId, productName} per line and a sentence built from the name — one blocked line", async () => {
        banFederally();
        const body = await bodyOf({ channel: "BUYER_PORTAL" });
        expect(body).toEqual({
          code: "SELLING_RESTRICTED",
          message: `"Gummies" can't be ordered right now.`,
          blockedLines: [{ productId: "p1", productName: "Gummies" }],
        });
        expect(Object.keys(body.blockedLines[0]).sort()).toEqual(["productId", "productName"]);
        expectRedacted(body);
      });

      it("a BUYER's STATE ban is redacted too (no state, no reason, no category)", async () => {
        enable(true);
        withProduct();
        inState("TX");
        prisma.sellingRestriction.findMany.mockResolvedValue([dbRule({ reason: ADMIN_REASON })]);
        expectRedacted(await bodyOf({ channel: "BUYER_PORTAL" }));
      });

      it("a BUYER's INDETERMINATE (unresolvable address) is redacted — the address problem is not disclosed", async () => {
        enable(true);
        withProduct();
        prisma.sellingRestriction.findMany.mockResolvedValue([dbRule({ reason: ADMIN_REASON })]);
        withAddresses([]);
        expectRedacted(await bodyOf({ channel: "BUYER_PORTAL" }));
      });

      it("MULTI-line: a buyer's message counts and names products only, never a line's message", async () => {
        enable(true);
        prisma.product.findMany.mockResolvedValue([
          {
            id: "p1",
            name: "Gummies",
            parentProductId: null,
            categoryLabels: [{ categoryId: "cat-thc", mode: "INCLUDE" }],
          },
          {
            id: "p2",
            name: "Chews",
            parentProductId: null,
            categoryLabels: [{ categoryId: "cat-thc", mode: "INCLUDE" }],
          },
        ]);
        prisma.sellingRestriction.findMany.mockResolvedValue([
          dbRule({ jurisdiction: "FEDERAL", states: [], reason: ADMIN_REASON }),
        ]);
        const many = [line("p1"), line("p2")];

        const buyer = await bodyOf({ channel: "BUYER_PORTAL" }, many);
        expect(buyer.message).toBe(
          `2 items on this order can't be ordered right now: "Gummies", "Chews".`,
        );
        expect(buyer.blockedLines).toEqual([
          { productId: "p1", productName: "Gummies" },
          { productId: "p2", productName: "Chews" },
        ]);
        expectRedacted(buyer);

        const staff = await bodyOf({ channel: "STAFF" }, many);
        expect(staff.blockedLines).toHaveLength(2);
        expect(staff.blockedLines[0]).toMatchObject({ ruleId: "r1", reason: "FEDERAL_BAN" });
      });

      it("FAILS CLOSED: an omitted, unknown or lower-case channel is redacted like a buyer", async () => {
        banFederally();
        for (const channel of [undefined, null, "", "staff", "OPERATOR", "BUYER_PORTAL"]) {
          const body = await bodyOf({ channel });
          expect(body.blockedLines).toEqual([{ productId: "p1", productName: "Gummies" }]);
          expectRedacted(body);
        }
      });

      it("the same product can never appear twice in a buyer body (rule count is not disclosed)", async () => {
        const reason = (ruleId: string) => ({
          productId: "p1",
          productName: "Gummies",
          ruleId,
          reason: "FEDERAL_BAN" as const,
          message: ADMIN_REASON,
        });
        jest
          .spyOn(service, "checkLinesSellable")
          .mockResolvedValue({ outcome: "BLOCK", reasons: [reason("r1"), reason("r2")] });
        const body = await bodyOf({ channel: "BUYER_PORTAL" });
        expect(body.blockedLines).toEqual([{ productId: "p1", productName: "Gummies" }]);
        expect(body.message).toBe(`"Gummies" can't be ordered right now.`);
      });

      it("NO other source file builds a SELLING_RESTRICTED body: the redaction lives at the one throw", () => {
        // A second construction site (a controller, a filter, a caller that catches and re-throws)
        // would be one refactor away from bypassing the redaction. Scan every non-spec API source.
        const root = path.join(__dirname, "..");
        const offenders: string[] = [];
        const walk = (dir: string) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              if (e.name !== "node_modules") walk(full);
            } else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) {
              if (
                /code:\s*(?:["']SELLING_RESTRICTED["']|API_ERROR_CODES\.SELLING_RESTRICTED\b)/.test(
                  fs.readFileSync(full, "utf8"),
                )
              ) {
                offenders.push(path.relative(root, full).split(path.sep).join("/"));
              }
            }
          }
        };
        walk(root);
        // three construction sites in this ONE file: assertLinesSellable (staff branch, buyer branch) and hiddenFromPortalRestriction (WS6)
        expect(offenders).toEqual(["selling-restrictions/selling-restrictions.service.ts"]);
      });
    });

    it("ALLOW resolves (enabled, nothing matches)", async () => {
      enable(true);
      withProduct();
      const evaluation = await service.checkLinesSellable(args([line("p1")]));
      expect(evaluation).toEqual({ outcome: "ALLOW", reasons: [] });
      await expect(service.assertLinesSellable(args([line("p1")]))).resolves.toMatchObject(
        NO_OVERRIDE,
      );
    });

    it("row 510: with no switch row a checkable line is still judged (here: no rule, so ALLOW after one probe)", async () => {
      policyRows([]); // no row: the switch is gone, it is not "off"
      expect(await service.checkLinesSellable(args([line("p1")]))).toEqual({
        outcome: "ALLOW",
        reasons: [],
      });
      await expect(service.assertLinesSellable(args([line("p1", 4)]))).resolves.toMatchObject(
        NO_OVERRIDE,
      );
      expect(prisma.sellingRestriction.findMany).toHaveBeenCalledTimes(2); // one probe per call
      expect(prisma.product.findMany).not.toHaveBeenCalled(); // and nothing else is read
    });

    it("only the checkable lines reach the evaluator: a reduced banned product is dropped, an added one is not", async () => {
      enable(true);
      // p2 (added) carries no label; p1 (reduced) would be banned if it were looked at.
      prisma.product.findMany.mockResolvedValue([
        { id: "p2", name: "Plain", parentProductId: null, categoryLabels: [] },
      ]);
      prisma.sellingRestriction.findMany.mockResolvedValue([
        dbRule({ jurisdiction: "FEDERAL", states: [] }),
      ]);
      const res = await service.checkLinesSellable(args([line("p1", -3), line("p2", 2)]));
      expect(res.outcome).toBe("ALLOW");
      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: T, id: { in: ["p2"] } } }),
      );
    });

    it("threads `channel` through: a BUYER_PORTAL-only rule blocks the buyer portal, never staff", async () => {
      enable(true);
      withProduct();
      prisma.sellingRestriction.findMany.mockResolvedValue([
        dbRule({ jurisdiction: "FEDERAL", states: [], surface: "BUYER_PORTAL" }),
      ]);
      const staff = await service.checkLinesSellable(args([line("p1")], { channel: "STAFF" }));
      expect(staff.outcome).toBe("ALLOW");
      // a caller that omits the channel (JS / `any`) FAILS CLOSED to the channel that binds more
      const noChannel = await service.checkLinesSellable(
        args([line("p1")], { channel: undefined as any }),
      );
      expect(noChannel.outcome).toBe("BLOCK");
      const buyer = await service.checkLinesSellable(
        args([line("p1")], { channel: "BUYER_PORTAL" }),
      );
      expect(buyer.outcome).toBe("BLOCK");
      expect(buyer.reasons[0].reason).toBe("BUYER_PORTAL_ONLY");
    });

    it("P1: a real BUYER principal (type BUYER, no role) hits a BUYER_PORTAL ban and is BLOCKED; a staff principal is unaffected", async () => {
      enable(true);
      withProduct();
      prisma.sellingRestriction.findMany.mockResolvedValue([
        dbRule({ jurisdiction: "FEDERAL", states: [], surface: "BUYER_PORTAL" }),
      ]);
      const buyerPrincipal = { sub: "b-1", email: "b@example.test", type: "BUYER" as const };
      const staffPrincipal = { sub: "u-1", role: "OPERATOR" };
      const asBuyer = await service.checkLinesSellable(
        args([line("p1")], { channel: restrictionChannelForPrincipal(buyerPrincipal) }),
      );
      expect(asBuyer.outcome).toBe("BLOCK");
      expect(asBuyer.reasons[0].reason).toBe("BUYER_PORTAL_ONLY");
      const asStaff = await service.checkLinesSellable(
        args([line("p1")], { channel: restrictionChannelForPrincipal(staffPrincipal) }),
      );
      expect(asStaff.outcome).toBe("ALLOW");
    });

    it("threads `at` through: a rule that starts after the point in time does not bind", async () => {
      enable(true);
      withProduct();
      prisma.sellingRestriction.findMany.mockResolvedValue([
        dbRule({ jurisdiction: "FEDERAL", states: [], effectiveFrom: new Date("2026-12-01") }),
      ]);
      expect((await service.checkLinesSellable(args([line("p1")]))).outcome).toBe("ALLOW");
      expect(
        (await service.checkLinesSellable(args([line("p1")], { at: new Date("2027-01-01") })))
          .outcome,
      ).toBe("BLOCK");
    });

    it("is read-only: neither method writes to ANY model", async () => {
      enable(true);
      withProduct();
      prisma.sellingRestriction.findMany.mockResolvedValue([fedRule()]);
      await service.checkLinesSellable(args([line("p1")]));
      await service.assertLinesSellable(args([line("p1")])).catch(() => undefined);
      for (const model of ["sellingRestriction", "product", "customer", "systemConfig"]) {
        for (const verb of ["create", "update", "upsert", "delete", "updateMany", "deleteMany"]) {
          expect(prisma[model][verb]).not.toHaveBeenCalled();
        }
      }
    });

    // Decisions are per PRODUCT: a Case line -1 next to a Piece line +12 is one net change, not
    // "a decrease plus an increase" (the review's repack hole).
    it("a REPACK across two lines of one product (net <= 0) is never checked", async () => {
      enable(true);
      withProduct();
      prisma.sellingRestriction.findMany.mockResolvedValue([fedRule()]);
      for (const lines of [
        [line("p1", -12), line("p1", 12)],
        [line("p1", -12), line("p1", 5)],
      ]) {
        await expect(service.assertLinesSellable(args(lines))).resolves.toMatchObject(NO_OVERRIDE);
      }
      expectNoReads();
    });

    // FAIL CLOSED: a delta that cannot be netted is never read as a decrease, and a product that
    // nets to an increase is checked once whatever its individual lines say.
    it.each([
      ["a null delta (explicit JSON null)", [line("p1", null)]],
      ["a NaN delta", [line("p1", Number.NaN)]],
      ['the string "-1"', [line("p1", "-1")]],
      ['the string "5"', [line("p1", "5")]],
      ["an Infinity delta", [line("p1", Number.POSITIVE_INFINITY)]],
      ["one un-nettable line beside a big decrease", [line("p1", -100), line("p1", null)]],
      ["a NaN net (-Infinity + Infinity)", [line("p1", -Infinity), line("p1", Infinity)]],
      [
        "lines netting to an increase (-1 + 12 + 0)",
        [line("p1", -1), line("p1", 12), line("p1", 0)],
      ],
    ])("%s is CHECKED, never dropped as a decrease", async (_label, lines) => {
      enable(true);
      withProduct();
      prisma.sellingRestriction.findMany.mockResolvedValue([fedRule()]);
      expect((await service.checkLinesSellable(args(lines))).outcome).toBe("BLOCK");
      expect(prisma.product.findMany.mock.calls[0][0].where.id.in).toEqual(["p1"]); // once
    });

    it("an empty tenantId is a programming error, not a silent OFF (it would read zero SystemConfig rows)", async () => {
      await expect(
        service.checkLinesSellable(args([line("p1")], { tenantId: "" })),
      ).rejects.toThrow(/tenantId/);
      expectNoReads();
    });
  });
});

describe("SellingRestrictionsService.restrictedProductIdsFor (portal limits: what a buyer is not shown)", () => {
  let service: SellingRestrictionsService;
  let prisma: any;

  const portalRule = (over: Record<string, unknown> = {}) => ({
    id: "r1",
    categoryId: null,
    productId: "p1",
    jurisdiction: "STATE",
    states: ["TX"],
    surface: "BUYER_PORTAL",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    liftedAt: null,
    reason: "Portal limit",
    targets: [], // row 509: a pre-targets rule (legacy-column fallback)
    _count: { targets: 0 },
    ...over,
  });
  const customerIn = (state: string | null, isWalkIn = false) =>
    prisma.customer.findFirst.mockResolvedValue({
      isWalkIn,
      addresses:
        state === null
          ? []
          : [
              {
                isDefault: true,
                addressType: "BILLING",
                stateCode: state,
                stateNeedsReview: false,
              },
            ],
    });

  beforeEach(async () => {
    const mock: any = createMockPrisma();
    mock.getTenantId.mockReturnValue(null);
    prisma = mock.forTenant();
    prisma.sellingRestriction = writeGuardedModel(jest.fn().mockResolvedValue([]));
    prisma.productCategory = writeGuardedModel(jest.fn().mockResolvedValue([]));
    prisma.productCategoryLabel = writeGuardedModel(jest.fn().mockResolvedValue([]));
    prisma.systemConfig.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", name: "Gummies", parentProductId: null, categoryLabels: [] },
    ]);
    const mod = await Test.createTestingModule({
      providers: [
        SellingRestrictionsService,
        ProductLabelsService,
        { provide: PrismaService, useValue: mock },
      ],
    }).compile();
    service = mod.get(SellingRestrictionsService);
  });

  it("(i) with no active rule it costs ONE query and reads nothing else", async () => {
    const ids = await service.restrictedProductIdsFor(T, "c1", NOW);
    expect(ids.size).toBe(0);
    expect(prisma.sellingRestriction.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(prisma.productCategoryLabel.findMany).not.toHaveBeenCalled();
    expect(prisma.systemConfig.findMany).not.toHaveBeenCalled();
  });

  it("reads only the rules ACTIVE at `at` (the SQL twin), for this tenant", async () => {
    await service.restrictedProductIdsFor(T, null, NOW);
    expect(prisma.sellingRestriction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: T, AND: [activeRuleWhere(NOW)] } }),
    );
  });

  it("hides the rule's product from a buyer whose default address is in the rule's state", async () => {
    prisma.sellingRestriction.findMany.mockResolvedValue([portalRule()]);
    customerIn("TX");
    expect([...(await service.restrictedProductIdsFor(T, "c1", NOW))]).toEqual(["p1"]);
  });

  it("leaves a buyer in another state alone", async () => {
    prisma.sellingRestriction.findMany.mockResolvedValue([portalRule()]);
    customerIn("NY");
    expect((await service.restrictedProductIdsFor(T, "c1", NOW)).size).toBe(0);
  });

  it("with no state on file, a portal-only limit hides nothing and a legal ban hides", async () => {
    prisma.sellingRestriction.findMany.mockResolvedValue([portalRule()]);
    customerIn(null);
    expect((await service.restrictedProductIdsFor(T, "c1", NOW)).size).toBe(0);
    prisma.sellingRestriction.findMany.mockResolvedValue([portalRule({ surface: "ALL" })]);
    expect([...(await service.restrictedProductIdsFor(T, "c1", NOW))]).toEqual(["p1"]);
  });

  it("row 509: a rule row read without its target count fails loud (never a silent legacy fallback)", async () => {
    const {
      targets: _t,
      _count: _c,
      ...bare
    } = portalRule({ jurisdiction: "FEDERAL", states: [] });
    prisma.sellingRestriction.findMany.mockResolvedValue([bare]);
    await expect(service.restrictedProductIdsFor(T, "c1", NOW)).rejects.toThrow(
      /without its targets and count/,
    );
  });

  it("a FEDERAL rule hides without consulting any address", async () => {
    prisma.sellingRestriction.findMany.mockResolvedValue([
      portalRule({ jurisdiction: "FEDERAL", states: [] }),
    ]);
    expect([...(await service.restrictedProductIdsFor(T, "c1", NOW))]).toEqual(["p1"]);
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it("a rule that names a missing product id hides that id (nothing to resolve, fail closed)", async () => {
    prisma.sellingRestriction.findMany.mockResolvedValue([
      portalRule({ productId: "ghost", jurisdiction: "FEDERAL", states: [] }),
    ]);
    prisma.product.findMany.mockResolvedValue([]);
    expect((await service.restrictedProductIdsFor(T, "c1", NOW)).has("ghost")).toBe(true);
  });
});
