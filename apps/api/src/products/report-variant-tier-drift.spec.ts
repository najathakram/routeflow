/**
 * #2717 M2 tests 28-32 (SA-574 Q4, R-030a) — unit spec for `prisma/report-variant-tier-drift.ts`.
 * The report is COUNTS ONLY and read-only: how many variants price differently from their family
 * today (the number the owner reads before flipping a tenant to mixed_packs = on), plus the
 * CustomerPrice count SA-574 Q4 adds. Nothing in its output may identify a tenant, product or
 * customer.
 */
import {
  countVariantTierDrift,
  formatErrorForStderr,
  loadCounts,
  type DriftCustomerPrice,
  type DriftProduct,
} from "../../prisma/report-variant-tier-drift";

const ladder = (
  list: string,
  t2 = "0",
  t3 = "0",
  t4 = "0",
  t5 = "0",
): Pick<
  DriftProduct,
  "pricePerUnit" | "priceTier2" | "priceTier3" | "priceTier4" | "priceTier5"
> => ({
  pricePerUnit: list,
  priceTier2: t2,
  priceTier3: t3,
  priceTier4: t4,
  priceTier5: t5,
});

const product = (
  id: string,
  parentProductId: string | null,
  prices: ReturnType<typeof ladder>,
  over: Partial<DriftProduct> = {},
): DriftProduct => ({
  id,
  tenantId: "t1",
  parentProductId,
  isActive: true,
  unitsPerBox: 12,
  ...prices,
  ...over,
});

/** Two families, five variants (test 30). */
const FIXTURE: DriftProduct[] = [
  product("fam-secret-1", null, ladder("10.00", "9.50", "9.00", "0", "8.00")),
  product("var-1a", "fam-secret-1", ladder("10.00", "9.50", "9.00", "0", "8.00")),
  // raw 0 on the family's tier 4 vs an explicit tier at the list price: EQUAL effective ladders
  product("var-1b", "fam-secret-1", ladder("10.00", "9.50", "9.00", "10.00", "8.00")),
  product("var-1c", "fam-secret-1", ladder("10.00", "9.50", "8.50", "0", "8.00")),
  product("fam-secret-2", null, ladder("1.5", "1.5", "1.5", "1.5", "1.5")),
  // "1.50" vs "1.5": equal
  product("var-2a", "fam-secret-2", ladder("1.50", "1.50", "1.50", "1.50", "1.50")),
  product("var-2b", "fam-secret-2", ladder("1.50", "1.40", "1.50", "1.50", "1.50"), {
    isActive: false,
    unitsPerBox: 24,
  }),
  // a standalone product and a family with no variants are never counted
  product("standalone", null, ladder("3.00")),
];

const cp = (
  customerId: string,
  productId: string,
  pricingTier: number | null,
): DriftCustomerPrice => ({
  tenantId: "t1",
  customerId,
  productId,
  pricingTier,
});

describe("countVariantTierDrift (tests 28, 30, 31)", () => {
  it("30: counts the exact fixture — 2 families, 5 variants", () => {
    expect(countVariantTierDrift(FIXTURE)).toEqual({
      variantsWithTierDiff: 2,
      familiesWithTierDiff: 2,
      variantsWithPackSizeDiff: 1,
      inactiveVariantsWithTierDiff: 1,
      customersWithCustomerPriceTierDiff: 0,
    });
  });

  it("28: compares EFFECTIVE tiers — a raw 0 vs an explicit list-price tier is equal", () => {
    const rows = [
      product("f", null, ladder("10.00", "0", "0", "0", "0")),
      product("v", "f", ladder("10.00", "10.00", "10.00", "10.00", "10.00")),
    ];
    expect(countVariantTierDrift(rows).variantsWithTierDiff).toBe(0);
  });

  it("28: decimal strings, numbers and Decimal-likes compare by value", () => {
    const rows = [
      product("f", null, ladder("1.5", "1.5", "1.5", "1.5", "1.5")),
      product("v", "f", {
        pricePerUnit: 1.5 as any,
        priceTier2: { toString: () => "1.50" } as any,
        priceTier3: "1.50",
        priceTier4: "1.5",
        priceTier5: "1.500",
      }),
    ];
    expect(countVariantTierDrift(rows).variantsWithTierDiff).toBe(0);
  });

  it("28: a half-cent difference below roundMoney is not a tier diff, a full cent is", () => {
    const base = product("f", null, ladder("10.00"));
    expect(
      countVariantTierDrift([base, product("v", "f", ladder("10.004"))]).variantsWithTierDiff,
    ).toBe(0);
    expect(
      countVariantTierDrift([base, product("v", "f", ladder("10.01"))]).variantsWithTierDiff,
    ).toBe(1);
  });

  it("28: a family in another tenant never compares with this tenant's variants", () => {
    const rows = [
      product("f", null, ladder("10.00"), { tenantId: "t1" }),
      product("v", "f", ladder("99.00"), { tenantId: "t2" }),
    ];
    expect(countVariantTierDrift(rows).variantsWithTierDiff).toBe(0);
  });

  it("31: a customer with different CustomerPrice tiers on two variants of one family counts once", () => {
    const prices = [
      cp("cust-a", "var-1a", 2),
      cp("cust-a", "var-1b", 3),
      cp("cust-a", "var-1c", 3),
    ];
    expect(countVariantTierDrift(FIXTURE, prices).customersWithCustomerPriceTierDiff).toBe(1);
  });

  it("31: the same tier on both variants, a null tier, or tiers on different families count 0", () => {
    const prices = [
      cp("same", "var-1a", 2),
      cp("same", "var-1b", 2),
      cp("null-tier", "var-1a", 2),
      cp("null-tier", "var-1b", null),
      cp("across", "var-1a", 2),
      cp("across", "var-2a", 3),
      cp("on-family", "fam-secret-1", 2),
      cp("on-family", "var-1a", 3),
    ];
    expect(countVariantTierDrift(FIXTURE, prices).customersWithCustomerPriceTierDiff).toBe(0);
  });
});

