/**
 * WS7 (SA-603a) — the importers respect one-ACTIVE-holder-per-code. RED pins (test-first).
 *
 * Premise: deactivating a product releases its codes to retired*, but LEGACY inactive rows may still
 * hold a live sku / barcode / unitSku (no backfill; released lazily, in-txn, on collision, by
 * claimCodes). So every product lookup in import.service.ts must be ACTIVE-ONLY, a retired code never
 * matches, an inactive-only hit is "no match", and every skip/fail carries a reason.
 *
 *   I1-I3  importInvoices line matching (sku -> unitSku -> name), active-only, unlinked + warning
 *   I4-I7  importProducts matching / create / update / collision reasons / names active-only
 *   I8     importInventory: active-only lookups, claimCodes in the create tx, closed-map reasons
 *   I9     a retired code never matches; an import never revives or updates an inactive product
 *   I10    no silent skip (importInventory reasons; importProducts skipped+failed == reasons)
 *   I11    tenant isolation: every lookup goes through prisma.forTenant()
 *   I12    DB-backed: import-code-reuse.db.spec.ts
 *
 * The mocked product table is an in-memory store with a small `where` evaluator, so a missing
 * `isActive: true` filter shows up as a WRONG VALUE (the inactive product is linked / updated),
 * not as a missing call. Reason strings are literals on purpose: this spec must compile against
 * today's code (`./import-reasons` is pinned in import-reasons.spec.ts).
 */
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import { AuditService } from "../audit/audit.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { claimCodes } from "../products/product-code-release";

jest.mock("../products/product-code-release", () => ({
  ...jest.requireActual("../products/product-code-release"),
  claimCodes: jest.fn(),
}));

const SKU_REASON = "SKU is already used by an active item";
const BARCODE_REASON = "Barcode is already used by an active item";
const UNIT_REASON = "Unit code is already used by an active item";
const HOLDER_NAME = "Holder Product Name";

// ── in-memory product table ────────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  unitSku: string | null;
  isActive: boolean;
  retiredSku: string | null;
  retiredBarcode: string | null;
  retiredUnitSku: string | null;
  currentStock: number;
  pricePerUnit: number;
  unit: string;
  parentProductId: string | null;
  unitsPerBox: number | null;
  trackedSubcategoryId: string | null;
  category: string | null;
  [k: string]: unknown;
}

const row = (over: Partial<Row> & { id: string; name: string }): Row => ({
  sku: null,
  barcode: null,
  unitSku: null,
  isActive: true,
  retiredSku: null,
  retiredBarcode: null,
  retiredUnitSku: null,
  currentStock: 0,
  pricePerUnit: 3,
  unit: "unit",
  parentProductId: null,
  unitsPerBox: null,
  trackedSubcategoryId: null,
  category: null,
  ...over,
});

function cond(value: unknown, c: unknown): boolean {
  if (c !== null && typeof c === "object") {
    const o = c as { equals?: string; mode?: string; not?: unknown; in?: unknown[] };
    if (o.equals !== undefined) {
      return o.mode === "insensitive"
        ? typeof value === "string" && value.toLowerCase() === o.equals.toLowerCase()
        : value === o.equals;
    }
    if (o.not !== undefined) return value !== o.not;
    if (o.in) return o.in.includes(value);
    return true;
  }
  return value === c;
}

function matches(r: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (k === "tenantId") return true;
    if (k === "OR") return (v as Array<Record<string, unknown>>).some((w) => matches(r, w));
    if (k === "AND") return (v as Array<Record<string, unknown>>).every((w) => matches(r, w));
    return cond(r[k], v);
  });
}

// ── harness ────────────────────────────────────────────────────────────────────────────────────

