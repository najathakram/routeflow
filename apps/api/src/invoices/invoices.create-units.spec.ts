/**
 * units_v1 step 4c-1 — `InvoicesService.create` (a manual invoice) sells a line by a unit of the
 * product's ladder behind `flag.units_v1`; a pack-only request is byte-identical. The line builder
 * is proven in `invoice-unit-line.spec.ts`; this pins the WIRING: what create() reads, refuses and
 * writes. Nest `useMocker` auto-mocks every collaborator this spec does not care about.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { Test } from "@nestjs/testing";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

/** Any collaborator method resolves undefined; `then`/symbols stay undefined (a thenable mock hangs `await`). */
const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

describe("InvoicesService.create — sell a line by a unit (units_v1, 4c-1)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let hasFlag: jest.Mock;
  const scopedUnits = { findMany: jest.fn() };

  // A 24-piece box; a Case of 288 pieces.
  const PRODUCT = {
    id: "p1",
    unit: "Box",
    unitsPerBox: 24,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
  };
  const ladder = [
    {
      productId: "p1",
      label: "Case",
      factorToBase: 288,
      price: "480.00",
      priceTier2: null,
      priceTier3: null,
      priceTier4: null,
      priceTier5: null,
      sortOrder: 0,
    },
  ];
  const created = () => prisma.invoice.create.mock.calls[0][0].data;
  const line = (over: Record<string, unknown> = {}) => ({
    description: "Widget",
    productId: "p1",
    qty: 3,
    unitPrice: 480,
    ...over,
  });
  const create = (items: unknown[]) => service.create({ customerId: "cust-1", items } as never);

  beforeEach(async () => {
    prisma = createMockPrisma();
    hasFlag = jest.fn(async (_t: string, flag: string) => flag === "flag.units_v1");
    const module = await Test.createTestingModule({ providers: [InvoicesService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === EntitlementsService) return { hasFlag };
        return autoMock();
      })
      .compile();
    service = module.get(InvoicesService);
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      isTaxExempt: false,
      deletedAt: null,
    });
    prisma.product.findMany.mockResolvedValue([PRODUCT]);
    scopedUnits.findMany.mockReset().mockResolvedValue(ladder);
    (prisma.forTenant as jest.Mock).mockReturnValue({
      ...(prisma.forTenant as jest.Mock)(),
      productUnit: scopedUnits,
    });
    prisma.invoice.create.mockResolvedValue({ id: "inv-1", items: [], customer: {}, payments: [] });
  });

  it("writes a Case line from the SERVER ladder factor: unit count, base-piece qty, snapshot, typed price", async () => {
    await create([line({ unitLabel: "Case" })]);
    const d = created();
    expect(d.items.create[0]).toMatchObject({
      unitLabel: "Case",
      boxes: 3,
      pieces: 0,
      qty: 864,
      unitsPerBox: 288,
      unitPrice: 480,
      subtotal: 1440,
      tenantId: "test-tenant",
    });
    expect(d.subtotal).toBe(1440);
    // read through the TENANT-SCOPED client, never the raw one
    expect(scopedUnits.findMany.mock.calls[0][0].where).toEqual({ productId: { in: ["p1"] } });
    expect(prisma.productUnit.findMany).not.toHaveBeenCalled();
    expect(hasFlag).toHaveBeenCalledWith("test-tenant", "flag.units_v1");
  });

  it("a mixed invoice keeps its pack line exactly as before next to a unit line", async () => {
    await create([
      line({ qty: 1, boxes: 2, pieces: 6, unitPrice: 24 }),
      line({ unitLabel: "Case" }),
    ]);
    const [pack, unit] = created().items.create;
    expect(pack).toMatchObject({ qty: 54, boxes: 2, pieces: 6, unitsPerBox: 24, subtotal: 54 });
    expect("unitLabel" in pack).toBe(false);
    expect(unit).toMatchObject({ unitLabel: "Case", subtotal: 1440 });
    expect(created().subtotal).toBe(1494);
  });

  it("a pack-only request reads no ladder and never asks for flag.units_v1", async () => {
    await create([line({ qty: 2 })]);
    expect(scopedUnits.findMany).not.toHaveBeenCalled();
    expect(hasFlag).not.toHaveBeenCalledWith(expect.anything(), "flag.units_v1");
    expect("unitLabel" in created().items.create[0]).toBe(false);
  });

  it("the pack's own label (or a blank one) is a plain pack line", async () => {
    await create([
      line({ qty: 1, boxes: 1, unitLabel: "Box" }),
      line({ qty: 1, boxes: 1, unitLabel: " " }),
    ]);
    for (const l of created().items.create) {
      expect("unitLabel" in l).toBe(false);
      expect(l).toMatchObject({ boxes: 1, unitsPerBox: 24 });
    }
  });

  it("a tenant without flag.units_v1 is refused BEFORE any write", async () => {
    hasFlag.mockResolvedValue(false);
    await expect(create([line({ unitLabel: "Case" })])).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  it("an unknown unit, boxes beside a unit, a promo on a unit and a unit on a custom line are 400s that write nothing", async () => {
    for (const items of [
      [line({ unitLabel: "Bogus" })],
      [line({ unitLabel: "Case", boxes: 1 })],
      [line({ unitLabel: "Case", promoFreeUnits: 1 })],
      [line({ unitLabel: "Case", productId: undefined })],
    ]) {
      await expect(create(items)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });
});
