import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ProductFamiliesService } from "./product-families.service";
import { ACTOR, T, makeTx, product, row } from "./product-code-release.fake-tx";

/**
 * WS8 families API (SA-606): unit cases over the in-memory fake tx. The real-PG races live in product-families.db.spec.ts.
 */
function build(seed: Parameters<typeof makeTx>[0] = { products: [] }) {
  const tx = makeTx(seed);
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const gateway = { emitProductUpdated: jest.fn() };
  const prisma = {
    getTenantId: () => T,
    tenantTransaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    forTenant: () => tx,
  };
  const service = new ProductFamiliesService(prisma as never, gateway as never, audit as never);
  return { service, tx, audit, gateway };
}
const variant = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  pricePerUnit: "2.50",
  ...over,
});
const dto = (variants: unknown[], extra: Record<string, unknown> = {}) =>
  ({ family: { name: "Soda" }, variants, ...extra }) as never;
const bodyOf = async (p: Promise<unknown>) => {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(ConflictException);
  return (err as ConflictException).getResponse() as Record<string, any>;
};

describe("POST /products/families (createFamily)", () => {
  it("creates ONE FAMILY (non-sellable container) + its VARIANTS in one tx; one audit row, one catalog event", async () => {
    const { service, tx, audit, gateway } = build();
    const out = await service.createFamily(
      dto([variant("Cola", { sku: "S-COLA", barcode: "B1", unitsPerBox: 12 }), variant("Lime")]),
      ACTOR,
    );
    const fam = tx.products.find((p) => p.id === out.family.id) as Record<string, unknown>;
    expect(fam).toMatchObject({
      kind: "FAMILY",
      parentProductId: null,
      name: "Soda",
      isActive: true,
    });
    const kids = tx.products.filter(
      (p) => (p as Record<string, unknown>).parentProductId === out.family.id,
    );
    expect(kids).toHaveLength(2);
    expect(kids.every((k) => (k as Record<string, unknown>).kind === "VARIANT")).toBe(true);
    expect(kids[0]).toMatchObject({ name: "Cola", sku: "S-COLA", barcode: "B1", unitsPerBox: 12 });
    expect(tx.barcodes.length).toBeGreaterThan(0); // M1 level rows were synced for the barcode
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "product.family_created",
        userId: ACTOR,
        meta: { variantCount: 2 },
      }),
    );
    expect(gateway.emitProductUpdated).toHaveBeenCalledTimes(1);
  });

  it("money: prices go through roundMoney, costPrice through roundUnitCost; the family price is copied ONLY when asked", async () => {
    const a = build();
    await a.service.createFamily(
      dto([variant("A", { pricePerUnit: "1.005", costPrice: "2.12345" })], {
        family: { name: "F", pricePerUnit: "9.99" },
      }),
      ACTOR,
    );
    const va = a.tx.products.find(
      (p) => (p as Record<string, unknown>).kind === "VARIANT",
    ) as Record<string, unknown>;
    expect(va).toMatchObject({ pricePerUnit: "1.01", priceTier2: "1.01", standardCost: "2.1235" });

    const b = build();
    await b.service.createFamily(
      dto([variant("A", { pricePerUnit: "1.00" })], {
        family: { name: "F", pricePerUnit: "9.99" },
        copyFamilyPrice: true,
      }),
      ACTOR,
    );
    expect(
      b.tx.products.find((p) => (p as Record<string, unknown>).kind === "VARIANT"),
    ).toMatchObject({
      pricePerUnit: "9.99",
    });
  });

  it("0 variants and more than 200 variants are 400s that write nothing", async () => {
    const { service, tx } = build();
    await expect(service.createFamily(dto([]), ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createFamily(dto(Array.from({ length: 201 }, (_, i) => variant(`V${i}`))), ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.products).toHaveLength(0);
  });

  it("409 FAMILY_ROWS_CONFLICT lists EVERY conflict (in-grid, active code holders, the family name) and writes nothing", async () => {
    const { service, tx, audit } = build({
      products: [
        product({ id: "h1", name: "Taken Sku", sku: "S-TAKEN" }),
        product({ id: "h2", name: "Soda" }), // the family name
        product({ id: "h3", name: "Has Barcode", barcode: "B-TAKEN" }),
      ],
    });
    const body = await bodyOf(
      service.createFamily(
        dto([
          variant("A", { sku: "S-TAKEN" }),
          variant("B", { barcode: "B-TAKEN" }),
          variant("C", { sku: "DUP" }),
          variant("D", { sku: "DUP" }),
        ]),
        ACTOR,
      ),
    );
    expect(body.code).toBe("FAMILY_ROWS_CONFLICT");
    expect(body.rows).toEqual(
      expect.arrayContaining([
        { row: 2, field: "sku", value: "DUP", reason: "DUPLICATE_IN_REQUEST" },
        { row: 3, field: "sku", value: "DUP", reason: "DUPLICATE_IN_REQUEST" },
        { row: 0, field: "sku", value: "S-TAKEN", reason: "CODE_TAKEN", conflictProductId: "h1" },
        {
          row: 1,
          field: "barcode",
          value: "B-TAKEN",
          reason: "CODE_TAKEN",
          conflictProductId: "h3",
        },
        {
          row: "family",
          field: "name",
          value: "Soda",
          reason: "NAME_TAKEN",
          conflictProductId: "h2",
        },
      ]),
    );
    expect(body.rows).toHaveLength(5);
    expect(tx.products).toHaveLength(3); // nothing created
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("retired codes and an INACTIVE owner are free (SA-603): the create succeeds", async () => {
    const { service } = build({
      products: [
        product({ id: "old", name: "Old", isActive: false, sku: "S1" }),
        product({ id: "r", name: "R", retiredSku: "S2" }),
      ],
    });
    await expect(
      service.createFamily(dto([variant("A", { sku: "S1" }), variant("B", { sku: "S2" })]), ACTOR),
    ).resolves.toBeDefined();
  });

  it("lock order: the code locks and the name lock come BEFORE the first product write", async () => {
    const { service, tx } = build();
    await service.createFamily(dto([variant("A", { sku: "S1", barcode: "B1" })]), ACTOR);
    expect(tx.calls.indexOf("lock:code")).toBeGreaterThanOrEqual(0);
    expect(tx.calls.indexOf("lock:code")).toBeLessThan(tx.calls.indexOf("product.create"));
    expect(tx.calls.filter((c) => c === "lock:code").length).toBeGreaterThanOrEqual(2); // codes + the name lock
  });

  it("a P2002 that slips past the locks is re-attributed through the SAME check into the SAME 409", async () => {
    const { service, tx } = build();
    let n = 0;
    tx.product.create.mockImplementation(((args: { data: Record<string, unknown> }) => {
      n += 1;
      if (n === 2) {
        // a concurrent writer committed S-RACE between our check and our insert
        tx.products.push(product({ id: "racer", name: "Racer", sku: "S-RACE" }));
        throw new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "x",
        });
      }
      const created = { id: `c${n}`, tenantId: T, isActive: true, ...args.data };
      tx.products.push(created as never);
      return Promise.resolve(created);
    }) as never);
    const body = await bodyOf(service.createFamily(dto([variant("A", { sku: "S-RACE" })]), ACTOR));
    expect(body.rows).toEqual([
      { row: 0, field: "sku", value: "S-RACE", reason: "CODE_TAKEN", conflictProductId: "racer" },
    ]);
  });
});

