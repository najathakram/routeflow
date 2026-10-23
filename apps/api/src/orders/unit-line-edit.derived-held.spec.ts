import { normalizeDerivedBaseItems, type UnitEditContext } from "./unit-line-edit";

/**
 * Units P0b (SA-759r): the in-transaction pass of an order edit reads the held label off the LOCKED rows. A line the
 * pre-lock snapshot saw as a held Piece UNIT line (so the pre-lock pass left the item alone) that is a PACK line
 * under the lock must be rewritten to the pack's pieces there; otherwise it bills 2 x $6.67 = $13.34 against the
 * server's $13.33.
 */
describe("normalizeDerivedBaseItems - the in-tx pass reads the held line off the locked rows", () => {
  // a 3-pack at $20, a Case of 12 with no price of its own: the base Piece is derived ($20 / 3 = $6.67)
  const product = { id: "p1", unit: "Pack", unitsPerBox: 3, pricePerUnit: "20.00" };
  const ladder = [{ productId: "p1", label: "Case", factorToBase: 12, price: null }];
  const ctx = (heldLabel: string | null): UnitEditContext =>
    ({
      products: new Map([["p1", product]]),
      ladders: new Map([["p1", ladder]]),
      existingById: new Map([["li-1", { id: "li-1", productId: "p1", unitLabel: heldLabel }]]),
    }) as never;
  const db = {
    customer: { findFirst: jest.fn().mockResolvedValue({ pricingTier: 1 }) },
    customerPrice: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const staff = { role: "OPERATOR" };
  const order = { customerId: "c1" };
  const item = () => ({ id: "li-1", qty: 2, unitLabel: "Piece", unitPrice: 6.67 }) as any;

  it("pre-lock snapshot: held Piece unit line -> left alone; locked row: a pack line -> rewritten in-tx", async () => {
    const dto = { items: [item()] };
    const snapshot = ctx("Piece");
    await normalizeDerivedBaseItems(db, order, dto, snapshot, staff);
    expect(dto.items[0]).toMatchObject({ unitLabel: "Piece", unitPrice: 6.67, qty: 2 });

    const heldById = new Map([["li-1", { id: "li-1", productId: "p1", unitLabel: null }]]);
    await normalizeDerivedBaseItems(db, order, dto, snapshot, staff, heldById);
    const out = dto.items[0];
    expect(out.unitLabel).toBeNull();
    expect(out).toMatchObject({ boxes: 0, pieces: 2, qty: 2 });
    expect("unitPrice" in out).toBe(false);
  });

  it("still a held Piece unit line under the lock: left alone (own unit line, not a derived rewrite)", async () => {
    const dto = { items: [item()] };
    const heldById = new Map([["li-1", { id: "li-1", productId: "p1", unitLabel: "Piece" }]]);
    await normalizeDerivedBaseItems(db, order, dto, ctx("Piece"), staff, heldById);
    expect(dto.items[0]).toMatchObject({ unitLabel: "Piece", unitPrice: 6.67 });
  });

  it("a substitute does not inherit the old product's held label", async () => {
    const dto = { items: [{ ...item(), substituteProductId: "p1" }] };
    await normalizeDerivedBaseItems(db, order, dto, ctx("Piece"), staff);
    expect(dto.items[0].unitLabel).toBeNull();
  });
});