describe("report output identifies nothing (test 32)", () => {
  it("the counts JSON holds no fixture id, tenant, or customer id", () => {
    const json = JSON.stringify(
      countVariantTierDrift(FIXTURE, [
        cp("cust-secret", "var-1a", 2),
        cp("cust-secret", "var-1b", 3),
      ]),
    );
    for (const secret of ["fam-secret", "var-1", "var-2", "standalone", "cust-secret", "t1"]) {
      expect(json).not.toContain(secret);
    }
    expect(Object.keys(JSON.parse(json)).sort()).toEqual([
      "customersWithCustomerPriceTierDiff",
      "familiesWithTierDiff",
      "inactiveVariantsWithTierDiff",
      "variantsWithPackSizeDiff",
      "variantsWithTierDiff",
    ]);
    for (const value of Object.values(JSON.parse(json))) expect(typeof value).toBe("number");
  });

  function mockTx() {
    return {
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      tenant: { findUnique: jest.fn() },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      customerPrice: { findMany: jest.fn().mockResolvedValue([]) },
    };
  }

  it("an unknown --tenant refusal never echoes the slug", async () => {
    const tx = mockTx();
    tx.tenant.findUnique.mockResolvedValue(null);
    const prisma = { $transaction: jest.fn((fn: any) => fn(tx)) } as any;
    const err = await loadCounts(prisma, "acme-live-secret-slug").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("acme-live-secret-slug");
  });

  it("runs in ONE transaction and sets READ ONLY before any read", async () => {
    const tx = mockTx();
    tx.tenant.findUnique.mockResolvedValue({ id: "t1" });
    const prisma = { $transaction: jest.fn((fn: any) => fn(tx)) } as any;
    await loadCounts(prisma, "test");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const readOnly = tx.$executeRaw.mock.invocationCallOrder[0];
    const firstRead = Math.min(
      tx.tenant.findUnique.mock.invocationCallOrder[0] ?? Infinity,
      ...tx.product.findMany.mock.invocationCallOrder,
      ...tx.customerPrice.findMany.mock.invocationCallOrder,
    );
    expect(readOnly).toBeLessThan(firstRead);
  });

  it("scopes every read to the tenant id when a tenant is named", async () => {
    const tx = mockTx();
    tx.tenant.findUnique.mockResolvedValue({ id: "tenant-id-1" });
    const prisma = { $transaction: jest.fn((fn: any) => fn(tx)) } as any;
    await loadCounts(prisma, "test");
    expect(tx.product.findMany.mock.calls[0][0].where).toEqual({ tenantId: "tenant-id-1" });
    expect(tx.customerPrice.findMany.mock.calls[0][0].where).toEqual({ tenantId: "tenant-id-1" });
  });

  it("stderr formatting prints only the error name and code, never the message", () => {
    const err = Object.assign(new Error("tenant acme-live row 42"), { code: "P2002" });
    expect(formatErrorForStderr(err)).toBe("Error P2002");
  });
});