describe("WS7 importers: active-only lookups, retired codes, reasons on every skip", () => {
  let service: ImportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let store: Row[];
  let scopedProduct: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
  };
  let productsService: Record<string, jest.Mock>;
  let invoicesCreated: any[];

  beforeEach(async () => {
    store = [];
    prisma = createMockPrisma();
    scopedProduct = {
      findFirst: jest.fn(async (a: any) => store.find((r) => matches(r, a?.where)) ?? null),
      findMany: jest.fn(async (a: any) => {
        const hits = store.filter((r) => matches(r, a?.where));
        return a?.take ? hits.slice(0, a.take) : hits;
      }),
      update: jest.fn(async (a: any) => ({ id: a.where.id, currentStock: 0, barcode: null })),
      create: jest.fn(async () => ({ id: "new-prod", barcode: null, unitsPerBox: null })),
    };
    const scoped: any = { ...prisma, product: scopedProduct };
    (prisma.forTenant as jest.Mock).mockReturnValue(scoped);
    (prisma.tenantTransaction as jest.Mock).mockImplementation(async (fn: any) =>
      fn({
        ...scoped,
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([]),
      }),
    );

    productsService = {
      create: jest.fn().mockResolvedValue({ id: "prod-new" }),
      update: jest.fn().mockResolvedValue({ id: "prod-existing" }),
      emitCatalogBulkChanged: jest.fn(),
      assertCanFlagTobacco: jest.fn().mockResolvedValue(undefined),
      assertMsrpAllowed: jest.fn().mockResolvedValue(undefined),
      assertIdentityAvailable: jest.fn().mockResolvedValue(undefined),
      assertReorderAllowed: jest.fn().mockResolvedValue(undefined),
    };

    // claimCodes stand-in with the real contract: an INACTIVE holder of the code is released
    // (its live code nulled), an ACTIVE holder is a 409 naming it.
    (claimCodes as jest.Mock).mockReset();
    (claimCodes as jest.Mock).mockImplementation(async (_tx: any, input: any) => {
      for (const c of input.codes as Array<{ field: string; value: string }>) {
        const holders = store.filter(
          (r) => r.sku === c.value || r.barcode === c.value || r.unitSku === c.value,
        );
        const active = holders.find((h) => h.isActive);
        if (active) {
          throw new ConflictException({
            code:
              c.field === "barcode" ? API_ERROR_CODES.BARCODE_TAKEN : API_ERROR_CODES.CODE_TAKEN,
            field: c.field,
            message: `${c.field} "${c.value}" is already used by ${HOLDER_NAME}.`,
          });
        }
        for (const h of holders) {
          for (const f of ["sku", "barcode", "unitSku"] as const) {
            if (h[f] === c.value) h[f] = null;
          }
        }
      }
    });

    const mod = await Test.createTestingModule({
      providers: [
        {
          provide: SellingRestrictionsService,
          useValue: {
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
        ImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
        {
          provide: CustomersService,
          useValue: {
            assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
            maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
            update: jest.fn(),
            setCustomerConsent: jest.fn(),
          },
        },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") },
        },
        {
          provide: ExternalRefService,
          useValue: {
            findLocalId: jest.fn().mockResolvedValue(null),
            record: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: ProductsService, useValue: productsService },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = mod.get(ImportService);

    invoicesCreated = [];
    prisma.invoice.findFirst.mockResolvedValue(null);
    prisma.invoice.create.mockImplementation(async (a: any) => {
      invoicesCreated.push(a.data);
      return { id: "inv-new", invoiceNumber: a.data.invoiceNumber };
    });
    prisma.invoicePayment.create.mockResolvedValue({ id: "pay-1" });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", businessName: "Acme Corp" });
  });

  // ── I1-I3: importInvoices line matching ──────────────────────────────────────────────────────

  const INV_HEAD = [
    "Invoice Number",
    "Customer Name",
    "Total",
    "SubTotal",
    "Balance Due",
    "Invoice Status",
    "Item Name",
    "SKU",
    "Quantity",
    "Item Price",
    "Item Total",
  ];
  const invoiceCsv = (over: Record<string, string>) => {
    const base: Record<string, string> = {
      "Invoice Number": "INV-7001",
      "Customer Name": "Acme Corp",
      Total: "10.00",
      SubTotal: "10.00",
      "Balance Due": "10.00",
      "Invoice Status": "Sent",
      "Item Name": "Unmatched Line",
      SKU: "",
      Quantity: "1",
      "Item Price": "10.00",
      "Item Total": "10.00",
    };
    const r = { ...base, ...over };
    return `${INV_HEAD.join(",")}\n${INV_HEAD.map((h) => `"${r[h]}"`).join(",")}`;
  };
  const runInvoice = async (over: Record<string, string>) => {
    const r = await service.importInvoices(Buffer.from(invoiceCsv(over)), "user-1");
    const lines = invoicesCreated[0]?.items?.create ?? [];
    const messages = [...r.errors, ...(((r as any).warnings as string[] | undefined) ?? [])];
    return { r, line: lines[0], messages };
  };

  it("I1: invoice line SKU X held by inactive A (live code) AND active B links B", async () => {
    store.push(row({ id: "A", name: "Old", sku: "X-1", isActive: false }));
    store.push(row({ id: "B", name: "Current", sku: "X-1" }));
    const { r, line } = await runInvoice({ SKU: "X-1" });
    expect(r.imported).toBe(1);
    expect(line.productId).toBe("B");
  });

  it("I2: SKU X held only by inactive A -> line imported UNLINKED with a per-row warning (not A, not dropped)", async () => {
    store.push(row({ id: "A", name: "Old", sku: "X-1", isActive: false }));
    const { r, line, messages } = await runInvoice({ SKU: "X-1" });
    expect(r.imported).toBe(1);
    expect(invoicesCreated[0].items.create).toHaveLength(1);
    expect(line.productId).toBeUndefined();
    expect(line.description).toBe("Unmatched Line");
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("SKU X-1 matches only an inactive item; line not linked"),
      ]),
    );
  });

  it("I3: unitSku held only by inactive A -> unlinked + warning; the name fallback is active-only", async () => {
    store.push(row({ id: "A", name: "Old", unitSku: "U-9", isActive: false }));
    const unit = await runInvoice({ SKU: "U-9" });
    expect(unit.line.productId).toBeUndefined();
    expect(unit.messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("SKU U-9 matches only an inactive item; line not linked"),
      ]),
    );

    invoicesCreated.length = 0;
    store.length = 0;
    store.push(row({ id: "A2", name: "Pickles", isActive: false }));
    const byNameInactive = await runInvoice({ "Item Name": "Pickles" });
    expect(byNameInactive.line.productId).toBeUndefined();

    invoicesCreated.length = 0;
    store.push(row({ id: "B2", name: "Pickles" }));
    const byNameActive = await runInvoice({ "Item Name": "Pickles" });
    expect(byNameActive.line.productId).toBe("B2");
  });

  // ── I4-I7, I9: importProducts ────────────────────────────────────────────────────────────────

  const runProducts = (csv: string, dryRun = false) =>
    service.importProducts(Buffer.from(csv), "user-1", { dryRun });

  it("I4: SKU X held only by inactive A -> NO match: CREATE a new product, never an update of A", async () => {
    store.push(row({ id: "A", name: "Old Name", sku: "X-1", isActive: false }));
    const r = await runProducts("Item Name,SKU,Rate\nNew Name,X-1,5\n");
    expect(productsService.update).not.toHaveBeenCalled();
    expect(productsService.create).toHaveBeenCalledTimes(1);
    expect(productsService.create.mock.calls[0][0]).toMatchObject({ name: "New Name", sku: "X-1" });
    expect(r.created).toBe(1);
    expect(r.updated).toBe(0);
  });

  it("I4: the dry-run preview plan for that row says create", async () => {
    store.push(row({ id: "A", name: "Old Name", sku: "X-1", isActive: false }));
    const r = await runProducts("Item Name,SKU,Rate\nNew Name,X-1,5\n", true);
    expect(r.rows[0]).toMatchObject({ row: 1, action: "create" });
    expect(productsService.create).not.toHaveBeenCalled();
    expect(productsService.assertIdentityAvailable).toHaveBeenCalledTimes(1);
  });

  it("I5: SKU X held by active B -> UPDATE B", async () => {
    store.push(row({ id: "B", name: "Bee", sku: "X-1", pricePerUnit: 3 }));
    const r = await runProducts("Item Name,SKU,Rate\nBee,X-1,5\n");
    expect(productsService.update).toHaveBeenCalledTimes(1);
    expect(productsService.update.mock.calls[0][0]).toBe("B");
    expect(productsService.create).not.toHaveBeenCalled();
    expect(r.updated).toBe(1);
  });

  it("I5: the 'SKU differs from the product matched by barcode' skip still fires", async () => {
    store.push(row({ id: "C", name: "Cee", sku: "OTHER", barcode: "BC-1" }));
    const r = await runProducts("Item Name,SKU,Barcode,Rate\nCee,X-1,BC-1,5\n");
    expect(r.skipped).toBe(1);
    expect(r.skippedRows[0].reason).toContain("SKU differs from the product matched by barcode");
    expect(productsService.update).not.toHaveBeenCalled();
    expect(productsService.create).not.toHaveBeenCalled();
  });

  it("I5: a barcode held only by an inactive product is no match either (create)", async () => {
    store.push(row({ id: "A", name: "Old", barcode: "BC-1", isActive: false }));
    const r = await runProducts("Item Name,Barcode,Rate\nNew,BC-1,5\n");
    expect(productsService.update).not.toHaveBeenCalled();
    expect(r.created).toBe(1);
  });

  const conflictOf = (code: string, field: string) =>
    new ConflictException({
      code,
      field,
      message: `${field} "S-1" is already used by ${HOLDER_NAME}.`,
    });

  it.each([
    ["sku", API_ERROR_CODES.CODE_TAKEN, SKU_REASON],
    ["unitSku", API_ERROR_CODES.CODE_TAKEN, UNIT_REASON],
    ["barcode", API_ERROR_CODES.BARCODE_TAKEN, BARCODE_REASON],
  ])(
    "I6: a create hitting an ACTIVE holder of another %s is skipped with the closed-map reason",
    async (field, code, reason) => {
      productsService.create.mockRejectedValue(conflictOf(code, field));
      const r = await runProducts("Item Name,SKU,Rate\nNew Thing,S-1,5\n");
      expect(r.skipped).toBe(1);
      expect(r.created).toBe(0);
      expect(r.skippedRows[0].reason).toBe(reason);
      expect(r.rows[0]).toMatchObject({ action: "skip", reason });
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain(reason);
      expect(r.errors.join("\n")).not.toContain(HOLDER_NAME);
      expect(r.skippedRows[0].reason).not.toContain(HOLDER_NAME);
    },
  );

  it("I6: an UPDATE hitting an active holder of another code is skipped with the closed-map reason", async () => {
    store.push(row({ id: "B", name: "Bee", sku: "X-1" }));
    productsService.update.mockRejectedValue(conflictOf(API_ERROR_CODES.BARCODE_TAKEN, "barcode"));
    const r = await runProducts("Item Name,SKU,Barcode,Rate\nBee,X-1,BC-9,5\n");
    expect(r.skipped).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.skippedRows[0].reason).toBe(BARCODE_REASON);
    expect(r.errors.join("\n")).not.toContain(HOLDER_NAME);
  });

  it("I6: dry-run (assertIdentityAvailable) gives the same verdict as the real run", async () => {
    productsService.create.mockRejectedValue(conflictOf(API_ERROR_CODES.CODE_TAKEN, "sku"));
    productsService.assertIdentityAvailable.mockRejectedValue(
      conflictOf(API_ERROR_CODES.CODE_TAKEN, "sku"),
    );
    const csv = "Item Name,SKU,Rate\nNew Thing,S-1,5\n";
    const real = await runProducts(csv);
    const preview = await runProducts(csv, true);
    expect(preview.skipped).toBe(real.skipped);
    expect(preview.skippedRows[0].reason).toBe(SKU_REASON);
    expect(preview.skippedRows[0].reason).toBe(real.skippedRows[0].reason);
    expect(preview.rows[0]).toMatchObject({ action: "skip", reason: SKU_REASON });
    expect(preview.errors.join("\n")).not.toContain(HOLDER_NAME);
  });

  it("I6: a raw non-HTTP failure (P2002-like) is a counted skip with the generic reason, never echoed", async () => {
    productsService.create.mockRejectedValue(
      new Error("Unique constraint failed on the fields: (`tenantId`,`sku`)"),
    );
    const r = await runProducts("Item Name,SKU,Rate\nNew Thing,S-1,5\n");
    expect(r.skipped).toBe(1);
    expect(r.skippedRows[0].reason).toBe("import failed");
    expect(r.errors.join("\n")).not.toContain("Unique constraint");
  });

  it("I6: a failed row never stops the file: the next row still imports", async () => {
    productsService.create
      .mockRejectedValueOnce(conflictOf(API_ERROR_CODES.CODE_TAKEN, "sku"))
      .mockResolvedValueOnce({ id: "ok" });
    const r = await runProducts("Item Name,SKU,Rate\nFirst,S-1,5\nSecond,S-2,6\n");
    expect(r.skipped).toBe(1);
    expect(r.created).toBe(1);
  });

  it("I7: a name held only by inactive A -> create (not an update of A)", async () => {
    store.push(row({ id: "A", name: "Pickles", isActive: false }));
    const r = await runProducts("Item Name,Rate\nPickles,5\n");
    expect(productsService.update).not.toHaveBeenCalled();
    expect(r.created).toBe(1);
  });

  it("I7: a name held by active B -> update B, even when an inactive namesake exists (ambiguity counts ACTIVE only)", async () => {
    store.push(row({ id: "A", name: "Pickles", isActive: false }));
    store.push(row({ id: "B", name: "Pickles", pricePerUnit: 3 }));
    const r = await runProducts("Item Name,Rate\nPickles,5\n");
    expect(r.skipped).toBe(0);
    expect(productsService.update).toHaveBeenCalledTimes(1);
    expect(productsService.update.mock.calls[0][0]).toBe("B");
  });

  it("I7: two ACTIVE products with the name are still ambiguous", async () => {
    store.push(row({ id: "B1", name: "Pickles" }));
    store.push(row({ id: "B2", name: "Pickles" }));
    const r = await runProducts("Item Name,Rate\nPickles,5\n");
    expect(r.skipped).toBe(1);
    expect(r.skippedRows[0].reason).toMatch(/ambiguous name/);
    expect(productsService.update).not.toHaveBeenCalled();
    expect(productsService.create).not.toHaveBeenCalled();
  });

  it("I9: a SKU equal to an inactive product's retiredSku is no match: new product, A never touched", async () => {
    store.push(row({ id: "A", name: "Old", sku: null, retiredSku: "X-1", isActive: false }));
    const r = await runProducts("Item Name,SKU,Rate\nFresh,X-1,5\n");
    expect(productsService.update).not.toHaveBeenCalled();
    expect(r.created).toBe(1);
    // The importer must not even ask about retired columns.
    expect(JSON.stringify(scopedProduct.findFirst.mock.calls)).not.toContain("retired");
    expect(JSON.stringify(scopedProduct.findMany.mock.calls)).not.toContain("retired");
  });

  it("I10 (products): skipped + failed rows == rows carrying a reason", async () => {
    store.push(row({ id: "B", name: "Bee", sku: "B-1", pricePerUnit: 3 }));
    productsService.create.mockImplementation(async (dto: any) => {
      if (dto.sku === "BOOM") throw conflictOf(API_ERROR_CODES.CODE_TAKEN, "sku");
      return { id: "ok" };
    });
    const csv =
      "Item Name,SKU,Rate\n" +
      "Good One,G-1,5\n" + // create
      "Bee,B-1,9\n" + // update
      "Rate Bad,R-1,12abc\n" + // bad cell
      ",N-1,5\n" + // blank name
      "Dup,G-1,5\n" + // duplicate of row 1
      "Collide,BOOM,5\n"; // create throws 409
    const r = await runProducts(csv);
    const skipPlans = r.rows.filter((p) => p.action === "skip");
    expect(r.skipped).toBe(skipPlans.length);
    expect(r.skipped).toBe(r.skippedRows.length);
    expect(r.errors).toHaveLength(r.skipped);
    for (const p of skipPlans) expect((p.reason ?? "").length).toBeGreaterThan(0);
    for (const s of r.skippedRows) expect(s.reason.length).toBeGreaterThan(0);
    expect(r.created + r.updated + r.unchanged + r.skipped).toBe(6);
  });

  // ── I8 + I9 + I10: importInventory ───────────────────────────────────────────────────────────

  const runInventory = (csv: string) => service.importInventory(Buffer.from(csv), "user-1");

  it("I8: X held only by inactive A -> CREATE a new product with an opening movement; claimCodes runs in the create tx", async () => {
    store.push(row({ id: "A", name: "Old", sku: "X-1", barcode: "X-1", isActive: false }));
    const r = await runInventory("Item Name,SKU,Closing Stock\nFresh Widget,X-1,10\n");
    expect(scopedProduct.update).not.toHaveBeenCalled();
    expect(r.updated).toBe(0);
    expect(r.created).toBe(1);
    expect(scopedProduct.create).toHaveBeenCalledTimes(1);
    expect(claimCodes).toHaveBeenCalledTimes(1);
    const claim = (claimCodes as jest.Mock).mock.calls[0][1];
    expect(claim.tenantId).toBe("test-tenant");
    expect(claim.codes).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "barcode", value: "X-1" })]),
    );
    const movement = prisma.stockMovement.create.mock.calls[0][0].data;
    expect(movement).toMatchObject({ productId: "new-prod", type: "PURCHASE", quantity: 10 });
  });

  it("I8: X held by an ACTIVE product -> that product's stock is updated (active match), no create", async () => {
    store.push(row({ id: "B", name: "Bee", sku: "X-1", currentStock: 2 }));
    const r = await runInventory("Item Name,SKU,Closing Stock\nBee,X-1,10\n");
    expect(r.updated).toBe(1);
    expect(r.created).toBe(0);
    expect(scopedProduct.update.mock.calls[0][0].where.id).toBe("B");
  });

  it("I8: an active holder of another code -> that row is in errors with the closed-map reason and the import continues", async () => {
    store.push(row({ id: "H", name: HOLDER_NAME, unitSku: "Y-1" }));
    const r = await runInventory(
      "Item Name,SKU,Closing Stock\nWidget Two,Y-1,5\nWidget Three,Z-1,7\n",
    );
    expect(r.skipped).toBe(1);
    expect(r.created).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("Widget Two");
    expect(r.errors[0]).toContain(BARCODE_REASON);
    expect(r.errors.join("\n")).not.toContain(HOLDER_NAME);
  });

  it("I8: the NAME lookup is active-only (a name on inactive A only -> create)", async () => {
    store.push(row({ id: "A", name: "Widget", isActive: false }));
    const r = await runInventory("Item Name,Closing Stock\nWidget,4\n");
    expect(scopedProduct.update).not.toHaveBeenCalled();
    expect(r.created).toBe(1);
  });

  it("I9: an inventory SKU equal to an inactive product's retiredSku is no match: new product", async () => {
    store.push(row({ id: "A", name: "Old", retiredSku: "X-1", isActive: false }));
    const r = await runInventory("Item Name,SKU,Closing Stock\nBrand New,X-1,3\n");
    expect(scopedProduct.update).not.toHaveBeenCalled();
    expect(r.created).toBe(1);
    expect(JSON.stringify(scopedProduct.findFirst.mock.calls)).not.toContain("retired");
  });

  it("I10 (inventory): every skip pushes a reason into errors; skipped counts stay as today", async () => {
    const csv =
      "Item Name,SKU,Closing Stock\n" +
      ",S-1,5\n" + // 1 blank name
      'Comma Sku,"1,234",5\n' + // 2 comma-formatted SKU
      "Nan Stock,N-1,abc\n" + // 3 NaN closing stock
      "Purchase Invoice,,100\n" + // 4 summary row
      "Good Row,G-1,5\n"; // 5 ok
    const r = await runInventory(csv);
    expect(r.skipped).toBe(4);
    expect(r.created).toBe(1);
    expect(r.errors).toHaveLength(4);
    expect(r.errors[0]).toBe("row 1: blank name");
    expect(r.errors[1]).toMatch(/^row 2: .{5,}/);
    expect(r.errors[2]).toMatch(/^row 3: .{5,}/);
    expect(r.errors[3]).toMatch(/^row 4: .{5,}/);
  });

  // ── I11: tenant isolation ────────────────────────────────────────────────────────────────────

  it("I11: every product lookup goes through prisma.forTenant(), never the bare delegate", async () => {
    store.push(row({ id: "B", name: "Bee", sku: "X-1" }));
    await runInvoice({ SKU: "X-1" });
    await runProducts("Item Name,SKU,Barcode,Rate\nBee,X-1,BC-1,5\nNew,N-1,,5\n");
    await runInventory("Item Name,SKU,Closing Stock\nBee,X-1,9\n");
    expect(prisma.forTenant).toHaveBeenCalled();
    expect(scopedProduct.findFirst).toHaveBeenCalled();
    expect(scopedProduct.findMany).toHaveBeenCalled();
    expect(prisma.product.findFirst).not.toHaveBeenCalled();
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });
});
