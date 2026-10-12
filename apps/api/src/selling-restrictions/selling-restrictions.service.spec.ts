import * as fs from "fs";
import * as path from "path";
import { ConflictException, InternalServerErrorException, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { excludeWalkIn } from "../customers/walk-in-protected";
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
  ENABLE_READINESS_MAX_PAGES,
  ENABLE_READINESS_PAGE_SIZE,
  SELLING_RESTRICTIONS_DISABLED_VALUE,
  SELLING_RESTRICTIONS_ENABLED_VALUE,
  SELLING_RESTRICTIONS_NOT_READY,
  SellingRestrictionsService,
  SYSTEM_CONFIG_ENABLED,
  SYSTEM_CONFIG_GOVERNING_ADDRESS,
} from "./selling-restrictions.service";

const T = "tenant-1";
const ENABLED_KEY = SYSTEM_CONFIG_ENABLED;
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
    ...over,
  });

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

  it("OFF: no SystemConfig row means OFF (owner ruling: off by default) — and nothing else is read", async () => {
    policyRows([]);
    const res = await service.evaluate(T, "c1", [{ productId: "p1" }], { at: NOW });
    expect(res).toEqual({ outcome: "OFF", reasons: [] });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(prisma.sellingRestriction.findMany).not.toHaveBeenCalled();
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it("OFF: switch explicitly off ignores even a live FEDERAL rule", async () => {
    enable(false);
    prisma.sellingRestriction.findMany.mockResolvedValue([
      dbRule({ jurisdiction: "FEDERAL", states: [] }),
    ]);
    expect((await service.evaluate(T, "c1", [{ productId: "p1" }])).outcome).toBe("OFF");
    expect(prisma.sellingRestriction.findMany).not.toHaveBeenCalled();
  });

  it("ALLOW: enabled, no lines → ALLOW without touching the catalog", async () => {
    enable(true);
    expect(await service.evaluate(T, "c1", [])).toEqual({ outcome: "ALLOW", reasons: [] });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it("ALLOW: enabled, no rule matches, the customer's addresses are never loaded", async () => {
    enable(true);
    withProduct();
    const res = await service.evaluate(T, "c1", [{ productId: "p1" }], { at: NOW });
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
    const res = await service.evaluate(T, null, [{ productId: "p1" }], { at: NOW });
    expect(res.outcome).toBe("BLOCK");
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it("INDETERMINATE: state rule matches but the customer has no addresses", async () => {
    enable(true);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
    withAddresses([]);
    expect((await service.evaluate(T, "c1", [{ productId: "p1" }], { at: NOW })).outcome).toBe(
      "INDETERMINATE",
    );
  });

  it("INDETERMINATE: a walk-in (null customer) with a matching state rule; no address query", async () => {
    enable(true);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
    expect((await service.evaluate(T, null, [{ productId: "p1" }], { at: NOW })).outcome).toBe(
      "INDETERMINATE",
    );
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  describe("system walk-in at the counter is judged by the TENANT's business state (CQ-04, ruling a)", () => {
    const walkInRow = { isWalkIn: true, addresses: [] as unknown[] };
    const stateRule = (states: string[]) => dbRule({ states, reason: "State ban" });
    const businessState = (state: string | null) =>
      prisma.tenantConfig.findUnique.mockResolvedValue(state === null ? null : { state });
    const sale = (customerId: string | null = "walk-in-id") =>
      service.evaluate(T, customerId, [{ productId: "p1" }], { at: NOW, channel: "STAFF" });

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
    expect((await service.evaluate(T, "c1", [{ productId: "p1" }], { at: NOW })).outcome).toBe(
      "BLOCK",
    );
  });

  it("variant opt-out: a variant that excludes its parent's label is not blocked by the label rule", async () => {
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
    withAddresses([
      { isDefault: true, addressType: "BILLING", stateCode: "TX", stateNeedsReview: false },
    ]);
    const res = await service.evaluate(T, "c1", [{ productId: "v1" }], { at: NOW });
    expect(res.outcome).toBe("ALLOW");
    // no label survives the opt-out, so no category-scoped rule query is even built; the
    // product-scoped prefilter covers the variant AND its parent (lineage)
    expect(prisma.sellingRestriction.findMany.mock.calls[0][0].where.OR).toEqual([
      { productId: { in: ["v1", "p1"] } },
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
    expect((await service.evaluate(T, "c1", [{ productId: "v1" }], { at: NOW })).outcome).toBe(
      "BLOCK",
    );
  });

  it("scopes every query by the explicit tenantId (no ambient context on cron paths)", async () => {
    enable(true);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
    withAddresses([]);
    await service.evaluate(T, "c1", [{ productId: "p1" }], { at: NOW });
    expect(prisma.systemConfig.findMany.mock.calls[0][0].where).toEqual({
      tenantId: T,
      key: { in: [ENABLED, GOVERNING] },
    });
    expect(prisma.product.findMany.mock.calls[0][0].where.tenantId).toBe(T);
    expect(prisma.sellingRestriction.findMany.mock.calls[0][0].where.tenantId).toBe(T);
    expect(prisma.customer.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: T });
    expect(prisma.productCategory.findMany.mock.calls[0][0].where.tenantId).toBe(T);
  });

  it("is read-only: no create/update/delete on any model", async () => {
    enable(true);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
    await service.evaluate(T, "c1", [{ productId: "p1" }], { at: NOW });
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
    const res = await service.evaluate(T, "c1", [{ productId: "v1" }], { at: NOW });
    expect(res.outcome).toBe("BLOCK");
    expect(res.reasons[0].productId).toBe("v1");
  });

  it("REGRESSION (review #6): a product id not found in this tenant is INDETERMINATE, not ALLOW", async () => {
    enable(true);
    prisma.product.findMany.mockResolvedValue([]);
    const res = await service.evaluate(T, "c1", [{ productId: "ghost" }], { at: NOW });
    expect(res.outcome).toBe("INDETERMINATE");
    expect(res.reasons[0]).toMatchObject({ reason: "UNKNOWN_PRODUCT", productId: "ghost" });
  });

  it("REGRESSION (review #8): an ancestor chain that cannot be fully loaded fails closed", async () => {
    enable(true);
    // v1's parent p1 is never returned (missing / another tenant's / beyond the depth cap)
    prisma.product.findMany
      .mockResolvedValueOnce([
        { id: "v1", name: "Sour", parentProductId: "p1", categoryLabels: [] },
      ])
      .mockResolvedValue([]);
    const res = await service.evaluate(T, "c1", [{ productId: "v1" }], { at: NOW });
    expect(res.outcome).toBe("INDETERMINATE");
    expect(res.reasons[0].reason).toBe("UNKNOWN_PRODUCT");
  });

  it("a parent cycle terminates and fails closed", async () => {
    enable(true);
    prisma.product.findMany
      .mockResolvedValueOnce([{ id: "a", name: "A", parentProductId: "b", categoryLabels: [] }])
      .mockResolvedValueOnce([{ id: "b", name: "B", parentProductId: "a", categoryLabels: [] }])
      .mockResolvedValue([]);
    const res = await service.evaluate(T, "c1", [{ productId: "a" }], { at: NOW });
    expect(res.outcome).toBe("INDETERMINATE");
  });

  it("REGRESSION (review #5): a customer that is not this tenant's yields no addresses → INDETERMINATE", async () => {
    enable(true);
    withProduct();
    prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
    prisma.customer.findFirst.mockResolvedValue(null);
    expect(
      (await service.evaluate(T, "someone-elses", [{ productId: "p1" }], { at: NOW })).outcome,
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
    expect((await service.evaluate(T, null, [{ productId: "p1" }])).outcome).toBe("OFF");
  });

  describe("getPolicy (SystemConfig keys)", () => {
    it.each([
      ["absent", []],
      ['"false"', [[ENABLED_KEY, "false"]]],
      ['" FALSE "', [[ENABLED_KEY, " FALSE "]]],
    ] as Array<[string, Array<[string, string]>]>)("%s → OFF", async (_n, rows) => {
      policyRows(rows);
      expect((await service.getPolicy(T)).enabled).toBe(false);
    });

    it.each(["true", "TRUE", "1", "yes", "garbage"])(
      "%j → ON (an unrecognised value fails closed, never OFF)",
      async (value) => {
        policyRows([[ENABLED_KEY, value]]);
        expect((await service.getPolicy(T)).enabled).toBe(true);
      },
    );

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

    it("a DB error propagates — an unreadable switch is never silently OFF", async () => {
      prisma.systemConfig.findMany.mockRejectedValue(new Error("db down"));
      await expect(service.evaluate(T, "c1", [{ productId: "p1" }])).rejects.toThrow("db down");
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
    const res = await service.evaluate(T, "c1", [{ productId: "v1" }], { at: NOW });
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
    expect((await service.evaluate(T, "c1", [{ productId: "v1" }], { at: NOW })).outcome).toBe(
      "ALLOW",
    );

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
    const res = await service.evaluate(T, "c1", [{ productId: "v1" }], { at: NOW });
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
      const res = await service.evaluate(T, "c1", [{ productId: "p1" }], { at: NOW });
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
      return service.evaluate(T, "c1", [{ productId: "v1" }], { at: NOW });
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
      const res = await service.evaluate(T, "c1", [{ productId: "p1" }], { at: NOW });
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
      await service.evaluate(T, "c1", [{ productId: "p1" }], { at: NOW });
      expect(prisma.sellingRestriction.findMany.mock.calls[0][0].orderBy).toEqual([
        { effectiveFrom: "desc" },
        { id: "asc" },
      ]);
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
        const res = await service.evaluate(T, null, [{ productId: "p1" }], { at: NOW });
        citations.push(res.reasons.map((r) => r.ruleId));
      }
      expect(citations).toEqual(orders.map(() => ["r-a"]));
    });
  });

  describe("review MINOR 2: the rule query filters to active rules in SQL too", () => {
    it("ANDs activeRuleWhere(at) with the tenant/scope OR", async () => {
      enable(true);
      withProduct();
      await service.evaluate(T, "c1", [{ productId: "p1" }], { at: NOW });
      const where = prisma.sellingRestriction.findMany.mock.calls[0][0].where;
      expect(where.tenantId).toBe(T);
      expect(where.OR).toEqual([
        { productId: { in: ["p1"] } },
        { categoryId: { in: ["cat-thc"] } },
      ]);
      expect(where.AND).toEqual([activeRuleWhere(NOW)]);
    });

    it("still ignores an inactive rule the DB hands back (the in-JS check is a defensive second gate)", async () => {
      enable(true);
      withProduct();
      prisma.sellingRestriction.findMany.mockResolvedValue([
        dbRule({ jurisdiction: "FEDERAL", states: [], liftedAt: new Date("2026-09-01T00:00:00Z") }),
      ]);
      const res = await service.evaluate(T, null, [{ productId: "p1" }], { at: NOW });
      expect(res.outcome).toBe("ALLOW");
    });
  });

  describe("review MINOR 5: the stored switch literals", () => {
    it('are exactly "true" / "false"', () => {
      expect(SELLING_RESTRICTIONS_ENABLED_VALUE).toBe("true");
      expect(SELLING_RESTRICTIONS_DISABLED_VALUE).toBe("false");
    });

    it("the ENABLED literal parses ON, the DISABLED literal parses OFF, anything else fails closed to ON", async () => {
      policyRows([[ENABLED_KEY, SELLING_RESTRICTIONS_ENABLED_VALUE]]);
      expect((await service.getPolicy(T)).enabled).toBe(true);
      policyRows([[ENABLED_KEY, SELLING_RESTRICTIONS_DISABLED_VALUE]]);
      expect((await service.getPolicy(T)).enabled).toBe(false);
      for (const other of ["0", "off", "no", "disabled", "", "fasle"]) {
        policyRows([[ENABLED_KEY, other]]);
        expect((await service.getPolicy(T)).enabled).toBe(true);
      }
    });
  });

  describe("review MINOR 6: UNKNOWN_PRODUCT shows no raw id", () => {
    it.each(["ghost", "3f2b8c1e-9d4a-4e7b-8a15-6c0d2f9e7a41"])(
      "an unknown product %s: generic productName, message without the id, productId keeps it",
      async (id) => {
        enable(true);
        prisma.product.findMany.mockResolvedValue([]);
        const res = await service.evaluate(T, "c1", [{ productId: id }], { at: NOW });
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
      prisma.product.findMany
        .mockResolvedValueOnce([
          { id: "v-uuid-1", name: "Bourbon 750ml", parentProductId: "gone", categoryLabels: [] },
        ])
        .mockResolvedValue([]);
      const res = await service.evaluate(T, "c1", [{ productId: "v-uuid-1" }], { at: NOW });
      expect(res.outcome).toBe("INDETERMINATE");
      expect(res.reasons[0]).toMatchObject({
        reason: "UNKNOWN_PRODUCT",
        productName: "Bourbon 750ml",
      });
      expect(res.reasons[0].message).toContain("Bourbon 750ml");
      expect(res.reasons[0].message).not.toContain("v-uuid-1");
    });
  });

  describe("round 1 (Opus): the readiness sweep is bounded and never reads green when partial", () => {
    it("stops at ENABLE_READINESS_MAX_PAGES with truncated: true and ready: false", async () => {
      const page = Array.from({ length: ENABLE_READINESS_PAGE_SIZE }, (_v, i) => ({
        id: `c${i}`,
        addresses: [
          { isDefault: true, addressType: "BILLING", stateCode: "TX", stateNeedsReview: false },
        ],
      }));
      prisma.customer.findMany.mockResolvedValue(page);
      policyRows([]);
      const r = await service.getEnableReadiness(T);
      expect(prisma.customer.findMany).toHaveBeenCalledTimes(ENABLE_READINESS_MAX_PAGES);
      expect(r.truncated).toBe(true);
      expect(r.ready).toBe(false); // every customer resolved, yet a partial sweep is NOT ready
      expect(r.indeterminateCustomerCount).toBe(0);
      await expect(service.assertReadyToEnable(T)).rejects.toMatchObject({
        response: { code: "SELLING_RESTRICTIONS_NOT_READY" },
      });
    });
  });

  describe("review MAJOR 3: getEnableReadiness / assertReadyToEnable", () => {
    const addr = (over: Record<string, unknown> = {}) => ({
      isDefault: true,
      addressType: "BILLING",
      stateCode: "TX",
      stateNeedsReview: false,
      ...over,
    });
    const cid = (i: number) => `c${String(i).padStart(5, "0")}`;
    const customer = (id: string, addresses: unknown[]) => ({ id, addresses });

    /** A `customer.findMany` that honours orderBy id / cursor / skip / take over a fixed table. */
    const serveCustomers = (rows: Array<{ id: string; addresses: unknown[] }>) =>
      prisma.customer.findMany.mockImplementation(async (args: any) => {
        const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
        const start = args.cursor
          ? sorted.findIndex((r) => r.id === args.cursor.id) + (args.skip ?? 0)
          : 0;
        return sorted.slice(start, start + args.take);
      });

    beforeEach(() => {
      // a tenant that HAS a business state (Settings > Business); the missing case is its own test below
      prisma.tenantConfig.findUnique.mockResolvedValue({ state: "TX" });
      prisma.systemConfig.findFirst.mockResolvedValue(null);
    });

    it("counts every bucket, with the switch still OFF (readiness is asked BEFORE enabling)", async () => {
      enable(false);
      serveCustomers([
        customer("ok-default", [addr()]),
        customer("ok-sole-nondefault", [addr({ isDefault: false })]),
        customer("no-address", []),
        customer("ambiguous", [
          addr({ isDefault: false, stateCode: "TX" }),
          addr({ isDefault: false, addressType: "SHIPPING", stateCode: "FL" }),
        ]),
        customer("null-state", [addr({ stateCode: null })]),
        customer("bogus-state", [addr({ stateCode: "ZZ" })]),
        customer("needs-review", [addr({ stateNeedsReview: true })]),
        // resolvable-looking rows that DISAGREE: counted only by resolveGoverningState
        customer("conflicting-defaults", [addr({ stateCode: "TX" }), addr({ stateCode: "FL" })]),
      ]);
      expect(await service.getEnableReadiness(T)).toEqual({
        ready: false,
        truncated: false,
        customerCount: 8,
        customersWithoutAddress: 1,
        customersAmbiguousNoDefault: 1,
        addressesMissingStateCode: 2, // null-state + bogus-state (no USABLE code)
        addressesNeedingReview: 1,
        indeterminateCustomerCount: 6, // everyone except the two resolvable customers
        businessStateMissing: false,
      });
    });

    it("ready: every customer resolves → ready true, indeterminate 0", async () => {
      enable(true);
      serveCustomers([
        customer("a", [addr()]),
        customer("b", [addr({ stateCode: "fl" }), addr({ isDefault: false, stateCode: "TX" })]),
        customer("c", [addr({ isDefault: false })]),
      ]);
      expect(await service.getEnableReadiness(T)).toEqual({
        ready: true,
        truncated: false,
        customerCount: 3,
        customersWithoutAddress: 0,
        customersAmbiguousNoDefault: 0,
        addressesMissingStateCode: 0,
        addressesNeedingReview: 0,
        indeterminateCustomerCount: 0,
        businessStateMissing: false,
      });
    });

    it("a tenant with no customers is ready", async () => {
      policyRows([]);
      serveCustomers([]);
      const r = await service.getEnableReadiness(T);
      expect(r.ready).toBe(true);
      expect(r.customerCount).toBe(0);
    });

    it("counts with the SAME resolver and the tenant's CURRENT precedence policy", async () => {
      // default BILLING has no usable state; default SHIPPING is TX.
      serveCustomers([
        customer("split", [
          addr({ addressType: "BILLING", stateCode: null }),
          addr({ addressType: "SHIPPING", stateCode: "TX" }),
        ]),
      ]);
      policyRows([[GOVERNING_KEY, "BILLING_FIRST"]]);
      expect((await service.getEnableReadiness(T)).indeterminateCustomerCount).toBe(1);
      policyRows([[GOVERNING_KEY, "SHIPPING_FIRST"]]);
      const shippingFirst = await service.getEnableReadiness(T);
      expect(shippingFirst.indeterminateCustomerCount).toBe(0);
      expect(shippingFirst.ready).toBe(true);
    });

    it("reads customers in cursor PAGES (>1 page), tenant-scoped, ignoring soft-deleted", async () => {
      const total = ENABLE_READINESS_PAGE_SIZE * 2 + 201; // 1201 → 3 pages
      const rows = Array.from({ length: total }, (_, i) =>
        // every 100th customer has no address; the rest resolve
        customer(cid(i), i % 100 === 0 ? [] : [addr()]),
      );
      serveCustomers(rows);
      enable(true);
      const r = await service.getEnableReadiness(T);

      expect(r).toMatchObject({
        customerCount: total,
        customersWithoutAddress: Math.ceil(total / 100),
        indeterminateCustomerCount: Math.ceil(total / 100),
        ready: false,
      });
      const calls = prisma.customer.findMany.mock.calls.map((c: any[]) => c[0]);
      expect(calls).toHaveLength(3);
      for (const c of calls) {
        expect(c.where).toEqual(excludeWalkIn({ tenantId: T, deletedAt: null }));
        expect(c.orderBy).toEqual({ id: "asc" });
        expect(c.take).toBe(ENABLE_READINESS_PAGE_SIZE);
      }
      expect(calls[0].cursor).toBeUndefined();
      expect(calls[1]).toMatchObject({
        cursor: { id: cid(ENABLE_READINESS_PAGE_SIZE - 1) },
        skip: 1,
      });
      expect(calls[2]).toMatchObject({
        cursor: { id: cid(ENABLE_READINESS_PAGE_SIZE * 2 - 1) },
        skip: 1,
      });
    });

    describe("the tenant's own business state (counter sales judge the walk-in by it)", () => {
      const resolvable = [customer("ok", [addr()])];
      const stateRule = (over: Record<string, unknown> = {}) => dbRule({ states: ["TX"], ...over });
      const NOW_PAST = new Date("2026-01-01T00:00:00Z");

      beforeEach(() => {
        enable(true);
        serveCustomers(resolvable);
      });

      it("an active STATE rule + no business state is NOT READY, the walk-in never the cause", async () => {
        prisma.sellingRestriction.findMany.mockResolvedValue([stateRule()]);
        prisma.tenantConfig.findUnique.mockResolvedValue(null);
        const r = await service.getEnableReadiness(T);
        expect(r).toMatchObject({
          ready: false,
          businessStateMissing: true,
          customersWithoutAddress: 0,
          indeterminateCustomerCount: 0,
        });
        await expect(service.assertReadyToEnable(T)).rejects.toMatchObject({
          response: {
            code: "SELLING_RESTRICTIONS_NOT_READY",
            readiness: { businessStateMissing: true },
          },
        });
      });

      it("asks the database only for the tenant's ACTIVE STATE rules", async () => {
        prisma.sellingRestriction.findMany.mockResolvedValue([]);
        await service.getEnableReadiness(T);
        const where = prisma.sellingRestriction.findMany.mock.calls[0][0].where;
        expect(where).toMatchObject({ tenantId: T, jurisdiction: "STATE" });
        expect(JSON.stringify(where.AND)).toContain("liftedAt"); // activeRuleWhere(at), the SQL twin
      });

      it("no rules at all + no business state is READY (nothing needs a state)", async () => {
        prisma.sellingRestriction.findMany.mockResolvedValue([]);
        prisma.tenantConfig.findUnique.mockResolvedValue(null);
        const r = await service.getEnableReadiness(T);
        expect(r).toMatchObject({ ready: true, businessStateMissing: false });
        expect(prisma.tenantConfig.findUnique).not.toHaveBeenCalled(); // not even read
      });

      it("only FEDERAL rules + no business state is READY", async () => {
        prisma.sellingRestriction.findMany.mockResolvedValue([
          stateRule({ jurisdiction: "FEDERAL", states: [] }),
        ]);
        prisma.tenantConfig.findUnique.mockResolvedValue(null);
        expect(await service.getEnableReadiness(T)).toMatchObject({
          ready: true,
          businessStateMissing: false,
        });
      });

      it("an INACTIVE STATE rule (lifted, expired or buyer-portal-only) + no state is READY", async () => {
        prisma.tenantConfig.findUnique.mockResolvedValue(null);
        for (const inactive of [
          stateRule({ liftedAt: NOW_PAST }),
          stateRule({ effectiveTo: NOW_PAST }),
          stateRule({ surface: "BUYER_PORTAL" }), // does not bind the counter (staff channel)
          stateRule({ states: [] }), // malformed: blocks everywhere, needs no state
        ]) {
          prisma.sellingRestriction.findMany.mockResolvedValue([inactive]);
          expect(await service.getEnableReadiness(T)).toMatchObject({
            ready: true,
            businessStateMissing: false,
          });
        }
      });

      it("an active STATE rule + a business state is READY", async () => {
        prisma.sellingRestriction.findMany.mockResolvedValue([stateRule()]);
        prisma.tenantConfig.findUnique.mockResolvedValue({ state: "TX" });
        expect(await service.getEnableReadiness(T)).toMatchObject({
          ready: true,
          businessStateMissing: false,
        });
      });

      it("a business state the engine cannot read counts as missing", async () => {
        prisma.sellingRestriction.findMany.mockResolvedValue([stateRule()]);
        prisma.tenantConfig.findUnique.mockResolvedValue({ state: "  " });
        expect((await service.getEnableReadiness(T)).businessStateMissing).toBe(true);
      });

      it("a business state in the legacy settings.state counts as present", async () => {
        prisma.sellingRestriction.findMany.mockResolvedValue([stateRule()]);
        prisma.tenantConfig.findUnique.mockResolvedValue(null);
        prisma.systemConfig.findFirst.mockResolvedValue({ value: "fl" });
        const r = await service.getEnableReadiness(T);
        expect(r.businessStateMissing).toBe(false);
        expect(r.ready).toBe(true);
      });

      it("readiness and evaluate() ask the SAME stateRuleInPlay (they cannot drift)", async () => {
        const spy = jest.spyOn(core, "stateRuleInPlay");
        try {
          // readiness
          prisma.sellingRestriction.findMany.mockResolvedValue([stateRule()]);
          prisma.tenantConfig.findUnique.mockResolvedValue({ state: "TX" });
          await service.getEnableReadiness(T);
          expect(spy).toHaveBeenCalledTimes(1);
          expect(spy.mock.calls[0][1]).toBe("STAFF");
          // evaluate(): a walk-in sale with a STATE rule in play
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
    });

    describe("system walk-in customer (CQ-04): excluded by predicate, never by name", () => {
      type Row = {
        id: string;
        businessName: string;
        isWalkIn?: boolean | null;
        addresses: unknown[];
      };
      /** Evaluates the query's own `where` (null-or-false `isWalkIn` filter), so the SQL predicate is proven. */
      const matches = (row: Row, cond: any): boolean => {
        if (!cond || typeof cond !== "object") return true;
        if (Array.isArray(cond.AND) && !cond.AND.every((c: any) => matches(row, c))) return false;
        if (Array.isArray(cond.OR) && !cond.OR.some((c: any) => matches(row, c))) return false;
        if ("isWalkIn" in cond && (row.isWalkIn ?? null) !== cond.isWalkIn) return false;
        return true;
      };
      const serveWhere = (rows: Row[]) =>
        prisma.customer.findMany.mockImplementation(async (args: any) =>
          rows.filter((r) => matches(r, args.where)).slice(0, args.take),
        );
      const walkIn: Row = { id: "walk-in", businessName: "Walk-in", isWalkIn: true, addresses: [] };

      it("a tenant whose only address-less customer is the system walk-in is READY", async () => {
        enable(true);
        serveWhere([
          walkIn,
          { id: "a", businessName: "Acme", isWalkIn: null, addresses: [addr()] },
          { id: "b", businessName: "Beta", isWalkIn: false, addresses: [addr()] },
        ]);
        expect(await service.getEnableReadiness(T)).toEqual({
          ready: true,
          truncated: false,
          customerCount: 2,
          customersWithoutAddress: 0,
          customersAmbiguousNoDefault: 0,
          addressesMissingStateCode: 0,
          addressesNeedingReview: 0,
          indeterminateCustomerCount: 0,
          businessStateMissing: false,
        });
      });

      it("a real customer without an address is still counted", async () => {
        enable(true);
        serveWhere([
          walkIn,
          { id: "real", businessName: "Real Co", isWalkIn: null, addresses: [] },
        ]);
        const r = await service.getEnableReadiness(T);
        expect(r).toMatchObject({
          ready: false,
          customerCount: 1,
          customersWithoutAddress: 1,
          indeterminateCustomerCount: 1,
        });
      });

      it("a customer NAMED 'Walk-in' that is not a system customer is still counted", async () => {
        enable(true);
        serveWhere([
          walkIn,
          { id: "lookalike", businessName: "Walk-in", isWalkIn: null, addresses: [] },
          { id: "lookalike-false", businessName: "Walk-in", isWalkIn: false, addresses: [] },
        ]);
        const r = await service.getEnableReadiness(T);
        expect(r).toMatchObject({
          ready: false,
          customerCount: 2,
          customersWithoutAddress: 2,
          indeterminateCustomerCount: 2,
        });
      });
    });

    it("an exact multiple of the page size costs one extra (empty) page, then stops", async () => {
      serveCustomers(
        Array.from({ length: ENABLE_READINESS_PAGE_SIZE }, (_, i) => customer(cid(i), [addr()])),
      );
      enable(true);
      const r = await service.getEnableReadiness(T);
      expect(r.customerCount).toBe(ENABLE_READINESS_PAGE_SIZE);
      expect(prisma.customer.findMany).toHaveBeenCalledTimes(2);
    });

    it("refuses a tenant other than the ambient one, reading nothing", async () => {
      mockAmbient("tenant-2");
      await expect(service.getEnableReadiness(T)).rejects.toThrow(InternalServerErrorException);
      expect(prisma.systemConfig.findMany).not.toHaveBeenCalled();
      expect(prisma.customer.findMany).not.toHaveBeenCalled();
    });

    it("a DB error propagates — readiness is never silently 'ready'", async () => {
      enable(true);
      prisma.customer.findMany.mockRejectedValue(new Error("db down"));
      await expect(service.getEnableReadiness(T)).rejects.toThrow("db down");
    });

    it("is read-only", async () => {
      enable(true);
      serveCustomers([customer("a", [addr()])]);
      await service.getEnableReadiness(T);
      for (const m of ["create", "update", "upsert", "delete", "updateMany", "deleteMany"]) {
        expect(prisma.customer[m]).not.toHaveBeenCalled();
        expect(prisma.systemConfig[m]).not.toHaveBeenCalled();
      }
    });

    it("assertReadyToEnable returns the readiness when ready", async () => {
      enable(true);
      serveCustomers([customer("a", [addr()])]);
      expect(await service.assertReadyToEnable(T)).toMatchObject({ ready: true, customerCount: 1 });
    });

    it("assertReadyToEnable throws a 409 SELLING_RESTRICTIONS_NOT_READY carrying the readiness", async () => {
      enable(true);
      serveCustomers([customer("a", [addr()]), customer("b", [])]);
      const err = await service.assertReadyToEnable(T).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
      expect(SELLING_RESTRICTIONS_NOT_READY).toBe("SELLING_RESTRICTIONS_NOT_READY");
      expect(err.getResponse()).toEqual({
        code: "SELLING_RESTRICTIONS_NOT_READY",
        readiness: {
          ready: false,
          truncated: false,
          customerCount: 2,
          customersWithoutAddress: 1,
          customersAmbiguousNoDefault: 0,
          addressesMissingStateCode: 0,
          addressesNeedingReview: 0,
          indeterminateCustomerCount: 1,
          businessStateMissing: false,
        },
      });
    });

    it("evaluate() NEVER consults readiness: an un-backfilled tenant is INDETERMINATE, not blocked by a readiness error", async () => {
      const probe = jest.spyOn(service, "getEnableReadiness");
      const assertProbe = jest.spyOn(service, "assertReadyToEnable");
      enable(true);
      withProduct();
      prisma.sellingRestriction.findMany.mockResolvedValue([dbRule()]);
      withAddresses([addr({ stateCode: null })]); // state not backfilled yet
      const res = await service.evaluate(T, "c1", [{ productId: "p1" }], { at: NOW });
      expect(res.outcome).toBe("INDETERMINATE");
      expect(probe).not.toHaveBeenCalled();
      expect(assertProbe).not.toHaveBeenCalled();
      expect(prisma.customer.findMany).not.toHaveBeenCalled();
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
    const args = (lines: Array<{ productId: string; qtyDelta?: number }>, over = {}) => ({
      tenantId: T,
      customerId: "c1",
      lines,
      // NB: specs are not type-checked, so the required `channel` is only enforced in source; most
      // fixtures here are `surface: "ALL"` (channel-agnostic) — a BUYER_PORTAL fixture must say so.
      channel: "STAFF" as const,
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
      await expect(service.assertLinesSellable(args(lines))).resolves.toBeUndefined();
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
      ).resolves.toBeUndefined();
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
      await expect(service.assertLinesSellable(args([line("p1")]))).resolves.toBeUndefined();
    });

    it("OFF resolves — and stays reachable: a checkable line still reaches the policy read", async () => {
      policyRows([]); // no row = OFF
      expect(await service.checkLinesSellable(args([line("p1")]))).toEqual({
        outcome: "OFF",
        reasons: [],
      });
      await expect(service.assertLinesSellable(args([line("p1", 4)]))).resolves.toBeUndefined();
      expect(prisma.sellingRestriction.findMany).not.toHaveBeenCalled(); // OFF evaluates nothing else
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
        await expect(service.assertLinesSellable(args(lines))).resolves.toBeUndefined();
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
