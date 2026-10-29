/**
 * SA-1027 - the catalog-copy script's core against a real Postgres (throwaway `qa-*` tenants, DB lane
 * `npm run local:test:db`: its own fresh database). The REAL script-only module (`CatalogCopyModule`) is built, so the
 * writes go through the app's own `ProductsService` / `ProductFamiliesService` / `ProductUnitsService` / `uploadImage`.
 *
 * Source -> target round-trip: a family, a ladder, a tiered price, a same-SKU skip, a no-SKU name skip, a pack-only
 * target, photos, codes already used at the target, regulated products, a recipe, an inactive product.
 * Placeholders only: no tenant name, slug or product of a live business appears here.
 */
import "reflect-metadata";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { ProductsService } from "../products/products.service";
import { CatalogCopyModule } from "./catalog-copy.module";
import { CatalogCopyService } from "./catalog-copy.service";
import { exitCodeFor } from "./catalog-copy.runner";
import { CopyRefusal } from "./catalog-copy.guard";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const slug = (label: string) =>
  assertTestTenant(`qa-cc-${RUN}-${label}`, "catalog-copy.db.spec.ts");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describeDb("SA-1027 catalog copy - real Postgres", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: CatalogCopyService;
  let uploadDir: string;
  const ids: Record<string, string> = {};
  const src = slug("src");

  const tenant = async (label: string) => {
    const t = await prisma.tenant.create({
      data: { slug: slug(label), name: `Acme ${label}`, status: "ACTIVE" } as never,
    });
    ids[label] = t.id;
    return t;
  };
  const product = (tenantId: string, data: Record<string, unknown>) =>
    prisma.product.create({
      data: { tenantId, unit: "box", pricePerUnit: "5.00", ...data } as never,
    });
  const grant = (tenantId: string, effect: "GRANT" | "DENY", featureKey = "flag.units_v1") =>
    prisma.tenantFeatureOverride.create({
      data: {
        tenantId,
        featureKey,
        effect,
        reason: "catalog-copy db spec",
      } as never,
    });
  const args = (target: string, extra: Record<string, unknown> = {}) => ({
    source: src,
    target,
    apply: false,
    ...extra,
  });
  const activeOf = (tenantId: string) =>
    prisma.product.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } });

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-copy-spec-"));
    process.env.UPLOAD_DIR = uploadDir;
    process.env.JWT_SECRET = "test-only-catalog-copy-db-spec-secret-0123456789abcdef";
    process.env.JWT_REFRESH_SECRET = "test-only-catalog-copy-db-spec-refresh-0123456789abcdef";
    moduleRef = await Test.createTestingModule({ imports: [CatalogCopyModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(CatalogCopyService);

    const s = await prisma.tenant.create({
      data: { slug: src, name: "Acme source", status: "ACTIVE" } as never,
    });
    ids.src = s.id;
    const photo = (productId: string, n: number) => {
      const key = `products/${productId}/seed-${n}.png`;
      fs.mkdirSync(path.dirname(path.join(uploadDir, key)), { recursive: true });
      fs.writeFileSync(path.join(uploadDir, key), PNG);
      return key;
    };

    // Alpha: boxed, tiered, costs and stock set (never copied), unit columns no writer takes, 2 photos, a ladder.
    const alpha = await product(s.id, {
      name: "Alpha",
      sku: "S-1",
      barcode: "B-ALPHA",
      unitsPerBox: 12,
      priceTier2: "9.50",
      category: "Snacks",
      msrp: "1.25",
      averageCost: "3.1000",
      standardCost: "2.0000",
      currentStock: "50",
      packLabel: "Case",
      orderUnitRef: "base",
      familyPriceOverride: true,
    });
    await prisma.product.update({
      where: { id: alpha.id },
      data: { imageKeys: [photo(alpha.id, 1), photo(alpha.id, 2)] },
    });
    const pair = await prisma.productUnit.create({
      data: { tenantId: s.id, productId: alpha.id, label: "Pair", factorToBase: 2, sortOrder: 0 },
    });
    // ProductTierUnit is LISTED by the dry run, never copied (SA-1027 spec b17f0ed7)
    await prisma.productTierUnit.create({
      data: { tenantId: s.id, productId: alpha.id, tier: 2, orderUnitRef: "base" },
    });
    await prisma.productUnit.create({
      data: {
        tenantId: s.id,
        productId: alpha.id,
        label: "Half case",
        factorToBase: 6,
        price: "4.00",
        parentUnitId: pair.id,
        perParent: 3,
      },
    });
    await product(s.id, { name: "Bravo", sku: "S-2", unitSku: "U-2" }); // target holds U-2 as a sku: skipped
    await product(s.id, { name: "Nameless" }); // no SKU, target holds the active name: skipped
    await product(s.id, { name: "Charlie", sku: "S-3", barcode: "TAKEN-1" }); // barcode used at the target: dropped
    await product(s.id, { name: "Delta", sku: "S-4", barcode: "B-NEW", unitsPerBox: 6 }); // fresh barcode copies
    await product(s.id, { name: "Echo", sku: "S-5", isActive: false }); // inactive: left out
    await product(s.id, { name: "Lone Regulated", sku: "S-6", regItemType: "CIGARETTE" }); // regulated: left out
    const famA = await product(s.id, { name: "Fam A", unit: "each", kind: "FAMILY" });
    await product(s.id, {
      name: "A1",
      variantName: "A1",
      sku: "FA-1",
      kind: "VARIANT",
      parentProductId: famA.id,
      barcode: "B-FA1",
    });
    await product(s.id, {
      name: "A2",
      variantName: "A2",
      sku: "FA-2",
      kind: "VARIANT",
      parentProductId: famA.id,
    });
    const famB = await product(s.id, { name: "Fam B", unit: "each", kind: "FAMILY" });
    await product(s.id, {
      name: "B1",
      variantName: "B1",
      sku: "FB-1",
      kind: "VARIANT",
      parentProductId: famB.id,
      isTobacco: true, // one regulated member: the whole family is left out
    });
    await product(s.id, {
      name: "B2",
      variantName: "B2",
      sku: "FB-2",
      kind: "VARIANT",
      parentProductId: famB.id,
    });
    const famC = await product(s.id, { name: "Fam C", unit: "each", kind: "FAMILY" }); // name taken at the target
    await product(s.id, {
      name: "C1",
      variantName: "C1",
      sku: "FC-1",
      kind: "VARIANT",
      parentProductId: famC.id,
    });
  }, 120000);

  afterAll(async () => {
    await moduleRef?.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  /** A target with the holders the source collides with. */
  const withHolders = async (label: string) => {
    const t = await tenant(label);
    await product(t.id, { name: "Target Bravo Holder", sku: "T-1", unitSku: "S-2" });
    await product(t.id, { name: "Nameless" });
    await product(t.id, { name: "Target Taken", sku: "T-2", barcode: "TAKEN-1" });
    await product(t.id, { name: "Fam C" });
    return t;
  };

  it("C-R1: --apply on a non-test target without the override is refused before any read; nothing is written", async () => {
    const t = await withHolders("r1");
    const before = await prisma.product.count({ where: { tenantId: t.id } });
    await expect(service.run(args("acme-shop", { apply: true }))).rejects.toBeInstanceOf(
      CopyRefusal,
    );
    expect(await prisma.product.count({ where: { tenantId: t.id } })).toBe(before);
  });

  describe("dry run, then apply on a throwaway target (no units_v1)", () => {
    let target: { id: string; slug: string };

    beforeAll(async () => {
      target = await withHolders("t1");
      await grant(target.id, "DENY"); // pack-only: the ladder writer sits behind flag.units_v1
    }, 60000);

    it("the dry run reports and writes nothing", async () => {
      const before = await prisma.product.count({ where: { tenantId: target.id } });
      const r = await service.run(args(target.slug));
      expect(r.mode).toBe("dry-run");
      expect(await prisma.product.count({ where: { tenantId: target.id } })).toBe(before);
      expect(r.skippedBySku).toEqual(["S-2"]); // C-G1: the target's unitSku
      expect(r.skippedByName).toBe(2); // the no-SKU product, and Fam C (name taken)
      expect(r.regulated).toBe(1 + 3); // Lone Regulated + Fam B (container, B1, B2): the family left out whole (C-G10)
      expect(r.inactiveLeftOut).toBe(1);
      expect(r.inactiveLeft).toEqual(["S-5"]); // the dry run NAMES what it leaves out
      expect(r.recipesLeftOut).toEqual([]); // the recipe cases have their own source (C-G16)
      expect(r.packOnly).toEqual(["S-1"]); // C-G3
      expect(r.codesDropped).toEqual([{ sku: "S-3", kind: "barcode", code: "TAKEN-1" }]); // C-G11
      expect(r.photos).toBe(2);
      // C-G14: the dry run lists, per column, what the target will not carry
      expect(r.differs.packLabel).toEqual(["S-1"]);
      expect(r.differs.orderUnitRef).toEqual(["S-1"]);
      expect(r.differs.familyPriceOverride).toEqual(["S-1"]);
      expect(r.differs.msrp).toEqual(["S-1"]); // the target holds no flag.msrp: create would refuse it
      expect(r.differs.tierUnits).toEqual(["S-1"]);
      expect(r.tierUnitRows).toBe(1); // listed, not copied: a non-zero live count goes to the owner
      expect(r.newUnits).toEqual([]); // no units_v1 at the target: no ladder is written, so no unit name is made
    });

    let applied: Awaited<ReturnType<CatalogCopyService["run"]>>;

    it("apply creates the products through the service: columns, no costs or stock, no unit columns (C-G7, C-G13, C-G14)", async () => {
      applied = await service.run(args(target.slug, { apply: true }));
      expect(applied.errors).toEqual([]);
      const rows = await activeOf(target.id);
      const byName = new Map(rows.map((p) => [p.name, p]));
      const alpha = byName.get("Alpha")!;
      expect(alpha).toMatchObject({
        sku: "S-1",
        barcode: "B-ALPHA",
        unit: "box",
        unitsPerBox: 12,
        category: "Snacks",
      });
      expect(Number(alpha.pricePerUnit)).toBe(5);
      expect(Number(alpha.priceTier2)).toBe(9.5);
      expect(alpha.msrp).toBeNull(); // the target does not hold flag.msrp (listed by the dry run)
      // never copied: costs, stock; columns no writer takes keep the target's defaults
      expect(alpha.averageCost).toBeNull();
      expect(alpha.standardCost).toBeNull();
      expect(Number(alpha.currentStock)).toBe(0);
      expect(alpha.packLabel).toBeNull();
      expect(alpha.orderUnitRef).toBe("pack");
      expect(alpha.familyPriceOverride).toBe(false);
      expect(alpha.isTobacco).toBe(false);
      expect(await prisma.customerPrice.count({ where: { tenantId: target.id } })).toBe(0);
    });

    it("C-G11/C-G12: the used barcode is dropped, the fresh one copies with its mirror rows", async () => {
      const rows = await activeOf(target.id);
      expect(rows.find((p) => p.name === "Charlie")).toMatchObject({ sku: "S-3", barcode: null });
      expect(rows.find((p) => p.name === "Delta")).toMatchObject({ barcode: "B-NEW" });
      const levels = await prisma.productBarcode.findMany({
        where: { tenantId: target.id, code: "B-NEW" },
      });
      expect(levels.length).toBeGreaterThan(0);
    });

    it("skips and leaves out: same-SKU / name / inactive / recipe / regulated families have 0 target rows (C-G2, C-G10, C-G15)", async () => {
      const names = (await activeOf(target.id)).map((p) => p.name);
      expect(names).not.toContain("Bravo");
      expect(names).not.toContain("Echo");
      expect(names).not.toContain("Recipe One");
      expect(names).not.toContain("Lone Regulated");
      expect(names).not.toEqual(expect.arrayContaining(["B1", "B2"]));
      expect(names).not.toContain("C1");
      expect(await prisma.trackedCategory.count({ where: { tenantId: target.id } })).toBe(0);
    });

    it("the family is a FAMILY container with VARIANT rows, each kind set by its own writer (C-G15)", async () => {
      const rows = await activeOf(target.id);
      const fam = rows.find((p) => p.name === "Fam A")!;
      expect(fam.kind).toBe("FAMILY");
      const variants = rows.filter((p) => p.parentProductId === fam.id);
      expect(variants.map((v) => v.name).sort()).toEqual(["A1", "A2"]);
      expect(variants.every((v) => v.kind === "VARIANT")).toBe(true);
      expect(variants.find((v) => v.name === "A1")!.barcode).toBe("B-FA1");
    });

    it("C-G3: a ladder source product is created pack-only when the target lacks units_v1", async () => {
      const alpha = (await activeOf(target.id)).find((p) => p.name === "Alpha")!;
      expect(await prisma.productUnit.count({ where: { productId: alpha.id } })).toBe(0);
    });

    it("C-G4: each photo is a new object under the target product's own prefix; the source is unchanged", async () => {
      const alpha = (await activeOf(target.id)).find((p) => p.name === "Alpha")!;
      expect(alpha.imageKeys).toHaveLength(2);
      for (const key of alpha.imageKeys) {
        expect(key.startsWith(`products/${alpha.id}/`)).toBe(true);
        expect(fs.existsSync(path.join(uploadDir, key))).toBe(true);
      }
      const source = await prisma.product.findFirst({ where: { tenantId: ids.src, sku: "S-1" } });
      expect(source!.imageKeys.every((k) => k.startsWith(`products/${source!.id}/`))).toBe(true);
      for (const k of source!.imageKeys) expect(fs.existsSync(path.join(uploadDir, k))).toBe(true);
    });

    it("C-G5: a second apply creates nothing", async () => {
      const count = await prisma.product.count({ where: { tenantId: target.id } });
      const again = await service.run(args(target.slug, { apply: true }));
      expect(again.created).toBe(0);
      expect(again.photosCopied).toBe(0);
      expect(await prisma.product.count({ where: { tenantId: target.id } })).toBe(count);
    });

    it("C-G6: --resume touches only products the manifest says this run created", async () => {
      const alpha = (await activeOf(target.id)).find((p) => p.name === "Alpha")!;
      const holder = (await activeOf(target.id)).find((p) => p.name === "Target Bravo Holder")!;
      const manifest = {
        version: 1 as const,
        createdAt: new Date().toISOString(),
        source: ids.src,
        target: target.id,
        entries: [
          {
            sourceId: "x",
            targetId: alpha.id,
            sku: "S-1",
            photos: alpha.imageKeys.map((k) => ({ sourceKey: k, status: "copied" as const })),
          },
        ],
      };
      const done = await service.resumePhotos(manifest, args(target.slug, { apply: true }));
      expect(done.photosCopied).toBe(0); // everything it lists is already copied
      const after = await prisma.product.findUnique({ where: { id: holder.id } });
      expect(after!.imageKeys).toEqual([]); // the pre-existing same-SKU holder is untouched
      await expect(
        service.resumePhotos({ ...manifest, target: "other" }, args(target.slug, { apply: true })),
      ).rejects.toBeInstanceOf(CopyRefusal);
    });
  });

  describe("C-G19: --resume goes through the same guards as an apply", () => {
    const manifestFor = (targetId: string, targetProductId: string) => ({
      version: 1 as const,
      createdAt: new Date().toISOString(),
      source: ids.src,
      target: targetId,
      entries: [
        {
          sourceId: "x",
          targetId: targetProductId,
          sku: "S-1",
          photos: [{ sourceKey: "products/x/pending.png", status: "failed" as const }],
        },
      ],
    });

    it("a resume without --apply is refused by the service itself and copies nothing", async () => {
      const t = await tenant("rs0");
      const copy = jest.spyOn(service as never, "copyPhotos" as never);
      try {
        await expect(
          service.resumePhotos(manifestFor(t.id, "p"), args(t.slug) as never),
        ).rejects.toBeInstanceOf(CopyRefusal);
        expect(copy).not.toHaveBeenCalled();
      } finally {
        copy.mockRestore();
      }
    });

    it("beforeWrite runs once, with the target, BEFORE any photo is copied; a refusal there copies nothing", async () => {
      const t = await tenant("rs1");
      const copy = jest
        .spyOn(service as never, "copyPhotos" as never)
        .mockResolvedValue([] as never);
      try {
        const order: string[] = [];
        copy.mockImplementation((async () => {
          order.push("copy");
          return [];
        }) as never);
        const beforeWrite = jest.fn(
          async (_info: { targetTenantId: string; createCount: number }) => {
            order.push("hook");
          },
        );
        await service.resumePhotos(manifestFor(t.id, "p"), args(t.slug, { apply: true }), {
          beforeWrite,
        });
        expect(beforeWrite).toHaveBeenCalledTimes(1);
        expect(beforeWrite.mock.calls[0]![0]).toMatchObject({ targetTenantId: t.id });
        expect(order).toEqual(["hook", "copy"]);

        copy.mockClear();
        await expect(
          service.resumePhotos(manifestFor(t.id, "p"), args(t.slug, { apply: true }), {
            beforeWrite: async () => {
              throw new CopyRefusal("refused: the protected-tenant line was not typed");
            },
          }),
        ).rejects.toBeInstanceOf(CopyRefusal);
        expect(copy).not.toHaveBeenCalled();
      } finally {
        copy.mockRestore();
      }
    });
  });

  it("C-G3 (other side): a target that holds units_v1 gets the ladder, parents first, through the units service", async () => {
    const t = await tenant("t2");
    await grant(t.id, "GRANT");
    await grant(t.id, "GRANT", "flag.msrp");
    const r = await service.run(args(t.slug, { apply: true }));
    expect(r.errors).toEqual([]);
    const alpha = (await activeOf(t.id)).find((p) => p.name === "Alpha")!;
    const units = await prisma.productUnit.findMany({
      where: { productId: alpha.id },
      orderBy: { factorToBase: "asc" },
    });
    expect(units.map((u) => [u.label, u.factorToBase])).toEqual([
      ["Pair", 2],
      ["Half case", 6],
    ]);
    expect(units[1].parentUnitId).toBe(units[0].id);
    expect(Number(alpha.msrp)).toBe(1.25); // flag.msrp held: the MSRP copies
    expect(r.packOnly ?? []).toEqual([]);
  }, 60000);

  it("spec b17f0ed7: the dry run lists each TenantUnit the ladder writer would create; apply makes exactly those", async () => {
    const t = await tenant("t4");
    await grant(t.id, "GRANT");
    await prisma.tenantUnit.create({ data: { tenantId: t.id, name: "pair", nameKey: "pair" } });
    const dry = await service.run(args(t.slug));
    expect(dry.newUnits).toEqual(["Half case"]); // "Pair" is already the target's unit, matched by key
    expect(dry.tierUnitRows).toBe(1);
    expect((await prisma.tenantUnit.findMany({ where: { tenantId: t.id } })).length).toBe(1);

    const r = await service.run(args(t.slug, { apply: true }));
    expect(r.errors).toEqual([]);
    const names = (await prisma.tenantUnit.findMany({ where: { tenantId: t.id } }))
      .map((u) => u.name)
      .sort();
    expect(names).toEqual(["Half case", "pair"]); // the writer made what the dry run listed, nothing else
    expect(await prisma.productTierUnit.count({ where: { tenantId: t.id } })).toBe(0); // listed, not copied
  }, 60000);

  it("no partial family: a variant the service refuses undoes the family; the error is reported", async () => {
    const t = await tenant("t3");
    await grant(t.id, "DENY");
    const products = moduleRef.get(ProductsService);
    const real = products.create.bind(products);
    let calls = 0;
    const spy = jest.spyOn(products, "create").mockImplementation(((dto: never, opts: never) => {
      calls += 1;
      if ((dto as { name: string }).name === "A2") throw new Error("refused by the service");
      return real(dto, opts);
    }) as never);
    try {
      const r = await service.run(args(t.slug, { apply: true }));
      expect(r.errors!.length).toBeGreaterThanOrEqual(1);
      expect(calls).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
    const names = (await activeOf(t.id)).map((p) => p.name);
    expect(names).not.toContain("Fam A");
    expect(names).not.toContain("A1");
    expect(names).not.toContain("A2");
    expect(names).toContain("Alpha"); // the other groups still copied
  }, 60000);

  describe("C-G17: a failed family is undone by ONE bulkDelete; whatever it cannot undo is an error row", () => {
    const failA2 = () => {
      const products = moduleRef.get(ProductsService);
      const real = products.create.bind(products);
      return jest.spyOn(products, "create").mockImplementation(((dto: never, opts: never) => {
        if ((dto as { name: string }).name === "A2") throw new Error("refused by the service");
        return real(dto, opts);
      }) as never);
    };

    it("one bulkDelete call over the family's created ids, no remove(), the rows are gone (not archived)", async () => {
      const t = await tenant("g17a");
      await grant(t.id, "DENY");
      const products = moduleRef.get(ProductsService);
      const create = failA2();
      const bulk = jest.spyOn(products, "bulkDelete");
      const remove = jest.spyOn(products, "remove");
      try {
        const r = await service.run(args(t.slug, { apply: true }));
        expect(bulk).toHaveBeenCalledTimes(1);
        expect(bulk.mock.calls[0][0].length).toBeGreaterThanOrEqual(1); // what this family had created when A2 failed
        expect(remove).not.toHaveBeenCalled();
        expect(r.errors).toEqual([
          expect.objectContaining({ kind: "copy", message: "refused by the service" }),
        ]);
        expect(r.manifest!.errors).toEqual(r.errors);
      } finally {
        create.mockRestore();
        bulk.mockRestore();
        remove.mockRestore();
      }
      const left = await prisma.product.findMany({
        where: { tenantId: t.id, name: { in: ["Fam A", "A1", "A2"] } },
      });
      expect(left).toEqual([]); // hard-deleted: nothing archived, nothing left behind
    }, 60000);

    it.each([
      [
        "an id it skips",
        (n: number) => ({
          deleted: n - 1,
          softDeleted: 0,
          skipped: [{ id: "skipped-id", code: "OPEN", reason: "open" }],
        }),
        /undo skipped skipped-id [(]OPEN[)]/,
      ],
      [
        "an id it archives",
        (n: number) => ({ deleted: 0, softDeleted: n, skipped: [] }),
        /undo archived [0-9]+ of [0-9]+ product[(]s[)]/,
      ],
      [
        "a count it cannot account for",
        (n: number) => ({ deleted: n - 1, softDeleted: 0, skipped: [] }),
        /accounted for [0-9]+ of [0-9]+/,
      ],
    ])(
      "%s is an error row in the report and the manifest",
      async (_name, outcome, message) => {
        const t = await tenant(`g17-${_name.replace(/\W+/g, "")}`);
        await grant(t.id, "DENY");
        const products = moduleRef.get(ProductsService);
        const create = failA2();
        const bulk = jest
          .spyOn(products, "bulkDelete")
          .mockImplementation((async (ids: string[]) => outcome(ids.length)) as never);
        try {
          const r = await service.run(args(t.slug, { apply: true }));
          const undo = r.errors!.filter((e) => e.kind === "undo");
          expect(undo).toHaveLength(1);
          expect(undo[0].message).toMatch(message);
          expect(r.manifest!.errors).toEqual(r.errors);
        } finally {
          create.mockRestore();
          bulk.mockRestore();
        }
      },
      60000,
    );

    it("an undo that throws is an error row, and the run still finishes the other groups", async () => {
      const t = await tenant("g17throw");
      await grant(t.id, "DENY");
      const products = moduleRef.get(ProductsService);
      const create = failA2();
      const bulk = jest.spyOn(products, "bulkDelete").mockRejectedValue(new Error("boom"));
      try {
        const r = await service.run(args(t.slug, { apply: true }));
        const undo = r.errors!.filter((e) => e.kind === "undo");
        expect(undo).toHaveLength(1);
        expect(undo[0].message).toMatch(/undo failed for .*: boom/);
        expect(exitCodeFor(r)).toBe(3);
        expect((await activeOf(t.id)).map((p) => p.name)).toContain("Alpha");
      } finally {
        create.mockRestore();
        bulk.mockRestore();
      }
    }, 60000);
  });

  describe("C-G16: --apply refuses while the source holds a recipe product", () => {
    const seed = async () => {
      const rs = await tenant("recsrc");
      await product(rs.id, { name: "Plain One", sku: "P-1" });
      await product(rs.id, { name: "Recipe Nine", sku: "R-9", kind: "RECIPE" });
      return rs;
    };

    it("the dry run still reports the recipe; --apply throws CopyRefusal naming it and writes nothing", async () => {
      const rs = await seed();
      const t = await tenant("recdst");
      await grant(t.id, "DENY");
      const dry = await service.run(args(t.slug, { source: rs.slug }));
      expect(dry.recipesLeftOut).toEqual(["R-9"]);
      expect(dry.toCreate).toBe(1);

      const beforeWrite = jest.fn();
      const attempt = service.run(args(t.slug, { source: rs.slug, apply: true }), { beforeWrite });
      await expect(attempt).rejects.toBeInstanceOf(CopyRefusal);
      await expect(attempt).rejects.toThrow(/R-9/);
      expect(beforeWrite).not.toHaveBeenCalled();
      expect(await prisma.product.count({ where: { tenantId: t.id } })).toBe(0);
    }, 60000);
  });

  it("scale: a 2,500-product source across families is read WHOLE - the dry-run and created counts equal the seeded count", async () => {
    const big = await tenant("big");
    const SINGLES = 1500;
    const FAMILIES = 20;
    const PER_FAMILY = 50;
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < SINGLES; i += 1) {
      rows.push({
        id: randomUUID(),
        tenantId: big.id,
        name: `Single ${i}`,
        sku: `BG-${i}`,
        unit: "box",
        pricePerUnit: "5.00",
      });
    }
    for (let f = 0; f < FAMILIES; f += 1) {
      const familyId = randomUUID();
      rows.push({
        id: familyId,
        tenantId: big.id,
        name: `Family ${f}`,
        unit: "each",
        pricePerUnit: "5.00",
        kind: "FAMILY",
      });
      for (let v = 0; v < PER_FAMILY; v += 1) {
        rows.push({
          id: randomUUID(),
          tenantId: big.id,
          name: `Family ${f} Variant ${v}`,
          variantName: `Variant ${v}`,
          sku: `BF-${f}-${v}`,
          unit: "each",
          pricePerUnit: "5.00",
          kind: "VARIANT",
          parentProductId: familyId,
        });
      }
    }
    for (let i = 0; i < rows.length; i += 500) {
      await prisma.product.createMany({ data: rows.slice(i, i + 500) as never });
    }
    const seeded = rows.length; // 1,500 + 20 x (1 container + 50 variants) = 2,520, more than the 500-row page
    expect(seeded).toBeGreaterThanOrEqual(2500);
    expect(await prisma.product.count({ where: { tenantId: big.id, isActive: true } })).toBe(
      seeded,
    );

    const target = await tenant("bigt");
    await grant(target.id, "DENY"); // pack-only target, as the other cases: no plan-catalog lookup
    const t0 = Date.now();
    const dry = await service.run(args(target.slug, { source: big.slug }));
    const dryMs = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.info(`catalog-copy scale: dry run of ${seeded} products took ${dryMs} ms`);
    expect(dry.sourceProducts).toBe(seeded);
    expect(dry.toCreate).toBe(seeded);

    const t1 = Date.now();
    const applied = await service.run(args(target.slug, { source: big.slug, apply: true }));
    // eslint-disable-next-line no-console
    console.info(`catalog-copy scale: apply of ${seeded} products took ${Date.now() - t1} ms`);
    expect(applied.errors).toEqual([]);
    expect(applied.created).toBe(seeded);
    expect(await prisma.product.count({ where: { tenantId: target.id, isActive: true } })).toBe(
      seeded,
    );
  }, 1_800_000);
});
