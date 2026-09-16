/**
 * M8 scoping (design.md §7): a DRIVER may only quote for the customer of a stop on
 * their OWN currently-IN_PROGRESS run — mirrors orders.service.ts's B309 guard.
 * Pricing math itself is covered exhaustively by inline-returns-pricing.spec.ts;
 * these tests focus on the scoping gate and basic service wiring.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const OPERATOR: JwtPayload = {
  sub: "user-op-1",
  role: "OPERATOR",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "admin",
  status: "ACTIVE",
} as JwtPayload;

const DRIVER: JwtPayload = {
  sub: "user-drv-1",
  role: "DRIVER",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "driver1",
  status: "ACTIVE",
} as JwtPayload;

const CUSTOMER: JwtPayload = {
  sub: "user-cust-1",
  role: "CUSTOMER",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "harbor_cafe",
  status: "ACTIVE",
} as JwtPayload;

describe("InlineReturnsQuoteService — M8 driver scoping", () => {
  let service: InlineReturnsQuoteService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: ReturnType<PrismaService["forTenant"]>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [InlineReturnsQuoteService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(InlineReturnsQuoteService);
    db = prisma.forTenant();
  });

  const dto = { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }] };

  it("Opus fix-round MAJOR: refuses a CUSTOMER caller explicitly, before any DB read (Q5)", async () => {
    await expect(service.quote(dto, CUSTOMER)).rejects.toThrow(ForbiddenException);
    expect(db.customer.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a DRIVER quote with no routeRunStopId", async () => {
    await expect(service.quote(dto, DRIVER)).rejects.toThrow(ForbiddenException);
  });

  it("Opus fix-round MAJOR/B309 parity: refuses a COMPLETED stop", async () => {
    (db.routeRunStop.findFirst as jest.Mock).mockResolvedValue({
      id: "stop-1",
      routeRunId: "run-1",
      customerId: "cust-1",
      status: "COMPLETED",
    });
    await expect(service.quote({ ...dto, routeRunStopId: "stop-1" }, DRIVER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("Opus fix-round MAJOR/B309 parity: refuses a SKIPPED stop", async () => {
    (db.routeRunStop.findFirst as jest.Mock).mockResolvedValue({
      id: "stop-1",
      routeRunId: "run-1",
      customerId: "cust-1",
      status: "SKIPPED",
    });
    await expect(service.quote({ ...dto, routeRunStopId: "stop-1" }, DRIVER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("refuses when the stop belongs to a different customer", async () => {
    (db.routeRunStop.findFirst as jest.Mock).mockResolvedValue({
      id: "stop-1",
      routeRunId: "run-1",
      customerId: "cust-OTHER",
    });
    await expect(service.quote({ ...dto, routeRunStopId: "stop-1" }, DRIVER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("refuses when the run belongs to a different driver", async () => {
    (db.routeRunStop.findFirst as jest.Mock).mockResolvedValue({
      id: "stop-1",
      routeRunId: "run-1",
      customerId: "cust-1",
    });
    (db.driver.findFirst as jest.Mock).mockResolvedValue({ id: "driver-1" });
    (db.routeRun.findFirst as jest.Mock).mockResolvedValue({
      id: "run-1",
      driverId: "driver-OTHER",
      status: "IN_PROGRESS",
    });
    await expect(service.quote({ ...dto, routeRunStopId: "stop-1" }, DRIVER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("refuses when the run is not IN_PROGRESS", async () => {
    (db.routeRunStop.findFirst as jest.Mock).mockResolvedValue({
      id: "stop-1",
      routeRunId: "run-1",
      customerId: "cust-1",
    });
    (db.driver.findFirst as jest.Mock).mockResolvedValue({ id: "driver-1" });
    (db.routeRun.findFirst as jest.Mock).mockResolvedValue({
      id: "run-1",
      driverId: "driver-1",
      status: "COMPLETED",
    });
    await expect(service.quote({ ...dto, routeRunStopId: "stop-1" }, DRIVER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("proceeds past the scoping gate for a driver on their own in-progress stop", async () => {
    (db.routeRunStop.findFirst as jest.Mock).mockResolvedValue({
      id: "stop-1",
      routeRunId: "run-1",
      customerId: "cust-1",
    });
    (db.driver.findFirst as jest.Mock).mockResolvedValue({ id: "driver-1" });
    (db.routeRun.findFirst as jest.Mock).mockResolvedValue({
      id: "run-1",
      driverId: "driver-1",
      status: "IN_PROGRESS",
    });
    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    const result = await service.quote({ ...dto, routeRunStopId: "stop-1" }, DRIVER);
    expect(result.total).toBe(0); // no candidate lines / product in the mock — over-return at $0 tier price
  });

  it("never scopes an OPERATOR caller (no routeRunStopId required)", async () => {
    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    await expect(service.quote(dto, OPERATOR)).resolves.toBeDefined();
    expect(db.routeRunStop.findFirst).not.toHaveBeenCalled();
  });

  it("404s when the customer does not exist", async () => {
    (db.customer.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(service.quote(dto, OPERATOR)).rejects.toThrow(NotFoundException);
  });

  it("Opus fix-round MAJOR: looks up the customer via findFirst (tenant-scoped) with deletedAt: null, never findUnique", async () => {
    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    await service.quote(dto, OPERATOR);
    expect(db.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cust-1", deletedAt: null } }),
    );
    expect(db.customer.findUnique).not.toHaveBeenCalled();
  });
});

describe("InlineReturnsQuoteService — Opus fix-round BLOCKER: the matching/allocation/pricing seam", () => {
  let service: InlineReturnsQuoteService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: ReturnType<PrismaService["forTenant"]>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [InlineReturnsQuoteService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(InlineReturnsQuoteService);
    db = prisma.forTenant();
  });

  it("SERVICE-level oracle: a selling-unit candidate line (qty 2 boxes, upb 12, $48) returning 15 pieces prices at $30.00 end to end (revert $316.00 — the pre-fix seam bug)", async () => {
    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    (db.customerPrice.findMany as jest.Mock).mockResolvedValue([]);
    (db.product.findMany as jest.Mock).mockResolvedValue([
      {
        id: "prod-1",
        pricePerUnit: 24,
        priceTier2: 24,
        priceTier3: 24,
        priceTier4: 24,
        priceTier5: 24,
      },
    ]);
    (db.invoice.findMany as jest.Mock).mockResolvedValue([
      {
        orderId: "order-1",
        subtotal: 48,
        discount: 0,
        taxAmount: 0,
        items: [
          {
            id: "invitem-1",
            orderItemId: "oi-1",
            productId: "prod-1",
            qty: 2, // selling units (boxes) — boxes/pieces both null on this line
            unitPrice: 24,
            subtotal: 48,
            boxes: null,
            pieces: null,
            unitsPerBox: 12,
            promoFreeUnits: null,
            taxRate: 0,
            categoryTaxAmount: 0,
          },
        ],
      },
    ]);
    (db.return.findMany as jest.Mock).mockResolvedValue([]);
    (db.returnItem.findMany as jest.Mock).mockResolvedValue([]);

    // Bare `qty` on a boxed product means SELLING UNITS (boxes) per returnRequestPieces/the
    // DTO's own documented semantics — 15 PIECES must be requested via the explicit
    // boxes/pieces split, matching how a box-split return line is actually submitted. `qty`
    // itself must still satisfy the DTO's @Min(1) as a real request would (boxes/pieces are
    // the override, not a substitute for a valid qty).
    const result = await service.quote(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, boxes: 0, pieces: 15 }] },
      OPERATOR,
    );

    expect(result.total).toBe(30.0);
    expect(result.total).not.toBe(316.0);
  });

  it("re-review fix: an over-cap boxed UNREFERENCED return prices at $24, not $288 (product.unitsPerBox now threaded into the unreferenced-chunk context)", async () => {
    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    (db.customerPrice.findMany as jest.Mock).mockResolvedValue([]);
    (db.product.findMany as jest.Mock).mockResolvedValue([
      {
        id: "prod-1",
        pricePerUnit: 24,
        priceTier2: 24,
        priceTier3: 24,
        priceTier4: 24,
        priceTier5: 24,
        unitsPerBox: 12,
      },
    ]);
    // No invoiced sales at all for this product — every returned piece is unreferenced.
    (db.invoice.findMany as jest.Mock).mockResolvedValue([]);
    (db.return.findMany as jest.Mock).mockResolvedValue([]);
    (db.returnItem.findMany as jest.Mock).mockResolvedValue([]);

    // Over-cap: 12 pieces (one full box) returned with zero remaining supply anywhere —
    // the whole 12 pieces prices as ONE unreferenced chunk. Pre-fix, priceUnreferencedChunk
    // never received unitsPerBox and fell back to unitPrice * pieces = 24 * 12 = $288.
    const result = await service.quote(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, boxes: 0, pieces: 12 }] },
      OPERATOR,
    );

    expect(result.total).toBe(24.0);
    expect(result.total).not.toBe(288.0);
  });

  it("re-review fix: a fully unreferenced return of qty 1 box reads bare qty as ONE BOX via product.unitsPerBox (no matching line at all to fall back on)", async () => {
    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    (db.customerPrice.findMany as jest.Mock).mockResolvedValue([]);
    (db.product.findMany as jest.Mock).mockResolvedValue([
      {
        id: "prod-1",
        pricePerUnit: 24,
        priceTier2: 24,
        priceTier3: 24,
        priceTier4: 24,
        priceTier5: 24,
        unitsPerBox: 12,
      },
    ]);
    (db.invoice.findMany as jest.Mock).mockResolvedValue([]);
    (db.return.findMany as jest.Mock).mockResolvedValue([]);
    (db.returnItem.findMany as jest.Mock).mockResolvedValue([]);

    // Bare qty: 1, no boxes/pieces override, no matching line — returnRequestPieces must
    // fall back to product.unitsPerBox (12) to read this as ONE BOX (12 pieces, $24), not
    // one loose piece ($2).
    const result = await service.quote(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }] },
      OPERATOR,
    );

    expect(result.total).toBe(24.0);
  });

  it("re-review fix: a null-unitsPerBox DRAFT invoice-line snapshot still caps/prices correctly via product.unitsPerBox fallback (2 of 12 pieces -> $8.00)", async () => {
    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    (db.customerPrice.findMany as jest.Mock).mockResolvedValue([]);
    (db.product.findMany as jest.Mock).mockResolvedValue([
      {
        id: "prod-1",
        pricePerUnit: 24,
        priceTier2: 24,
        priceTier3: 24,
        priceTier4: 24,
        priceTier5: 24,
        unitsPerBox: 6,
      },
    ]);
    (db.invoice.findMany as jest.Mock).mockResolvedValue([
      {
        orderId: "order-1",
        subtotal: 48,
        discount: 0,
        taxAmount: 0,
        items: [
          {
            id: "invitem-1",
            orderItemId: "oi-1",
            productId: "prod-1",
            // A selling-unit line (boxes/pieces both null) ALWAYS snapshots unitsPerBox:
            // null on a DRAFT invoice's `update()` (invoices.service.ts:3500 only stores it
            // for a box-split line) — 2 selling units (boxes) at $24/box = $48, box size 6
            // known only on the product (12 total pieces, $4/piece).
            qty: 2,
            unitPrice: 24,
            subtotal: 48,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            promoFreeUnits: null,
            taxRate: 0,
            categoryTaxAmount: 0,
          },
        ],
      },
    ]);
    (db.return.findMany as jest.Mock).mockResolvedValue([]);
    (db.returnItem.findMany as jest.Mock).mockResolvedValue([]);

    // Return 2 pieces of this line. Pre-fix: piecesQty trusted the null snapshot (upb
    // treated as 0), so the cap read as 2 pieces of supply instead of the true 12, and with
    // no unitsPerBox priceMatchedChunk's chunkInLineAxis fell through to chunkPieces itself
    // (2) — the SAME axis as line.qty (2 boxes) — prorating the full line: $48. Fixed: upb
    // resolves to the product's 6, so chunkInLineAxis = 2/6 boxes, prorating 2 of the line's
    // true 12 pieces at $4.00/piece -> $8.00.
    const result = await service.quote(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, boxes: 0, pieces: 2 }] },
      OPERATOR,
    );

    expect(result.total).toBe(8.0);
    expect(result.total).not.toBe(48.0);
  });
});
