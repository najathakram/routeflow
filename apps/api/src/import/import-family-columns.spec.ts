import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import { ImportService } from "./import.service";
import {
  IMPORT_FAMILY_CLASS_REASON,
  IMPORT_FAMILY_MAX_ROWS,
  ProductFamilyImportService,
} from "./product-family-import.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import { ProductFamiliesService } from "../products/product-families.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { AuditService } from "../audit/audit.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { parentInvalid, PRODUCT_PARENT_REASONS } from "../products/product-parent";

/**
 * SA-823 PR-2 MUST tests R1-R10: the Family / Variant name / Product ID columns of POST /import/products. The catalog is an
 * in-memory fake keyed by tenant (so tenant scope is real: forTenant() filters), and ProductsService / ProductFamiliesService
 * are fakes that mutate it the way the real writers do (the real audit row, label keeping and locks are proven by
 * product-family-import.db.spec.ts and PR-1's specs).
 */
const TENANT = "tenant-a";
const OTHER = "tenant-b";

interface Row {
  id: string;
  tenantId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  kind: "STANDARD" | "FAMILY" | "VARIANT";
  parentProductId: string | null;
  variantName: string | null;
  isActive: boolean;
  isTobacco: boolean;
  trackedCategoryId: string | null;
  currentStock: number;
  pricePerUnit: number;
  category: string | null;
  unitsPerBox: number | null;
}
let seq = 0;
const mk = (over: Partial<Row> & { id: string; name: string }): Row => ({
  tenantId: TENANT,
  sku: null,
  barcode: null,
  kind: "STANDARD",
  parentProductId: null,
  variantName: null,
  isActive: true,
  isTobacco: false,
  trackedCategoryId: null,
  currentStock: 0,
  pricePerUnit: 10,
  category: null,
  unitsPerBox: null,
  ...over,
});

function matches(r: any, where: any): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === undefined) continue;
    if (k === "OR") {
      if (!(v as any[]).some((w) => matches(r, w))) return false;
      continue;
    }
    const val = r[k];
    if (v !== null && typeof v === "object") {
      const o = v as any;
      if ("equals" in o) {
        const same =
          o.mode === "insensitive"
            ? String(val ?? "").toLowerCase() === String(o.equals).toLowerCase()
            : val === o.equals;
        if (!same) return false;
      } else if ("not" in o) {
        if (val === o.not) return false;
      } else if ("in" in o) {
        if (!o.in.includes(val)) return false;
      }
    } else if ((val ?? null) !== v) return false;
  }
  return true;
}

