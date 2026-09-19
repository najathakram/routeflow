import { ConflictException, InternalServerErrorException, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { activeRuleWhere } from "./selling-restrictions.core";
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
        expect(c.where).toEqual({ tenantId: T, deletedAt: null });
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
});