describe("PATCH /products/:id/variants (updateVariants)", () => {
  const fam = () => ({ ...product({ id: "fam", name: "Soda" }), kind: "FAMILY" });
  const kid = (id: string, over: Record<string, unknown> = {}) =>
    ({
      ...product({ id, name: `Kid ${id}` }),
      kind: "VARIANT",
      parentProductId: "fam",
      ...over,
    }) as never;

  it("the id must be a FAMILY, and every updated/deactivated id a variant of THIS family (400)", async () => {
    const plain = build({ products: [product({ id: "fam", name: "Plain" })] });
    await expect(plain.service.updateVariants("fam", {}, ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const other = build({
      products: [fam(), kid("k1"), { ...kid("k2"), parentProductId: "other-fam" }],
    });
    await expect(
      other.service.updateVariants("fam", { deactivate: ["k1", "k2"] }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(other.tx.products.find((p) => p.id === "k1")!.isActive).toBe(true);
  });

  it("more than 200 rows in total is a 400", async () => {
    const { service } = build({ products: [fam()] });
    await expect(
      service.updateVariants(
        "fam",
        { add: Array.from({ length: 201 }, (_, i) => variant(`V${i}`)) as never },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("ALL-OR-NOTHING: one conflicting row rolls the whole request back (nothing deactivated, updated or added)", async () => {
    const { service, tx, audit } = build({
      products: [
        fam(),
        kid("k1", { sku: "K1" }),
        kid("k2"),
        product({ id: "x", name: "Outsider", sku: "TAKEN" }),
      ],
    });
    const body = await bodyOf(
      service.updateVariants(
        "fam",
        {
          deactivate: ["k1"],
          update: [{ id: "k2", pricePerUnit: "9" }],
          add: [variant("New", { sku: "TAKEN" })] as never,
        },
        ACTOR,
      ),
    );
    expect(body.rows).toEqual([
      { row: 0, field: "sku", value: "TAKEN", reason: "CODE_TAKEN", conflictProductId: "x" },
    ]);
    expect(tx.products.find((p) => p.id === "k1")!.isActive).toBe(true);
    expect(tx.products.filter((p) => (p as Record<string, unknown>).name === "New")).toHaveLength(
      0,
    );
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("deactivate releases the variant's codes BEFORE the isActive write, and a code it frees may be reused by an add in the same call", async () => {
    const { service, tx } = build({ products: [fam(), kid("k1", { sku: "K1", barcode: "BK" })] });
    await service.updateVariants(
      "fam",
      { deactivate: ["k1"], add: [variant("Replacement", { sku: "K1" })] as never },
      ACTOR,
    );
    expect(tx.products.find((p) => p.id === "k1")).toMatchObject({
      isActive: false,
      sku: null,
      retiredSku: "K1",
    });
    const added = tx.products.find(
      (p) => (p as Record<string, unknown>).name === "Replacement",
    ) as Record<string, unknown>;
    expect(added).toMatchObject({ sku: "K1", kind: "VARIANT", parentProductId: "fam" });
    const k1Updates = tx.calls.filter((c) => c === "product.update:k1");
    expect(k1Updates).toHaveLength(2); // the release write, then the isActive write
  });

  it("an update re-checks the new code/name against ACTIVE holders, excluding the variant itself; kind is never written", async () => {
    const { service, tx } = build({
      products: [fam(), kid("k1", { sku: "K1" }), kid("k2", { sku: "K2" })],
    });
    await expect(
      service.updateVariants("fam", { update: [{ id: "k1", sku: "K2" }] }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    await service.updateVariants(
      "fam",
      { update: [{ id: "k1", sku: "K1", pricePerUnit: "3" }] },
      ACTOR,
    );
    expect(tx.product.update.mock.calls.every(([a]: any[]) => !("kind" in a.data))).toBe(true);
  });
});

describe("GET /products/sku-available (skuAvailable)", () => {
  it("answers through the SAME check: free, taken (with the holder and the field), and excludeProductId", async () => {
    const { service } = build({
      products: [
        product({ id: "h1", name: "H", sku: "S1" }),
        product({ id: "h2", name: "H2", barcode: "B2" }),
      ],
    });
    await expect(service.skuAvailable("FREE")).resolves.toEqual({ available: true });
    await expect(service.skuAvailable("S1")).resolves.toEqual({
      available: false,
      takenBy: { productId: "h1", field: "sku" },
    });
    await expect(service.skuAvailable("B2")).resolves.toMatchObject({
      available: false,
      takenBy: { productId: "h2", field: "barcode" },
    });
    await expect(service.skuAvailable("S1", "h1")).resolves.toEqual({ available: true });
  });

  it("a level-row barcode is found (and is tenant-scoped)", async () => {
    const { service } = build({
      products: [
        product({ id: "lv", name: "LV" }),
        { ...product({ id: "f", name: "F", sku: "X9" }), tenantId: "other" },
      ],
      barcodes: [row("r1", "lv", "UNIT", "ROW1")],
    });
    await expect(service.skuAvailable("ROW1")).resolves.toMatchObject({
      available: false,
      takenBy: { productId: "lv" },
    });
    await expect(service.skuAvailable("X9")).resolves.toEqual({ available: true });
  });
});