describe("ImportService.importProducts: Family / Variant name columns (SA-823 PR-2)", () => {
  let service: ImportService;
  let rows: Row[];
  let audits: Array<Record<string, unknown>>;
  let trackedCategories: Array<{ id: string; name: string }>;
  let priorAudits: Array<{ action: string; entityId: string }>;
  let productsService: Record<string, jest.Mock>;
  let families: {
    reserveFamilyName: jest.Mock;
    createFamilyContainer: jest.Mock;
    reactivateFamilyContainer: jest.Mock;
  };
  let featureConfig: { getEffectiveMode: jest.Mock };
  let auditService: { log: jest.Mock };

  const tenantProduct = () => ({
    findFirst: jest.fn(async (a: any) => {
      return rows.find((r) => r.tenantId === TENANT && matches(r, a?.where)) ?? null;
    }),
    findMany: jest.fn(async (a: any) => {
      const found = rows.filter((r) => r.tenantId === TENANT && matches(r, a?.where));
      return a?.take ? found.slice(0, a.take) : found;
    }),
    count: jest.fn(
      async (a: any) => rows.filter((r) => r.tenantId === TENANT && matches(r, a?.where)).length,
    ),
  });

  beforeEach(async () => {
    seq = 0;
    rows = [];
    audits = [];
    trackedCategories = [];
    priorAudits = [];
    const prisma = {
      getTenantId: () => TENANT,
      forTenant: () => ({
        product: tenantProduct(),
        trackedCategory: {
          findFirst: jest.fn(async (a: any) => {
            const w = a?.where ?? {};
            return (
              trackedCategories.find(
                (c) =>
                  (w.id === undefined || c.id === w.id) &&
                  (w.name === undefined ||
                    c.name.toLowerCase() === String(w.name.equals ?? w.name).toLowerCase()),
              ) ?? null
            );
          }),
        },
        orderItem: { count: jest.fn(async () => 0) },
      }),
      auditLog: {
        findFirst: jest.fn(async (a: any) => {
          const w = a?.where ?? {};
          return (
            priorAudits.find((x) => x.action === w.action && x.entityId === w.entityId) ?? null
          );
        }),
      },
      tenantTransaction: async (cb: (tx: unknown) => unknown) => cb({}),
    };
    const find = (id: string) => rows.find((r) => r.id === id && r.tenantId === TENANT);
    productsService = {
      emitCatalogBulkChanged: jest.fn(),
      assertCanFlagTobacco: jest.fn().mockResolvedValue(undefined),
      assertMsrpAllowed: jest.fn().mockResolvedValue(undefined),
      assertReorderAllowed: jest.fn().mockResolvedValue(undefined),
      assertIdentityAvailable: jest.fn(async (p: any, excludeId?: string) => {
        const clash = rows.find(
          (r) =>
            r.tenantId === TENANT &&
            r.isActive &&
            r.id !== excludeId &&
            ((p.name !== undefined &&
              r.name.toLowerCase() === p.name.toLowerCase() &&
              (r.parentProductId ?? null) === (p.parentProductId ?? null)) ||
              (p.sku && r.sku === p.sku)),
        );
        if (clash) throw new ConflictException(`"${p.name ?? p.sku}" already exists`);
      }),
      assignToParent: jest.fn(
        async (id: string, parentId: string, label: string, opts: any): Promise<unknown> => {
          const r = find(id)!;
          if (rows.some((x) => x.parentProductId === id)) {
            throw parentInvalid(
              PRODUCT_PARENT_REASONS.HAS_VARIANTS,
              "This product has variants of its own, so it cannot become a variant",
            );
          }
          audits.push({
            action: "product.family_assigned",
            productId: id,
            fromParentId: r.parentProductId,
            toParentId: parentId,
            variantName: label,
            via: opts.via,
          });
          Object.assign(r, opts.extraChanges ?? {}, {
            parentProductId: parentId,
            kind: "VARIANT",
            name: label,
            variantName: label,
          });
          return r;
        },
      ),
      create: jest.fn(async (dto: any, opts: any) => {
        if (dto.parentProductId && !opts?.reparentVia) throw new Error("reparentVia required");
        const row = mk({
          id: `new-${++seq}`,
          name: dto.name,
          sku: dto.sku ?? null,
          barcode: dto.barcode ?? null,
          kind: dto.parentProductId ? "VARIANT" : "STANDARD",
          parentProductId: dto.parentProductId ?? null,
          variantName: dto.parentProductId ? (dto.variantName ?? dto.name) : null,
          pricePerUnit: dto.pricePerUnit,
          isTobacco: dto.isTobacco ?? false,
        });
        rows.push(row);
        if (dto.parentProductId) {
          audits.push({
            action: "product.family_assigned",
            productId: row.id,
            fromParentId: null,
            toParentId: dto.parentProductId,
            variantName: row.variantName,
            via: opts.reparentVia,
          });
        }
        return row;
      }),
      update: jest.fn(async (id: string, dto: any) => Object.assign(find(id)!, dto)),
      remove: jest.fn(async (id: string) => {
        find(id)!.isActive = false;
        return { id };
      }),
    };
    families = {
      reserveFamilyName: jest.fn().mockResolvedValue([]),
      reactivateFamilyContainer: jest.fn(async (id: string) => {
        const row = rows.find((r) => r.id === id && r.tenantId === TENANT)!;
        row.isActive = true;
        return row;
      }),
      createFamilyContainer: jest.fn(async (_tx: unknown, input: any) => {
        const row = mk({
          id: `fam-${++seq}`,
          name: input.name,
          kind: "FAMILY",
          unitsPerBox: null,
          category: input.category ?? null,
          pricePerUnit: Number(input.pricePerUnit),
        });
        rows.push(row);
        return row;
      }),
    };
    featureConfig = { getEffectiveMode: jest.fn().mockResolvedValue("off") };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };

    const mod = await Test.createTestingModule({
      providers: [
        ImportService,
        ProductFamilyImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: {} },
        { provide: CustomersService, useValue: {} },
        { provide: NumberingService, useValue: {} },
        { provide: ExternalRefService, useValue: {} },
        { provide: ProductsService, useValue: productsService },
        { provide: ProductFamiliesService, useValue: families },
        { provide: FeatureConfigService, useValue: featureConfig },
        { provide: AuditService, useValue: auditService },
        { provide: SellingRestrictionsService, useValue: {} },
      ],
    }).compile();
    service = mod.get(ImportService);
  });

  const HEADER = "Item Name,SKU,Barcode,Rate,Family,Variant Name,Product ID,Tobacco";
  const csv = (...lines: string[]) => Buffer.from([HEADER, ...lines].join("\n") + "\n");
  const run = (b: Buffer, dryRun = false): Promise<any> =>
    service.importProducts(b, "user-1", { dryRun, fileName: "f.csv" });
  const byRow = (r: any, n: number) => r.rows.find((p: any) => p.row === n);
  const famAudits = () => audits.filter((a) => a.action === "product.family_assigned");
  const FAMILY_ROWS = () => rows.filter((r) => r.kind === "FAMILY");

  describe("R1: an existing product matched by id or SKU joins an existing FAMILY", () => {
    beforeEach(() => {
      rows.push(mk({ id: "fam-cola", name: "Acme Cola", kind: "FAMILY", isActive: true }));
      rows.push(
        mk({ id: "p1", name: "Acme Cola 12oz", sku: "S1", currentStock: 40, pricePerUnit: 5 }),
      );
      rows.push(
        mk({ id: "p2", name: "Acme Cola 1L", sku: "S2", currentStock: 7, pricePerUnit: 8 }),
      );
    });

    it("by SKU: assignToParent(id, family, label, via import); stock and price columns untouched; one audit row", async () => {
      const r = await run(csv(",S1,,,Acme Cola,12oz,,"));
      expect(r.unknownColumns).toEqual([]);
      expect(r.skipped).toBe(0);
      expect(productsService.assignToParent).toHaveBeenCalledTimes(1);
      expect(productsService.assignToParent).toHaveBeenCalledWith(
        "p1",
        "fam-cola",
        "12oz",
        expect.objectContaining({ via: "import", actorId: "user-1", suppressEmit: true }),
      );
      const p1 = rows.find((x) => x.id === "p1")!;
      expect(p1).toMatchObject({
        kind: "VARIANT",
        name: "12oz",
        currentStock: 40,
        pricePerUnit: 5,
      });
      expect(famAudits()).toHaveLength(1);
      expect(famAudits()[0]).toMatchObject({
        fromParentId: null,
        toParentId: "fam-cola",
        via: "import",
      });
    });

    it("by id (no SKU in the file): the id is the stable key", async () => {
      const r = await run(csv(",,,,Acme Cola,1L,p2,"));
      expect(r.skipped).toBe(0);
      expect(productsService.assignToParent).toHaveBeenCalledWith(
        "p2",
        "fam-cola",
        "1L",
        expect.anything(),
      );
      expect(byRow(r, 1).family).toMatchObject({
        matchedBy: "id",
        state: "existing",
        name: "Acme Cola",
      });
    });

    it("a blank Variant name strips the '{Family} - ' prefix from the current name, else keeps the name", async () => {
      rows.push(mk({ id: "p3", name: "Acme Cola - Zero", sku: "S3" }));
      rows.push(mk({ id: "p4", name: "Plain Name", sku: "S4" }));
      const r = await run(csv(",S3,,,Acme Cola,,,", ",S4,,,Acme Cola,,,"));
      expect(productsService.assignToParent).toHaveBeenCalledWith(
        "p3",
        "fam-cola",
        "Zero",
        expect.anything(),
      );
      expect(productsService.assignToParent).toHaveBeenCalledWith(
        "p4",
        "fam-cola",
        "Plain Name",
        expect.anything(),
      );
      expect(byRow(r, 1).family).toMatchObject({
        variantName: "Zero",
        displayName: "Acme Cola - Zero",
      });
    });

    it("the preview writes nothing but shows the key, the rename, the display name and the stock", async () => {
      const r = await run(csv(",S1,,,Acme Cola,12oz,,"), true);
      expect(productsService.assignToParent).not.toHaveBeenCalled();
      const plan = byRow(r, 1);
      expect(plan.action).toBe("update");
      expect(plan.changes.name).toEqual({ from: "Acme Cola 12oz", to: "12oz" });
      expect(plan.family).toMatchObject({
        matchedBy: "sku",
        state: "existing",
        variantName: "12oz",
        displayName: "Acme Cola - 12oz",
        movesFrom: null,
        stock: 40,
      });
    });
  });

  describe("R2: a new Family name creates ONE container and assigns the rows", () => {
    const file = () =>
      csv(
        ",S10,,,Acme Soda,A,,", // existing, price 3
        ",S11,,,Acme Soda,B,,", // existing, price 2.5
        "Soda C,S12,,4,Acme Soda,C,,", // new variant
      );
    beforeEach(() => {
      rows.push(mk({ id: "s10", name: "Soda A", sku: "S10", pricePerUnit: 3, category: "Soda" }));
      rows.push(mk({ id: "s11", name: "Soda B", sku: "S11", pricePerUnit: 2.5, category: "Soda" }));
    });

    it("one FAMILY container priced at the lowest row price, N rows assigned, a new variant created under it", async () => {
      const r = await run(file());
      expect(r.skipped).toBe(0);
      expect(families.reserveFamilyName).toHaveBeenCalledTimes(1);
      expect(families.createFamilyContainer).toHaveBeenCalledTimes(1);
      expect(families.createFamilyContainer.mock.calls[0][1]).toMatchObject({
        name: "Acme Soda",
        pricePerUnit: "2.50",
        category: "Soda",
        actorId: "user-1",
      });
      const fam = FAMILY_ROWS()[0];
      expect(productsService.assignToParent).toHaveBeenCalledTimes(2);
      expect(productsService.assignToParent).toHaveBeenCalledWith(
        "s10",
        fam.id,
        "A",
        expect.anything(),
      );
      expect(productsService.create).toHaveBeenCalledTimes(1);
      expect(productsService.create.mock.calls[0][0]).toMatchObject({
        parentProductId: fam.id,
        name: "C",
        variantName: "C",
        sku: "S12",
        pricePerUnit: 4,
      });
      expect(productsService.create.mock.calls[0][1]).toMatchObject({ reparentVia: "import" });
      expect(r.created).toBe(1);
      expect(r.updated).toBe(2);
    });

    it("the preview shows the new family once with its row count, and creates nothing", async () => {
      const r = await run(file(), true);
      expect(families.createFamilyContainer).not.toHaveBeenCalled();
      expect(r.families.familiesToCreate).toEqual([{ name: "Acme Soda", rows: 3 }]);
      expect(byRow(r, 1).family).toMatchObject({ state: "new", name: "Acme Soda" });
    });

    it("a rerun is unchanged and creates no second family", async () => {
      await run(file());
      const again = await run(file());
      expect(families.createFamilyContainer).toHaveBeenCalledTimes(1);
      expect(again.created).toBe(0);
      expect(again.updated).toBe(0);
      expect(again.unchanged).toBe(3);
      expect(FAMILY_ROWS()).toHaveLength(1);
    });
  });

  it("R3: a name-only match with a Family cell is skipped with the key message and writes nothing", async () => {
    rows.push(mk({ id: "fam-cola", name: "Acme Cola", kind: "FAMILY" }));
    rows.push(mk({ id: "loose", name: "Loose Item" }));
    for (const dryRun of [true, false]) {
      const r = await run(csv("Loose Item,,,,Acme Cola,,,"), dryRun);
      expect(r.skipped).toBe(1);
      expect(byRow(r, 1).reason).toBe(
        "Add the product's id, SKU or barcode to move it into a family.",
      );
    }
    expect(productsService.assignToParent).not.toHaveBeenCalled();
    expect(productsService.create).not.toHaveBeenCalled();
  });

  it("R4 (d): a Family name equal to a variant-less STANDARD product is skipped; that product stays sellable and unchanged", async () => {
    rows.push(mk({ id: "std", name: "Acme Cola", pricePerUnit: 3 }));
    rows.push(mk({ id: "p1", name: "Acme Cola 12oz", sku: "S1" }));
    for (const dryRun of [true, false]) {
      const r = await run(csv(",S1,,,Acme Cola,12oz,,"), dryRun);
      expect(byRow(r, 1)).toMatchObject({
        action: "skip",
        reason:
          "Acme Cola is a product, not a family. Rename one of them, or make Acme Cola a family first.",
      });
    }
    expect(productsService.assignToParent).not.toHaveBeenCalled();
    expect(families.createFamilyContainer).not.toHaveBeenCalled();
    expect(rows.find((x) => x.id === "std")).toMatchObject({
      kind: "STANDARD",
      isActive: true,
      pricePerUnit: 3,
    });
  });

  it("R4 (b): a legacy STANDARD parent that already has variants is a valid family", async () => {
    rows.push(mk({ id: "legacy", name: "Acme Cola" }));
    rows.push(mk({ id: "kid", name: "Classic", kind: "VARIANT", parentProductId: "legacy" }));
    rows.push(mk({ id: "p1", name: "Other", sku: "S1" }));
    const r = await run(csv(",S1,,,Acme Cola,Zero,,"));
    expect(r.skipped).toBe(0);
    expect(productsService.assignToParent).toHaveBeenCalledWith(
      "p1",
      "legacy",
      "Zero",
      expect.anything(),
    );
    expect(families.createFamilyContainer).not.toHaveBeenCalled();
  });

  describe("R5: guards are row skips", () => {
    beforeEach(() => {
      rows.push(mk({ id: "fam", name: "Acme Cola", kind: "FAMILY" }));
    });

    it("HAS_VARIANTS: a product with variants of its own cannot become a variant (preview and apply agree)", async () => {
      rows.push(mk({ id: "top", name: "Top", sku: "S1" }));
      rows.push(mk({ id: "child", name: "Child", kind: "VARIANT", parentProductId: "top" }));
      const preview = await run(csv(",S1,,,Acme Cola,X,,"), true);
      const real = await run(csv(",S1,,,Acme Cola,X,,"));
      for (const r of [preview, real]) {
        expect(byRow(r, 1).action).toBe("skip");
        expect(byRow(r, 1).reason).toMatch(/variants of its own/);
      }
    });

    it("VARIANT_PARENT / INACTIVE raised by the writer at apply turn the row into a skip with the writer's reason", async () => {
      rows.push(mk({ id: "p1", name: "P1", sku: "S1" }));
      productsService.assignToParent.mockRejectedValueOnce(
        parentInvalid(
          PRODUCT_PARENT_REASONS.VARIANT_PARENT,
          "Parent must be a standalone product, not a variant",
        ),
      );
      const r = await run(csv(",S1,,,Acme Cola,X,,"));
      expect(byRow(r, 1)).toMatchObject({
        action: "skip",
        reason: "Parent must be a standalone product, not a variant",
      });
      expect(r.updated).toBe(0);
    });

    it("an INACTIVE family is not a family: the row is skipped", async () => {
      rows.push(mk({ id: "old", name: "Retired", kind: "FAMILY", isActive: false }));
      rows.push(mk({ id: "p1", name: "P1", sku: "S1" }));
      const r = await run(csv(",S1,,,Retired,X,,"));
      expect(byRow(r, 1).action).toBe("skip");
      expect(byRow(r, 1).reason).toMatch(/inactive/i);
      expect(families.createFamilyContainer).not.toHaveBeenCalled();
    });

    it("a regulated-class mix (tobacco into a non-tobacco family) is skipped", async () => {
      rows.push(
        mk({ id: "sib", name: "Sib", kind: "VARIANT", parentProductId: "fam", isTobacco: false }),
      );
      rows.push(mk({ id: "p1", name: "P1", sku: "S1", isTobacco: true }));
      const r = await run(csv(",S1,,,Acme Cola,X,,"), true);
      expect(byRow(r, 1)).toMatchObject({
        action: "skip",
        reason: "A family's items must share their regulated category.",
      });
    });

    it("a regulated-class mix inside one file: the first row sets the family's class, the mismatching row is skipped", async () => {
      rows.push(mk({ id: "p1", name: "P1", sku: "S1", isTobacco: false }));
      rows.push(mk({ id: "p2", name: "P2", sku: "S2", isTobacco: true }));
      const r = await run(csv(",S1,,,Acme Cola,One,,", ",S2,,,Acme Cola,Two,,"));
      expect(byRow(r, 1).action).toBe("update");
      expect(byRow(r, 2).action).toBe("skip");
      expect(byRow(r, 2).reason).toMatch(/regulated category/);
    });

    it("a duplicate label: BOTH rows giving one family the same label are skipped", async () => {
      rows.push(mk({ id: "p1", name: "P1", sku: "S1" }));
      rows.push(mk({ id: "p2", name: "P2", sku: "S2" }));
      const r = await run(csv(",S1,,,Acme Cola,Zero,,", ",S2,,,acme cola,zero,,"), true);
      expect(byRow(r, 1).action).toBe("skip");
      expect(byRow(r, 2).action).toBe("skip");
      expect(byRow(r, 1).reason).toMatch(/same variant name/);
      expect(r.skipped).toBe(2);
    });

    it("a label that an existing sibling already holds is a skip in the preview (the writer's own identity check)", async () => {
      rows.push(
        mk({ id: "sib", name: "Zero", kind: "VARIANT", parentProductId: "fam", sku: "SS" }),
      );
      rows.push(mk({ id: "p1", name: "P1", sku: "S1" }));
      const r = await run(csv(",S1,,,Acme Cola,Zero,,"), true);
      expect(byRow(r, 1).action).toBe("skip");
    });
  });

  describe("R6: family pricing (mixed_packs) ON refuses the whole file", () => {
    beforeEach(() => {
      featureConfig.getEffectiveMode.mockResolvedValue("on");
      rows.push(mk({ id: "fam", name: "Acme Cola", kind: "FAMILY" }));
      rows.push(mk({ id: "p1", name: "P1", sku: "S1", pricePerUnit: 5 }));
    });

    it.each([true, false])(
      "409 IMPORT_FAMILY_PRICING_ON with dryRun=%s and no row written",
      async (dryRun) => {
        let err: any;
        await run(csv(",S1,,,Acme Cola,X,,"), dryRun).catch((e) => (err = e));
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse()).toMatchObject({
          code: API_ERROR_CODES.IMPORT_FAMILY_PRICING_ON,
          message:
            "Family pricing is on, so grouping would change these products' prices. Turn family pricing off, or group them in the product editor.",
        });
        expect(featureConfig.getEffectiveMode).toHaveBeenCalledWith(TENANT, "mixed_packs");
        expect(productsService.assignToParent).not.toHaveBeenCalled();
        expect(productsService.create).not.toHaveBeenCalled();
        expect(families.createFamilyContainer).not.toHaveBeenCalled();
      },
    );

    it("a file WITHOUT the Family column is untouched by the flag", async () => {
      const r = await service.importProducts(Buffer.from("Item Name,SKU,Rate\n,S1,6\n"), "user-1");
      expect(r.updated).toBe(1);
    });
  });

  it("R7: a move between families is shown in the preview and applied, with the audit row carrying from and to", async () => {
    rows.push(mk({ id: "f1", name: "Old Family", kind: "FAMILY" }));
    rows.push(mk({ id: "f2", name: "New Family", kind: "FAMILY" }));
    rows.push(mk({ id: "v1", name: "Zero", sku: "S1", kind: "VARIANT", parentProductId: "f1" }));
    const preview = await run(csv(",S1,,,New Family,Zero,,"), true);
    expect(byRow(preview, 1).family).toMatchObject({ movesFrom: "Old Family", name: "New Family" });
    expect(preview.families.moves).toBe(1);
    await run(csv(",S1,,,New Family,Zero,,"));
    expect(famAudits()).toEqual([
      expect.objectContaining({
        productId: "v1",
        fromParentId: "f1",
        toParentId: "f2",
        via: "import",
      }),
    ]);
  });

  it("a move INTO A NEW family counts as a move: the product leaves its previous family (lead ruling)", async () => {
    rows.push(mk({ id: "f1", name: "Old Family", kind: "FAMILY" }));
    rows.push(mk({ id: "v1", name: "Zero", sku: "S1", kind: "VARIANT", parentProductId: "f1" }));
    const preview = await run(csv(",S1,,,Brand New Fam,Zero,,"), true);
    expect(byRow(preview, 1).family).toMatchObject({ state: "new", movesFrom: "Old Family" });
    expect(preview.families.moves).toBe(1);
    expect(preview.families.familiesToCreate).toEqual([{ name: "Brand New Fam", rows: 1 }]);
    const real = await run(csv(",S1,,,Brand New Fam,Zero,,"));
    expect(real.families.moves).toBe(1);
    expect(famAudits()).toEqual([
      expect.objectContaining({ productId: "v1", fromParentId: "f1", via: "import" }),
    ]);
  });

  it("a variant already in the family with the right label is unchanged and not re-assigned", async () => {
    rows.push(mk({ id: "f1", name: "Acme Cola", kind: "FAMILY" }));
    rows.push(
      mk({
        id: "v1",
        name: "Zero",
        sku: "S1",
        kind: "VARIANT",
        parentProductId: "f1",
        variantName: "Zero",
      }),
    );
    const r = await run(csv(",S1,,,Acme Cola,Zero,,"));
    expect(r.unchanged).toBe(1);
    expect(productsService.assignToParent).not.toHaveBeenCalled();
  });

  it("a blank Family cell means no change: a variant is never un-grouped", async () => {
    rows.push(mk({ id: "f1", name: "Acme Cola", kind: "FAMILY" }));
    rows.push(mk({ id: "v1", name: "Zero", sku: "S1", kind: "VARIANT", parentProductId: "f1" }));
    const r = await run(csv(",S1,,6,,,,"));
    expect(productsService.assignToParent).not.toHaveBeenCalled();
    expect(r.rows[0].family).toBeUndefined();
  });

  describe("R8: an all-failing new family is deactivated and reported", () => {
    beforeEach(() => {
      rows.push(mk({ id: "p1", name: "P1", sku: "S1" }));
    });

    it("the family this run created, ending with no assigned item, is deactivated in the same run", async () => {
      productsService.assignToParent.mockRejectedValue(new BadRequestException("boom"));
      const r = await run(csv(",S1,,,Ghost Family,X,,"));
      expect(families.createFamilyContainer).toHaveBeenCalledTimes(1);
      const ghost = FAMILY_ROWS()[0];
      expect(productsService.remove).toHaveBeenCalledWith(ghost.id);
      expect(ghost.isActive).toBe(false);
      expect(r.skipped).toBe(1);
      expect(r.families.deactivated).toEqual([{ name: "Ghost Family" }]);
      expect(r.warnings.join(" ")).toMatch(/Ghost Family/);
    });

    it("a family with at least one assigned row is kept", async () => {
      rows.push(mk({ id: "p2", name: "P2", sku: "S2" }));
      productsService.assignToParent.mockRejectedValueOnce(new BadRequestException("boom"));
      const r = await run(csv(",S1,,,Ghost Family,X,,", ",S2,,,Ghost Family,Y,,"));
      expect(productsService.remove).not.toHaveBeenCalled();
      expect(r.families.deactivated).toEqual([]);
    });

    it("the preview creates nothing, and a family whose rows are all planned skips is not listed", async () => {
      rows.push(mk({ id: "top", name: "Top", sku: "S9" }));
      rows.push(mk({ id: "child", name: "C", kind: "VARIANT", parentProductId: "top" }));
      const r = await run(csv(",S9,,,Ghost Family,X,,"), true);
      expect(families.createFamilyContainer).not.toHaveBeenCalled();
      expect(r.families.familiesToCreate).toEqual([]);
    });
  });

  it("R9: the preview equals the apply for the same file on an unchanged DB (counts and per-row actions)", async () => {
    rows.push(mk({ id: "fam", name: "Acme Cola", kind: "FAMILY" }));
    rows.push(mk({ id: "f1", name: "Old Family", kind: "FAMILY" }));
    rows.push(mk({ id: "a", name: "A", sku: "SA", pricePerUnit: 3 }));
    rows.push(mk({ id: "b", name: "B", sku: "SB" }));
    rows.push(mk({ id: "mv", name: "Mv", sku: "SM", kind: "VARIANT", parentProductId: "f1" }));
    rows.push(mk({ id: "std", name: "Std Thing" }));
    const file = csv(
      ",SA,,,New Fam,One,,",
      "Fresh,SF,,9,New Fam,Two,,",
      ",SM,,,Acme Cola,Mv,,",
      "Std Thing,,,,Acme Cola,,,",
      ",SB,,,Std Thing,,,",
      ",NOPE,,,Acme Cola,,,",
    );
    const preview = await run(file, true);
    const real = await run(file);
    const shape = (r: any) => ({
      counts: [r.created, r.updated, r.unchanged, r.skipped],
      rows: r.rows.map((p: any) => [p.row, p.action, p.reason ?? null, p.family?.state ?? null]),
      header: { ...r.families, deactivated: undefined },
    });
    expect(shape(real)).toEqual(shape(preview));
  });

  describe("R10: tenant scope", () => {
    it("another tenant's family name is never matched: the row creates its own family", async () => {
      rows.push(mk({ id: "foreign", tenantId: OTHER, name: "Acme Cola", kind: "FAMILY" }));
      rows.push(mk({ id: "p1", name: "P1", sku: "S1" }));
      await run(csv(",S1,,,Acme Cola,X,,"));
      expect(families.createFamilyContainer).toHaveBeenCalledTimes(1);
      const own = FAMILY_ROWS().find((f) => f.tenantId === TENANT)!;
      expect(productsService.assignToParent).toHaveBeenCalledWith(
        "p1",
        own.id,
        "X",
        expect.anything(),
      );
    });

    it("another tenant's product id is not found: the row is skipped, never matched", async () => {
      rows.push(mk({ id: "fam", name: "Acme Cola", kind: "FAMILY" }));
      rows.push(mk({ id: "alien", tenantId: OTHER, name: "Alien", sku: "AL" }));
      const r = await run(csv(",,,,Acme Cola,X,alien,"));
      expect(byRow(r, 1).action).toBe("skip");
      expect(productsService.assignToParent).not.toHaveBeenCalled();
      expect(productsService.create).not.toHaveBeenCalled();
    });
  });

  it("matching order is id, then SKU, then barcode (a row whose id and SKU name different products follows the id)", async () => {
    rows.push(mk({ id: "fam", name: "Acme Cola", kind: "FAMILY" }));
    rows.push(mk({ id: "by-id", name: "By Id", sku: "X1" }));
    rows.push(mk({ id: "by-sku", name: "By Sku", sku: "X2" }));
    rows.push(mk({ id: "by-bc", name: "By Bc", barcode: "B1" }));
    await run(csv(",X2,,,Acme Cola,One,by-id,", ",,B1,,Acme Cola,Two,,"));
    expect(productsService.assignToParent).toHaveBeenCalledWith(
      "by-id",
      "fam",
      "One",
      expect.anything(),
    );
    expect(productsService.assignToParent).toHaveBeenCalledWith(
      "by-bc",
      "fam",
      "Two",
      expect.anything(),
    );
    expect(productsService.assignToParent).not.toHaveBeenCalledWith(
      "by-sku",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("an unmatched row with a Family cell creates a new variant under the existing family", async () => {
    rows.push(mk({ id: "fam", name: "Acme Cola", kind: "FAMILY" }));
    const r = await run(csv("Fresh One,SNEW,,6,Acme Cola,,,"));
    expect(r.created).toBe(1);
    expect(productsService.create.mock.calls[0][0]).toMatchObject({
      name: "Fresh One",
      variantName: "Fresh One",
      parentProductId: "fam",
      sku: "SNEW",
    });
  });

  it("a file with a Family column over IMPORT_FAMILY_MAX_ROWS is refused whole (400) in both modes", async () => {
    const lines = Array.from(
      { length: IMPORT_FAMILY_MAX_ROWS + 1 },
      (_, i) => `,SK${i},,,F,V${i},,`,
    );
    for (const dryRun of [true, false]) {
      let err: any;
      await run(csv(...lines), dryRun).catch((e) => (err = e));
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: API_ERROR_CODES.IMPORT_FAMILY_TOO_MANY_ROWS,
        max: IMPORT_FAMILY_MAX_ROWS,
      });
    }
    expect(productsService.assignToParent).not.toHaveBeenCalled();
  });

  it("an apply with Family columns writes one import.products.applied summary row (counts, fileName, actor); a preview writes none", async () => {
    rows.push(mk({ id: "fam", name: "Acme Cola", kind: "FAMILY" }));
    rows.push(mk({ id: "p1", name: "P1", sku: "S1" }));
    await run(csv(",S1,,,Acme Cola,X,,"), true);
    expect(auditService.log).not.toHaveBeenCalled();
    await run(csv(",S1,,,Acme Cola,X,,"));
    expect(auditService.log).toHaveBeenCalledTimes(1);
    expect(auditService.log.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      userId: "user-1",
      action: "import.products.applied",
      entityType: "Product",
      meta: expect.objectContaining({ fileName: "f.csv", updated: 1, created: 0, skipped: 0 }),
    });
  });

  it("BENCH (orchestration only, fakes for every writer): the 2,500-row cap plans and applies without per-row blow-up", async () => {
    rows.push(mk({ id: "fam", name: "Acme Cola", kind: "FAMILY" }));
    const N = IMPORT_FAMILY_MAX_ROWS;
    for (let i = 0; i < N; i++) rows.push(mk({ id: `b${i}`, name: `Bulk ${i}`, sku: `K${i}` }));
    const file = csv(...Array.from({ length: N }, (_, i) => `,K${i},,,Acme Cola,V${i},,`));
    const t0 = Date.now();
    const r = await run(file);
    const ms = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(
      `family import orchestration: ${N} rows in ${ms} ms = ${(ms / N).toFixed(2)} ms/row (writers faked)`,
    );
    expect(r.updated).toBe(N);
    expect(r.skipped).toBe(0);
    expect(ms / N).toBeLessThan(10);
  }, 120_000);

  it("an apply of a file WITHOUT Family columns also writes one import.products.applied row; a preview none", async () => {
    rows.push(mk({ id: "p1", name: "P1", sku: "S1", pricePerUnit: 5 }));
    const plain = Buffer.from(`Item Name,SKU,Rate
,S1,6
`);
    await service.importProducts(plain, "user-1", { dryRun: true, fileName: "plain.csv" });
    expect(auditService.log).not.toHaveBeenCalled();
    await service.importProducts(plain, "user-1", { fileName: "plain.csv" });
    expect(auditService.log).toHaveBeenCalledTimes(1);
    expect(auditService.log.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      action: "import.products.applied",
      meta: expect.objectContaining({ fileName: "plain.csv", updated: 1, familiesCreated: 0 }),
    });
  });

  describe("Opus fold: MUST-1 a new variant's regulated class is planned the way create() sets it", () => {
    beforeEach(() => {
      trackedCategories.push({ id: "cat-t", name: "Tobacco" });
    });

    it("a legacy tobacco parent: the new variant inherits the parent's class and is created, not skipped", async () => {
      rows.push(
        mk({
          id: "legacy",
          name: "Acme Cola",
          isTobacco: true,
          trackedCategoryId: "cat-t",
        }),
      );
      rows.push(
        mk({
          id: "kid",
          name: "Classic",
          kind: "VARIANT",
          parentProductId: "legacy",
          isTobacco: true,
          trackedCategoryId: "cat-t",
        }),
      );
      const r = await run(csv("Mint,,,6,Acme Cola,Mint,,"));
      expect(r.skipped).toBe(0);
      expect(r.created).toBe(1);
      expect(productsService.create.mock.calls[0][0]).toMatchObject({
        parentProductId: "legacy",
        name: "Mint",
      });
    });

    it("a family container with tobacco members and a Tobacco=Yes cell: create() files it in the Tobacco type, so it joins", async () => {
      rows.push(mk({ id: "fam", name: "Acme Cola", kind: "FAMILY" }));
      rows.push(
        mk({
          id: "kid",
          name: "Classic",
          kind: "VARIANT",
          parentProductId: "fam",
          isTobacco: true,
          trackedCategoryId: "cat-t",
        }),
      );
      const r = await run(csv("Mint,,,6,Acme Cola,Mint,,Yes"));
      expect(r.skipped).toBe(0);
      expect(r.created).toBe(1);
    });

    it("a family container with tobacco members and NO Tobacco cell: create() makes a plain item, so the row is skipped", async () => {
      rows.push(mk({ id: "fam", name: "Acme Cola", kind: "FAMILY" }));
      rows.push(
        mk({
          id: "kid",
          name: "Classic",
          kind: "VARIANT",
          parentProductId: "fam",
          isTobacco: true,
          trackedCategoryId: "cat-t",
        }),
      );
      const r = await run(csv("Mint,,,6,Acme Cola,Mint,,"));
      expect(byRow(r, 1)).toMatchObject({ action: "skip", reason: IMPORT_FAMILY_CLASS_REASON });
    });
  });

  it("SHOULD-1: a failed cleanup remove() is reported as could not be removed, never as deactivated", async () => {
    rows.push(mk({ id: "p1", name: "P1", sku: "S1" }));
    productsService.assignToParent.mockRejectedValue(new BadRequestException("boom"));
    productsService.remove.mockRejectedValue(new Error("db down"));
    const r = await run(csv(",S1,,,Ghost Family,X,,"));
    expect(r.families.deactivated).toEqual([]);
    expect(r.families.cleanupFailed).toEqual([{ name: "Ghost Family" }]);
    expect(r.warnings.join(" ")).toMatch(/could not be removed/);
    expect(r.warnings.join(" ")).not.toMatch(/deactivated/);
  });

  describe("SHOULD-2: the re-run trap", () => {
    it("an INACTIVE, empty, import-created family root is reused (reactivated) by a re-run", async () => {
      rows.push(mk({ id: "old", name: "Ghost Family", kind: "FAMILY", isActive: false }));
      priorAudits.push({ action: "import.family.created", entityId: "old" });
      rows.push(mk({ id: "p1", name: "P1", sku: "S1" }));
      const r = await run(csv(",S1,,,Ghost Family,X,,"));
      expect(r.skipped).toBe(0);
      expect(families.createFamilyContainer).not.toHaveBeenCalled();
      expect(families.reactivateFamilyContainer).toHaveBeenCalledWith("old", "user-1");
      expect(productsService.assignToParent).toHaveBeenCalledWith(
        "p1",
        "old",
        "X",
        expect.anything(),
      );
    });

    it("the preview shows the reuse without writing", async () => {
      rows.push(mk({ id: "old", name: "Ghost Family", kind: "FAMILY", isActive: false }));
      priorAudits.push({ action: "import.family.created", entityId: "old" });
      rows.push(mk({ id: "p1", name: "P1", sku: "S1" }));
      const r = await run(csv(",S1,,,Ghost Family,X,,"), true);
      expect(byRow(r, 1).action).toBe("update");
      expect(families.reactivateFamilyContainer).not.toHaveBeenCalled();
    });

    it("an inactive family that was NOT made by an import, or that has members, still skips", async () => {
      rows.push(mk({ id: "mine", name: "Hand Made", kind: "FAMILY", isActive: false }));
      rows.push(mk({ id: "used", name: "Used Family", kind: "FAMILY", isActive: false }));
      priorAudits.push({ action: "import.family.created", entityId: "used" });
      rows.push(
        mk({ id: "m", name: "M", kind: "VARIANT", parentProductId: "used", isActive: false }),
      );
      rows.push(mk({ id: "p1", name: "P1", sku: "S1" }));
      rows.push(mk({ id: "p2", name: "P2", sku: "S2" }));
      const r = await run(csv(",S1,,,Hand Made,X,,", ",S2,,,Used Family,Y,,"));
      expect(byRow(r, 1).reason).toMatch(/inactive/i);
      expect(byRow(r, 2).reason).toMatch(/inactive/i);
    });

    it("an all-failing reused family is deactivated again", async () => {
      rows.push(mk({ id: "old", name: "Ghost Family", kind: "FAMILY", isActive: false }));
      priorAudits.push({ action: "import.family.created", entityId: "old" });
      rows.push(mk({ id: "p1", name: "P1", sku: "S1" }));
      productsService.assignToParent.mockRejectedValue(new BadRequestException("boom"));
      const r = await run(csv(",S1,,,Ghost Family,X,,"));
      expect(productsService.remove).toHaveBeenCalledWith("old");
      expect(r.families.deactivated).toEqual([{ name: "Ghost Family" }]);
    });
  });

  it("SHOULD-3: a standalone product and a new family with one name in one file are caught in the PREVIEW (second row skips)", async () => {
    rows.push(mk({ id: "p1", name: "P1", sku: "S1" }));
    const file = csv("Acme Cola,SN1,,3,,,,", ",S1,,,Acme Cola,X,,");
    const preview = await run(file, true);
    expect(byRow(preview, 1).action).toBe("create");
    expect(byRow(preview, 2)).toMatchObject({ action: "skip" });
    expect(byRow(preview, 2).reason).toMatch(/row 1/);
    const real = await run(file);
    expect(real.rows.map((p: any) => [p.row, p.action])).toEqual(
      preview.rows.map((p: any) => [p.row, p.action]),
    );
    const reverse = await run(csv(",S1,,,Acme Cola,X,,", "Acme Cola,SN2,,3,,,,"), true);
    expect(byRow(reverse, 2).action).toBe("skip");
  });

  describe("SHOULD-4: an export round trip with Family cells unchanged applies exactly as before", () => {
    beforeEach(() => {
      featureConfig.getEffectiveMode.mockResolvedValue("on");
      rows.push(mk({ id: "fam", name: "Acme Cola", kind: "FAMILY" }));
      rows.push(
        mk({
          id: "v1",
          name: "Zero",
          sku: "S1",
          kind: "VARIANT",
          parentProductId: "fam",
          pricePerUnit: 5,
        }),
      );
    });

    it("by SKU: no 409 under mixed_packs ON, no regroup, a plain price update", async () => {
      const r = await service.importProducts(
        Buffer.from("Item Name,SKU,Rate,Family\nZero,S1,6,acme cola\n"),
        "user-1",
      );
      expect(r.skipped).toBe(0);
      expect(r.updated).toBe(1);
      expect(productsService.assignToParent).not.toHaveBeenCalled();
      expect(productsService.update).toHaveBeenCalledWith(
        "v1",
        { pricePerUnit: 6 },
        expect.anything(),
      );
    });

    it("keyless: the row still updates by name as before", async () => {
      const r = await service.importProducts(
        Buffer.from("Item Name,Rate,Family\nZero,6,Acme Cola\n"),
        "user-1",
      );
      expect(r.skipped).toBe(0);
      expect(productsService.update).toHaveBeenCalledWith(
        "v1",
        { pricePerUnit: 6 },
        expect.anything(),
      );
    });

    it("the row cap does not apply to a round-trip file", async () => {
      for (let i = 0; i < IMPORT_FAMILY_MAX_ROWS + 1; i++) {
        rows.push(
          mk({
            id: `rt${i}`,
            name: `Item ${i}`,
            sku: `RT${i}`,
            kind: "VARIANT",
            parentProductId: "fam",
          }),
        );
      }
      const lines = Array.from(
        { length: IMPORT_FAMILY_MAX_ROWS + 1 },
        (_, i) => `Item ${i},RT${i},Acme Cola`,
      );
      const r = await service.importProducts(
        Buffer.from(["Item Name,SKU,Family", ...lines].join("\n") + "\n"),
        "user-1",
        { dryRun: true },
      );
      expect(r.skipped).toBe(0);
    }, 120_000);

    it("a real regroup in the same file still trips the 409", async () => {
      rows.push(mk({ id: "p9", name: "P9", sku: "S9" }));
      await expect(
        service.importProducts(
          Buffer.from("Item Name,SKU,Family\nZero,S1,Acme Cola\n,S9,Acme Cola\n"),
          "user-1",
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it("SHOULD-5: keyless Family rows are not name-ambiguous: Small under Cola and Small under Juice both apply", async () => {
    rows.push(mk({ id: "cola", name: "Cola", kind: "FAMILY" }));
    rows.push(mk({ id: "juice", name: "Juice", kind: "FAMILY" }));
    const r = await run(csv("Small,,,3,Cola,,,", "Small,,,3,Juice,,,"));
    expect(r.skipped).toBe(0);
    expect(r.created).toBe(2);
  });

  it("SHOULD-9: a new family's category and lowest price come from the rows that are accepted", async () => {
    const r = await service.importProducts(
      Buffer.from(
        [
          "Item Name,SKU,Rate,Category,Family,Variant Name",
          "Alpha,SA1,,Zeta,New Fam,A", // no Rate: a new product needs one, so this row is refused
          "Beta,SB1,2,Beta Cat,New Fam,B",
          "",
        ].join("\n"),
      ),
      "user-1",
    );
    expect(r.created).toBe(1);
    expect(families.createFamilyContainer.mock.calls[0][1]).toMatchObject({
      category: "Beta Cat",
      pricePerUnit: "2.00",
    });
  });

  it("the family import branch calls no productUnit writer and no Prisma write (units v2 stays untouched)", () => {
    const src = readFileSync(join(__dirname, "product-family-import.service.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/\bproductUnit\b/);
    expect(src).not.toMatch(
      /\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
    expect(src).not.toMatch(/\$executeRaw|\$queryRaw/);
  });
});
