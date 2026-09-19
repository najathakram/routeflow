import { InternalServerErrorException, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { createMockPrisma } from "../testing/prisma-mock";
import {
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
});
