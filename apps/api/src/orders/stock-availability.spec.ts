import { UserRole } from "@prisma/client";
import { getStockAvailability, MAX_STOCK_AVAILABILITY_IDS } from "./stock-availability";
import type { OversellPolicyReader } from "./oversell-policy";

const reader = (value: unknown): OversellPolicyReader => ({ read: jest.fn(async () => value) });
const products = (rows: Array<{ id: string; currentStock: unknown }>) => ({
  findMany: jest.fn(async ({ where }: any) =>
    rows.filter((r) => (where.id.in as string[]).includes(r.id)),
  ),
});

describe("getStockAvailability", () => {
  it("returns Product.currentStock in PIECES (never cases) per requested product", async () => {
    const p = products([{ id: "p1", currentStock: 30 }]);
    const out = await getStockAvailability({
      productIds: ["p1"],
      user: { tenantId: "t1", role: UserRole.OPERATOR } as any,
      mode: "entry",
      products: p,
      oversellReader: reader("off"),
    });
    expect(out.items).toEqual([{ productId: "p1", availablePieces: 30 }]);
  });

  it("allowOversell comes from resolveOversellAllowed: staff true, SUPER_ADMIN false on create", async () => {
    const run = (role: UserRole) =>
      getStockAvailability({
        productIds: ["p1"],
        user: { tenantId: "t1", role } as any,
        mode: "entry",
        products: products([{ id: "p1", currentStock: 1 }]),
        oversellReader: reader("off"),
      });
    expect((await run(UserRole.OPERATOR)).allowOversell).toBe(true);
    expect((await run(UserRole.TENANT_ADMIN)).allowOversell).toBe(true);
    expect((await run(UserRole.SUPER_ADMIN)).allowOversell).toBe(false);
  });

  it('mode "edit" uses the edit source (SUPER_ADMIN may oversell on edit, as settleStockForEdit allows)', async () => {
    const out = await getStockAvailability({
      productIds: ["p1"],
      user: { tenantId: "t1", role: UserRole.SUPER_ADMIN } as any,
      mode: "edit",
      products: products([{ id: "p1", currentStock: 1 }]),
      oversellReader: reader("off"),
    });
    expect(out.allowOversell).toBe(true);
  });

  it("a negative or non-numeric stock is reported as-is numerically (no clamping to a fake 0 for unknown)", async () => {
    const out = await getStockAvailability({
      productIds: ["p1"],
      user: { tenantId: "t1", role: UserRole.OPERATOR } as any,
      mode: "entry",
      products: products([{ id: "p1", currentStock: "-4.5" }]),
      oversellReader: reader("off"),
    });
    expect(out.items[0].availablePieces).toBe(-4.5);
  });

  it("omits unknown ids, dedupes, and caps the id list", async () => {
    const p = products([{ id: "p1", currentStock: 2 }]);
    const out = await getStockAvailability({
      productIds: ["p1", "p1", "nope"],
      user: { tenantId: "t1", role: UserRole.OPERATOR } as any,
      mode: "entry",
      products: p,
      oversellReader: reader("off"),
    });
    expect(out.items).toEqual([{ productId: "p1", availablePieces: 2 }]);
    const many = Array.from({ length: MAX_STOCK_AVAILABILITY_IDS + 5 }, (_, i) => `p${i}`);
    await getStockAvailability({
      productIds: many,
      user: { tenantId: "t1", role: UserRole.OPERATOR } as any,
      mode: "entry",
      products: p,
      oversellReader: reader("off"),
    });
    const lastCall = (p.findMany as jest.Mock).mock.calls.at(-1)![0];
    expect(lastCall.where.id.in).toHaveLength(MAX_STOCK_AVAILABILITY_IDS);
  });
});
