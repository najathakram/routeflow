import { UserRole } from "@prisma/client";
import { getStockAvailability, MAX_STOCK_AVAILABILITY_IDS } from "./stock-availability";
import type { OversellPolicyReader } from "./oversell-policy";

/**
 * SA-1086 (LS-5..LS-8): the live-stock read the order screens call. It computes nothing of its own:
 * availability is `Product.currentStock` (pieces) and the verdict is `resolveOversellAllowed` with the
 * same source the save uses.
 */
const reader = (value: unknown): OversellPolicyReader => ({ read: jest.fn(async () => value) });
const products = (rows: Array<{ id: string; currentStock: unknown; kind?: string }>) => ({
  findMany: jest.fn(async ({ where }: any) =>
    rows
      .filter((r) => (where.id.in as string[]).includes(r.id))
      .filter((r) => (where.kind?.not ? (r.kind ?? "STANDARD") !== where.kind.not : true)),
  ),
});
const operator = { tenantId: "t1", role: UserRole.OPERATOR } as any;

describe("getStockAvailability", () => {
  it("returns Product.currentStock in PIECES (never cases) per requested product", async () => {
    const p = products([{ id: "p1", currentStock: 30 }]);
    const out = await getStockAvailability({
      productIds: ["p1"],
      user: operator,
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

  it("LS-8: a negative stock is reported as stored; the screen reads it as 0 left", async () => {
    const out = await getStockAvailability({
      productIds: ["p1"],
      user: operator,
      mode: "entry",
      products: products([{ id: "p1", currentStock: "-3" }]),
      oversellReader: reader("off"),
    });
    expect(out.items[0].availablePieces).toBe(-3);
  });

  it("omits unknown ids (another tenant's id is simply not found), dedupes, and caps the id list", async () => {
    const p = products([{ id: "p1", currentStock: 2 }]);
    const out = await getStockAvailability({
      productIds: ["p1", "p1", "nope"],
      user: operator,
      mode: "entry",
      products: p,
      oversellReader: reader("off"),
    });
    expect(out.items).toEqual([{ productId: "p1", availablePieces: 2 }]);
    const many = Array.from({ length: MAX_STOCK_AVAILABILITY_IDS + 5 }, (_, i) => `p${i}`);
    await getStockAvailability({
      productIds: many,
      user: operator,
      mode: "entry",
      products: p,
      oversellReader: reader("off"),
    });
    const lastCall = (p.findMany as jest.Mock).mock.calls.at(-1)![0];
    expect(lastCall.where.id.in).toHaveLength(MAX_STOCK_AVAILABILITY_IDS);
  });

  it("LS-7: a recipe product is not returned (its stock moves through its components), never a fake 0", async () => {
    const p = products([
      { id: "plain", currentStock: 5 },
      { id: "mix", currentStock: 0, kind: "RECIPE" },
    ]);
    const out = await getStockAvailability({
      productIds: ["plain", "mix"],
      user: operator,
      mode: "entry",
      products: p,
      oversellReader: reader("off"),
    });
    expect(out.items).toEqual([{ productId: "plain", availablePieces: 5 }]);
  });

  it("makes one product query per call, even for a full draft", async () => {
    const p = products([{ id: "p1", currentStock: 2 }]);
    await getStockAvailability({
      productIds: ["p1", "p2", "p3"],
      user: operator,
      mode: "entry",
      products: p,
      oversellReader: reader("off"),
    });
    expect(p.findMany).toHaveBeenCalledTimes(1);
  });

  it("an empty id list reads nothing and still answers the verdict", async () => {
    const p = products([]);
    const out = await getStockAvailability({
      productIds: [],
      user: operator,
      mode: "entry",
      products: p,
      oversellReader: reader("off"),
    });
    expect(p.findMany).not.toHaveBeenCalled();
    expect(out).toEqual({ allowOversell: true, items: [] });
  });
});
