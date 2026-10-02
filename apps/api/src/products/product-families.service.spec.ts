import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateFamilyDto, UpdateFamilyVariantsDto } from "./dto/family.dto";
import { ProductFamiliesService } from "./product-families.service";
import { ACTOR, T, makeTx, product, row } from "./product-code-release.fake-tx";

/**
 * WS8 families API (SA-606): unit cases over the in-memory fake tx. The real-PG races live in product-families.db.spec.ts.
 */
function build(seed: Parameters<typeof makeTx>[0] = { products: [] }, mode: "on" | "off" = "off") {
  const tx = makeTx(seed);
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const gateway = { emitProductUpdated: jest.fn() };
  const prisma = {
    getTenantId: () => T,
    tenantTransaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    forTenant: () => tx,
  };
  const service = new ProductFamiliesService(
    prisma as never,
    gateway as never,
    audit as never,
    {
      getEffectiveMode: jest.fn().mockResolvedValue(mode),
    } as never,
  );
  return { service, tx, audit, gateway };
}
const variant = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  pricePerUnit: "2.50",
  ...over,
});
const dto = (variants: unknown[], extra: Record<string, unknown> = {}) =>
  ({ family: { pricePerUnit: "1.00", name: "Soda" }, variants, ...extra }) as never;
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

  it("money: prices go through roundMoney, standardCost through roundUnitCost; the family price is copied ONLY when asked", async () => {
    const a = build();
    await a.service.createFamily(
      dto([variant("A", { pricePerUnit: "1.005", standardCost: "2.12345" })], {
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
        tx.products.splice(
          tx.products.findIndex((p) => p.id === "c1"),
          1,
        ); // the failed tx rolled the family back
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
      products: [fam(), kid("k1"), kid("k2", { parentProductId: "other-fam" })],
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

  it("Opus #2881 notes: out-of-range money is a 400 (incl. the ROUNDING overflow) and codes are stored trimmed", async () => {
    await expect(
      build().service.createFamily(dto([variant("A", { pricePerUnit: "99999999.999" })]), ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      build().service.createFamily(dto([variant("A", { standardCost: "999999.99999" })]), ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    const b = build();
    await b.service.createFamily(dto([variant("A", { sku: "  S-1  ", barcode: " 123 " })]), ACTOR);
    const kid = b.tx.products.find(
      (p) => (p as Record<string, unknown>).kind === "VARIANT",
    ) as Record<string, unknown>;
    expect(kid).toMatchObject({ sku: "S-1", barcode: "123" });
  });

  it("Opus #2881 B5 (authority off): a price edit moves only the tiers that EQUALLED the old price", async () => {
    const famRow = fam();
    const k1 = {
      ...(kid("k1") as Record<string, unknown>),
      pricePerUnit: "5.00",
      priceTier2: "5.00",
      priceTier3: "4.00", // deliberately different
      priceTier4: "5.00",
      priceTier5: "5.00",
    } as never;
    const off = build({ products: [famRow, k1] }, "off");
    await off.service.updateVariants("fam", { update: [{ id: "k1", pricePerUnit: "6" }] }, ACTOR);
    expect(off.tx.products.find((p) => p.id === "k1")).toMatchObject({
      pricePerUnit: "6.00",
      priceTier2: "6.00",
      priceTier3: "4.00",
      priceTier4: "6.00",
      priceTier5: "6.00",
    });
  });

  it("SA-606a: family standardCost is inherited by a variant that omits its own; an own cost wins; never averageCost", async () => {
    const a = build();
    await a.service.createFamily(
      dto([variant("A", {}), variant("B", { standardCost: "3.5" })], {
        family: { name: "F", pricePerUnit: "9.99", standardCost: "2.00005" },
      }),
      ACTOR,
    );
    const kids = a.tx.products.filter(
      (p) => (p as Record<string, unknown>).kind === "VARIANT",
    ) as Array<Record<string, unknown>>;
    expect(kids.find((p) => p.name === "A")).toMatchObject({ standardCost: "2.0001" });
    expect(kids.find((p) => p.name === "B")).toMatchObject({ standardCost: "3.5000" });
    expect(kids.every((p) => p.averageCost === undefined)).toBe(true);

    const c = build();
    await c.service.createFamily(
      dto([variant("E", { standardCost: "" })], {
        family: { name: "G", pricePerUnit: "9.99", standardCost: "4" },
      }),
      ACTOR,
    );
    expect(c.tx.products.find((p) => (p as Record<string, unknown>).name === "E")).toMatchObject({
      standardCost: "4.0000",
    });
  });

  it("M2 price authority: with mixed_packs ON a price EDIT is 409 FAMILY_PRICE_AUTHORITY and an added variant takes the FAMILY's price", async () => {
    const famRow = {
      ...fam(),
      pricePerUnit: "9.99",
      priceTier2: "9.50",
      priceTier3: "9.25",
      priceTier4: "9.00",
      priceTier5: "8.75",
    };
    const on = build({ products: [famRow, kid("k1")] }, "on");
    await expect(
      on.service.updateVariants("fam", { update: [{ id: "k1", pricePerUnit: "1" }] }, ACTOR),
    ).rejects.toMatchObject({
      response: { code: "FAMILY_PRICE_AUTHORITY", familyId: "fam" },
    });
    await on.service.updateVariants(
      "fam",
      { add: [variant("NewOne", { pricePerUnit: "1.00" })] as never },
      ACTOR,
    );
    expect(
      on.tx.products.find((p) => (p as Record<string, unknown>).name === "NewOne"),
    ).toMatchObject({
      pricePerUnit: "9.99",
      priceTier2: "9.50",
      priceTier3: "9.25",
      priceTier4: "9.00",
      priceTier5: "8.75",
    });
    // mode off: a price edit is an ordinary write
    const off = build({ products: [famRow, kid("k1")] }, "off");
    await expect(
      off.service.updateVariants("fam", { update: [{ id: "k1", pricePerUnit: "1" }] }, ACTOR),
    ).resolves.toBeDefined();
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

describe("family DTO bounds (Decimal(10,2) price <= 8 integer digits, Decimal(10,4) cost <= 6)", () => {
  const check = async (over: Record<string, unknown>) =>
    validate(
      plainToInstance(CreateFamilyDto, {
        family: { pricePerUnit: "1.00", name: " Soda " },
        variants: [{ name: " A ", pricePerUnit: "1.00", ...over }],
      }),
      { whitelist: true },
    );
  it("rejects an over-wide price or cost, accepts the boundary, and trims names", async () => {
    expect(await check({ standardCost: "1234567" })).not.toHaveLength(0); // 7 integer digits
    expect(await check({ pricePerUnit: "123456789" })).not.toHaveLength(0); // 9 integer digits
    expect(await check({ standardCost: "999999", pricePerUnit: "99999999" })).toHaveLength(0);
    expect(await check({ name: "   " })).not.toHaveLength(0); // trimmed to empty
    const dto = plainToInstance(CreateFamilyDto, {
      family: { pricePerUnit: "1.00", name: " Soda " },
      variants: [{ name: " A ", pricePerUnit: "1.00", sku: " S1 " }],
    });
    expect(dto.family.name).toBe("Soda");
    expect(dto.variants[0]).toMatchObject({ name: "A", sku: "S1" });
  });
});

describe("Tier 1 money: an explicit null is never a silent $0 (#2881 r3)", () => {
  const messages = async (cls: new () => object, plain: Record<string, unknown>) => {
    const errs = await validate(plainToInstance(cls, plain) as object, { whitelist: true });
    const flat = (e: (typeof errs)[number]): string[] => [
      ...Object.values(e.constraints ?? {}),
      ...(e.children ?? []).flatMap(flat),
    ];
    return errs.flatMap(flat);
  };
  it("PATCH update row: pricePerUnit null is a readable 400 (would write $0.00 tiers)", async () => {
    const m = await messages(UpdateFamilyVariantsDto, {
      update: [{ id: "k1", pricePerUnit: null }],
    });
    expect(m.join(" ")).toMatch(/pricePerUnit/);
  });
  it("PATCH update row: standardCost null is a readable 400 (would write a 0.0000 cost)", async () => {
    const m = await messages(UpdateFamilyVariantsDto, {
      update: [{ id: "k1", standardCost: null }],
    });
    expect(m.join(" ")).toMatch(/standardCost/);
  });
  it("omitting the field stays valid; a real value stays valid", async () => {
    expect(await messages(UpdateFamilyVariantsDto, { update: [{ id: "k1", name: "X" }] })).toEqual(
      [],
    );
    expect(
      await messages(UpdateFamilyVariantsDto, {
        update: [{ id: "k1", pricePerUnit: "2", standardCost: "1" }],
      }),
    ).toEqual([]);
  });
  it("create: a null family PRICE is refused; a null create-side COST means omitted (SA-606g)", async () => {
    expect(
      (
        await messages(CreateFamilyDto, {
          family: { name: "F", pricePerUnit: null },
          variants: [{ name: "A", pricePerUnit: "1" }],
        })
      ).length,
    ).toBeGreaterThan(0);
    for (const plain of [
      {
        family: { pricePerUnit: "1.00", name: "F", standardCost: null },
        variants: [{ name: "A", pricePerUnit: "1" }],
      },
      {
        family: { pricePerUnit: "1.00", name: "F" },
        variants: [{ name: "A", pricePerUnit: "1", standardCost: null }],
      },
    ]) {
      expect(await messages(CreateFamilyDto, plain)).toEqual([]);
    }
  });
  it("service level (a caller that bypasses the DTO): null price / cost on an update row is a 400 and nothing is written", async () => {
    const famRow = { ...product({ id: "fam", name: "Soda" }), kind: "FAMILY" };
    const k1 = {
      ...product({ id: "k1", name: "Kid k1" }),
      kind: "VARIANT",
      parentProductId: "fam",
      pricePerUnit: "5.00",
    } as never;
    for (const bad of [{ pricePerUnit: null }, { standardCost: null }]) {
      const h = build({ products: [famRow, k1] }, "off");
      await expect(
        h.service.updateVariants("fam", { update: [{ id: "k1", ...bad }] } as never, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(h.tx.calls.some((c) => c.startsWith("product.update"))).toBe(false);
    }
  });
  it("service level: create / add rows with a null or empty price, and an empty update price or cost, are 400s too", async () => {
    for (const bad of [{ pricePerUnit: null }, { pricePerUnit: "" }]) {
      await expect(
        build().service.createFamily(dto([variant("A", bad)]), ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    const famRow = { ...product({ id: "fam", name: "Soda" }), kind: "FAMILY" };
    const k1 = {
      ...product({ id: "k1", name: "Kid k1" }),
      kind: "VARIANT",
      parentProductId: "fam",
    } as never;
    for (const bad of [{ pricePerUnit: "" }, { standardCost: "" }]) {
      await expect(
        build({ products: [famRow, k1] }).service.updateVariants(
          "fam",
          { update: [{ id: "k1", ...bad }] } as never,
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      build({ products: [famRow, k1] }).service.updateVariants(
        "fam",
        { add: [{ name: "New", pricePerUnit: null }] } as never,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it("N2: a whitespace-only price or update cost is a 400 (trimmed first), never $0", async () => {
    await expect(
      build().service.createFamily(dto([variant("A", { pricePerUnit: "   " })]), ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    const famRow = { ...product({ id: "fam", name: "Soda" }), kind: "FAMILY" };
    const k1 = {
      ...product({ id: "k1", name: "Kid k1" }),
      kind: "VARIANT",
      parentProductId: "fam",
    } as never;
    for (const bad of [{ pricePerUnit: "  " }, { standardCost: " \t " }]) {
      await expect(
        build({ products: [famRow, k1] }).service.updateVariants(
          "fam",
          { update: [{ id: "k1", ...bad }] } as never,
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("N3: a null over HTTP gets a READABLE message (price is required / omit the field), not 'must be non-negative'", async () => {
    const msgs = async (cls: new () => object, plain: Record<string, unknown>) => {
      const errs = await validate(plainToInstance(cls, plain) as object, { whitelist: true });
      const flat = (e: (typeof errs)[number]): string[] => [
        ...Object.values(e.constraints ?? {}),
        ...(e.children ?? []).flatMap(flat),
      ];
      return errs.flatMap(flat).join(" | ");
    };
    expect(
      await msgs(CreateFamilyDto, {
        family: { pricePerUnit: "1.00", name: "F" },
        variants: [{ name: "A", pricePerUnit: null }],
      }),
    ).toMatch(/pricePerUnit is required/);
    expect(
      await msgs(UpdateFamilyVariantsDto, { update: [{ id: "k1", pricePerUnit: null }] }),
    ).toMatch(/omit the field/);
    expect(
      await msgs(UpdateFamilyVariantsDto, { update: [{ id: "k1", standardCost: null }] }),
    ).toMatch(/omit the field/);
    // a malformed (non-null) value keeps the amount message
    expect(
      await msgs(UpdateFamilyVariantsDto, { update: [{ id: "k1", pricePerUnit: "abc" }] }),
    ).toMatch(/non-negative/);
  });
});

describe("SA-606g: ONE create-side blank-cost rule (blankToUndefined), HTTP == service", () => {
  const BLANKS: unknown[] = [undefined, "", "  ", null];
  const errorsOf = async (cls: new () => object, plain: Record<string, unknown>) =>
    validate(plainToInstance(cls, plain) as object, { whitelist: true });
  const kidOf = (h: { tx: { products: unknown[] } }) =>
    h.tx.products.find((p) => (p as Record<string, unknown>).kind === "VARIANT") as Record<
      string,
      unknown
    >;
  const famOf = (h: { tx: { products: unknown[] } }) =>
    h.tx.products.find((p) => (p as Record<string, unknown>).kind === "FAMILY") as Record<
      string,
      unknown
    >;

  it.each(BLANKS.map((b) => [b]))(
    "variant cost %p on create: the DTO passes AND the service inherits the family cost (parity)",
    async (blank) => {
      const plain = {
        family: { pricePerUnit: "1.00", name: "F", standardCost: "3" },
        variants: [{ name: "A", pricePerUnit: "1", standardCost: blank }],
      };
      expect(await errorsOf(CreateFamilyDto, plain)).toEqual([]); // HTTP accepts it
      const viaHttp = build();
      await viaHttp.service.createFamily(plainToInstance(CreateFamilyDto, plain) as never, ACTOR);
      expect(kidOf(viaHttp)).toMatchObject({ standardCost: "3.0000" });
      const bypass = build(); // a caller that skips the DTO behaves identically
      await bypass.service.createFamily(plain as never, ACTOR);
      expect(kidOf(bypass)).toMatchObject({ standardCost: "3.0000" });
    },
  );

  it.each(BLANKS.map((b) => [b]))(
    "variant cost %p with NO family cost: stays NULL (never 0.0000)",
    async (blank) => {
      const plain = {
        family: { pricePerUnit: "1.00", name: "F" },
        variants: [{ name: "A", pricePerUnit: "1", standardCost: blank }],
      };
      expect(await errorsOf(CreateFamilyDto, plain)).toEqual([]);
      const h = build();
      await h.service.createFamily(plainToInstance(CreateFamilyDto, plain) as never, ACTOR);
      expect(kidOf(h).standardCost ?? null).toBeNull();
    },
  );

  it.each(BLANKS.map((b) => [b]))(
    "family cost %p: the DTO passes and the family row's cost is NULL (never 0.0000)",
    async (blank) => {
      const plain = {
        family: { pricePerUnit: "1.00", name: "F", standardCost: blank },
        variants: [{ name: "A", pricePerUnit: "1" }],
      };
      expect(await errorsOf(CreateFamilyDto, plain)).toEqual([]);
      const h = build();
      await h.service.createFamily(plainToInstance(CreateFamilyDto, plain) as never, ACTOR);
      expect(famOf(h).standardCost ?? null).toBeNull();
    },
  );

  it.each([[null], [""], ["  "]])(
    "STRICT: update-row cost %p and price %p are 400 in BOTH the DTO and the service",
    async (blank) => {
      for (const field of ["standardCost", "pricePerUnit"]) {
        const plain = { update: [{ id: "k1", [field]: blank }] };
        expect((await errorsOf(UpdateFamilyVariantsDto, plain)).length).toBeGreaterThan(0);
        const famRow = { ...product({ id: "fam", name: "Soda" }), kind: "FAMILY" };
        const k1 = {
          ...product({ id: "k1", name: "Kid k1" }),
          kind: "VARIANT",
          parentProductId: "fam",
        } as never;
        await expect(
          build({ products: [famRow, k1] }).service.updateVariants("fam", plain as never, ACTOR),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    },
  );

  it.each([[null], [""], ["  "]])(
    "STRICT: a create price %p is 400 in BOTH the DTO and the service",
    async (blank) => {
      const plain = {
        family: { pricePerUnit: "1.00", name: "F" },
        variants: [{ name: "A", pricePerUnit: blank }],
      };
      expect((await errorsOf(CreateFamilyDto, plain)).length).toBeGreaterThan(0);
      await expect(build().service.createFamily(plain as never, ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );
});

describe("#2881 delta: a non-string money value is a 400 everywhere, never an inherit or a 500", () => {
  const msgs = async (cls: new () => object, plain: Record<string, unknown>) => {
    const errs = await validate(plainToInstance(cls, plain) as object, { whitelist: true });
    const flat = (e: (typeof errs)[number]): string[] => [
      ...Object.values(e.constraints ?? {}),
      ...(e.children ?? []).flatMap(flat),
    ];
    return errs.flatMap(flat).join(" | ");
  };
  it("HTTP: a JSON NUMBER cost on a create row or on the family is refused (it must not silently inherit)", async () => {
    expect(
      (
        await msgs(CreateFamilyDto, {
          family: { pricePerUnit: "1.00", name: "F", standardCost: "3" },
          variants: [{ name: "A", pricePerUnit: "1", standardCost: 2.5 }],
        })
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await msgs(CreateFamilyDto, {
          family: { pricePerUnit: "1.00", name: "F", standardCost: 2.5 },
          variants: [{ name: "A", pricePerUnit: "1" }],
        })
      ).length,
    ).toBeGreaterThan(0);
  });
  it("service (bypassing the DTO): a numeric cost or price is a 400 BadRequest, not an inherit / TypeError", async () => {
    for (const plain of [
      {
        family: { pricePerUnit: "1.00", name: "F", standardCost: "3" },
        variants: [{ name: "A", pricePerUnit: "1", standardCost: 2.5 }],
      },
      {
        family: { pricePerUnit: "1.00", name: "F", standardCost: 2.5 },
        variants: [{ name: "A", pricePerUnit: "1" }],
      },
      { family: { pricePerUnit: "1.00", name: "F" }, variants: [{ name: "A", pricePerUnit: 5 }] },
    ]) {
      await expect(build().service.createFamily(plain as never, ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    const famRow = { ...product({ id: "fam", name: "Soda" }), kind: "FAMILY" };
    const k1 = {
      ...product({ id: "k1", name: "Kid k1" }),
      kind: "VARIANT",
      parentProductId: "fam",
    } as never;
    for (const add of [
      { name: "B", pricePerUnit: "1", standardCost: 2.5 },
      { name: "B", pricePerUnit: 5 },
      { name: "B", pricePerUnit: "1", standardCost: true },
      { name: "B", pricePerUnit: "abc" },
    ]) {
      await expect(
        build({ products: [famRow, k1] }).service.updateVariants(
          "fam",
          { add: [add] } as never,
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      build().service.createFamily(
        {
          family: { pricePerUnit: "1.00", name: "F" },
          variants: [{ name: "A", pricePerUnit: "1", standardCost: true }],
        } as never,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    for (const bad of [{ pricePerUnit: 5 }, { standardCost: 2.5 }]) {
      await expect(
        build({ products: [famRow, k1] }).service.updateVariants(
          "fam",
          { update: [{ id: "k1", ...bad }] } as never,
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
  it("a null FAMILY price says 'required' (HTTP and service), not 'omit the field' (meaningless on create)", async () => {
    expect(
      await msgs(CreateFamilyDto, {
        family: { name: "F", pricePerUnit: null },
        variants: [{ name: "A", pricePerUnit: "1" }],
      }),
    ).toMatch(/pricePerUnit is required/);
    const err = await build()
      .service.createFamily(
        {
          family: { name: "F", pricePerUnit: null },
          variants: [{ name: "A", pricePerUnit: "1" }],
        } as never,
        ACTOR,
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify(err.getResponse())).toMatch(/required/);
    expect(JSON.stringify(err.getResponse())).not.toMatch(/omit the field/);
  });
});

describe("SA-606i: the family price is REQUIRED on create (no implicit $0.00), HTTP == service", () => {
  const info = (extra: Record<string, unknown> = {}) => ({ name: "F", ...extra });
  const oneVariant = [{ name: "A", pricePerUnit: "1" }];
  const errs = async (plain: Record<string, unknown>) =>
    validate(plainToInstance(CreateFamilyDto, plain) as object, { whitelist: true });
  const flat = (e: Awaited<ReturnType<typeof errs>>[number]): string[] => [
    ...Object.values(e.constraints ?? {}),
    ...(e.children ?? []).flatMap(flat),
  ];

  it("a create with NO family price is a 400 over HTTP (readable 'required') and in the service", async () => {
    const plain = { family: info(), variants: oneVariant };
    const e = await errs(plain);
    expect(e.length).toBeGreaterThan(0);
    expect(e.flatMap(flat).join(" | ")).toMatch(/pricePerUnit is required/);
    await expect(build().service.createFamily(plain as never, ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("copyFamilyPrice WITHOUT a family price is a CODED 400 FAMILY_COPY_PRICE_REQUIRED and NOTHING is written", async () => {
    const h = build();
    const err = await h.service
      .createFamily({ family: info(), variants: oneVariant, copyFamilyPrice: true } as never, ACTOR)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: "FAMILY_COPY_PRICE_REQUIRED" });
    expect(String(err.getResponse().message)).toMatch(/family price/i);
    expect(h.tx.products).toHaveLength(0);
    expect(h.tx.calls).not.toContain("product.create");
  });

  it('copyFamilyPrice with an explicit "0" / "0.00" / "0.004" is the same coded 400, nothing written', async () => {
    for (const price of ["0", "0.00", "0.004"]) {
      const h = build();
      const err = await h.service
        .createFamily(
          {
            family: info({ pricePerUnit: price }),
            variants: oneVariant,
            copyFamilyPrice: true,
          } as never,
          ACTOR,
        )
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ code: "FAMILY_COPY_PRICE_REQUIRED" });
      expect(h.tx.products).toHaveLength(0);
    }
  });

  it("copyFamilyPrice with a price > 0 copies it to every variant, rounded via roundMoney", async () => {
    const h = build();
    await h.service.createFamily(
      {
        family: info({ pricePerUnit: "9.995" }),
        variants: oneVariant,
        copyFamilyPrice: true,
      } as never,
      ACTOR,
    );
    expect(
      h.tx.products.find((p) => (p as Record<string, unknown>).kind === "VARIANT"),
    ).toMatchObject({ pricePerUnit: "10.00" });
  });

  it('an explicit "0.00" is still allowed WITHOUT copyFamilyPrice (a deliberate free family)', async () => {
    const plain = { family: info({ pricePerUnit: "0.00" }), variants: oneVariant };
    expect(await errs(plain)).toEqual([]);
    const a = build();
    await a.service.createFamily(plain as never, ACTOR);
    expect(
      a.tx.products.find((p) => (p as Record<string, unknown>).kind === "FAMILY"),
    ).toMatchObject({ pricePerUnit: "0.00" });
  });

  it("money() has no implicit fallback: a missing / null / blank price anywhere is a 400, never $0.00", async () => {
    for (const bad of [undefined, null, "", "  "]) {
      await expect(
        build().service.createFamily(
          { family: info({ pricePerUnit: bad }), variants: oneVariant } as never,
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

const FORMULA_CODE = "TEXT_CELL_FORMULA_LEAD";
const codeOf = async (p: Promise<unknown>) => {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(BadRequestException);
  return ((err as BadRequestException).getResponse() as Record<string, unknown>).code;
};

describe("B964-2 (merged with master): a formula-led family / variant name is refused before any write (CHANGE-ONLY)", () => {
  it("createFamily refuses a formula-led family name and a formula-led variant name with TEXT_CELL_FORMULA_LEAD; nothing is created", async () => {
    for (const body of [
      { family: { pricePerUnit: "1.00", name: "=SUM(A1)" }, variants: [variant("Cola")] },
      { family: { pricePerUnit: "1.00", name: "Soda" }, variants: [variant("+cmd|' /C calc'!A0")] },
    ]) {
      const { service, tx, audit } = build();
      expect(await codeOf(service.createFamily(body as never, ACTOR))).toBe(FORMULA_CODE);
      expect(tx.products).toHaveLength(0);
      expect(audit.log).not.toHaveBeenCalled();
    }
  });

  const fam = { ...product({ id: "fam", name: "Soda" }), kind: "FAMILY" };
  const legacy = {
    ...product({ id: "k1", name: "=LEGACY()" }),
    variantName: "=LEGACY()",
    kind: "VARIANT",
    parentProductId: "fam",
  } as never;

  it("updateVariants refuses an ADDED formula-led variant (TEXT_CELL_FORMULA_LEAD); nothing is written", async () => {
    const added = build({ products: [fam, legacy] });
    expect(
      await codeOf(
        added.service.updateVariants("fam", { add: [variant("@HYPERLINK(1)")] as never }, ACTOR),
      ),
    ).toBe(FORMULA_CODE);
  });

  it("updateVariants refuses a RENAME to a formula-led name (TEXT_CELL_FORMULA_LEAD) and writes nothing", async () => {
    const renamed = build({ products: [fam, legacy] });
    expect(
      await codeOf(
        renamed.service.updateVariants(
          "fam",
          { update: [{ id: "k1", name: "-2+3" }] as never },
          ACTOR,
        ),
      ),
    ).toBe(FORMULA_CODE);
    expect(renamed.tx.products.find((p) => p.id === "k1")!.name).toBe("=LEGACY()");
  });

  it("an UNCHANGED legacy formula name sent along with a sku edit is NOT refused (change-only): the sku is written, the name is kept", async () => {
    const same = build({ products: [fam, legacy] });
    await same.service.updateVariants(
      "fam",
      { update: [{ id: "k1", name: "=LEGACY()", sku: "NEW-SKU" }] as never },
      ACTOR,
    );
    expect(same.tx.products.find((p) => p.id === "k1")).toMatchObject({
      name: "=LEGACY()",
      sku: "NEW-SKU",
    });
  });
});
