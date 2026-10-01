/**
 * M8 scoping (design.md §7): a DRIVER may only quote for the customer of a stop on
 * their OWN currently-IN_PROGRESS run — mirrors orders.service.ts's B309 guard.
 * Pricing math itself is covered exhaustively by inline-returns-pricing.spec.ts;
 * these tests focus on the scoping gate and basic service wiring.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  creditOverridesOf,
  InlineReturnsQuoteService,
  RETURN_CREDIT_OVERRIDE_ERROR_CODES,
} from "./inline-returns-quote.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

// PR-1c: priceInlineReturn's unreferenced-chunk tax fallback reads the tenant's current
// rate (deferred PR-1b item) via SystemConfigService — 0% here so every pre-existing oracle
// in this file (hand-derived before this reader existed) is unaffected; the fallback itself
// gets its own dedicated tax-rate describe block below.
const ZERO_TAX_SYSTEM_CONFIG = { get: jest.fn().mockResolvedValue(null) };
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { QuoteInlineReturnItemDto } from "./dto/quote-inline-return.dto";

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
      providers: [
        InlineReturnsQuoteService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: ZERO_TAX_SYSTEM_CONFIG },
      ],
    }).compile();
    service = module.get(InlineReturnsQuoteService);
    db = prisma.forTenant();
  });

  const dto = {
    customerId: "cust-1",
    items: [{ productId: "prod-1", qty: 1 } as QuoteInlineReturnItemDto],
  };

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
      providers: [
        InlineReturnsQuoteService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: ZERO_TAX_SYSTEM_CONFIG },
      ],
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
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 1 } as QuoteInlineReturnItemDto],
      },
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

  // SA-101(2)/B3/B765 interim guard: before this fix, `matchingSet.find(l => l.productId
  // === productId)?.unitsPerBox` picked the NEWEST invoice's line and silently applied its
  // pack size — even when an older line (the one the operator actually saw) used a
  // different one. These pin the guard: a genuine conflict refuses with a 409 naming both
  // packs; a single agreed pack still prices normally; an unknown pack on a boxed request
  // refuses rather than silently crediting $0.
  it("SA-101(2): candidate lines packed at 12 AND 4 refuse with a 409 naming both packs, never silently pick the newest", async () => {
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
    // Newest invoice first (issueDate desc is the query's own order — the mock returns them
    // pre-sorted the same way the real orderBy would) — packed at 4; the OLDER invoice (the
    // one an operator's return dialog was actually opened from) is packed at 12.
    (db.invoice.findMany as jest.Mock).mockResolvedValue([
      {
        orderId: "order-newer",
        subtotal: 40,
        discount: 0,
        taxAmount: 0,
        items: [
          {
            id: "invitem-newer",
            orderItemId: "oi-newer",
            productId: "prod-1",
            qty: 10,
            unitPrice: 4,
            subtotal: 40,
            boxes: null,
            pieces: null,
            unitsPerBox: 4,
            promoFreeUnits: null,
            taxRate: 0,
            categoryTaxAmount: 0,
          },
        ],
      },
      {
        orderId: "order-older",
        subtotal: 60,
        discount: 0,
        taxAmount: 0,
        items: [
          {
            id: "invitem-older",
            orderItemId: "oi-older",
            productId: "prod-1",
            qty: 5,
            unitPrice: 12,
            subtotal: 60,
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

    await expect(
      service.quote(
        { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, boxes: 1, pieces: 0 }] },
        OPERATOR,
      ),
    ).rejects.toThrow(ConflictException);
    await expect(
      service.quote(
        { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, boxes: 1, pieces: 0 }] },
        OPERATOR,
      ),
    ).rejects.toThrow(/4, 12/);
  });

  it("SA-101(2): a SINGLE candidate pack (no conflict) still prices normally — the sound case, not over-refused", async () => {
    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    (db.customerPrice.findMany as jest.Mock).mockResolvedValue([]);
    (db.product.findMany as jest.Mock).mockResolvedValue([
      {
        id: "prod-1",
        pricePerUnit: 12,
        priceTier2: 12,
        priceTier3: 12,
        priceTier4: 12,
        priceTier5: 12,
      },
    ]);
    (db.invoice.findMany as jest.Mock).mockResolvedValue([
      {
        orderId: "order-1",
        subtotal: 12,
        discount: 0,
        taxAmount: 0,
        items: [
          {
            id: "invitem-1",
            orderItemId: "oi-1",
            productId: "prod-1",
            qty: 1,
            unitPrice: 12,
            subtotal: 12,
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

    const result = await service.quote(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, boxes: 1, pieces: 0 }] },
      OPERATOR,
    );
    expect(result.total).toBe(12.0);
  });

  describe("SA-159: an unclassifiable prior STANDARD return blocks only its own product", () => {
    const seed = () => {
      (db.customer.findFirst as jest.Mock).mockResolvedValue({
        id: "cust-1",
        pricingTier: 1,
        isTaxExempt: false,
      });
      (db.customerPrice.findMany as jest.Mock).mockResolvedValue([]);
      const prod = (id: string) => ({
        id,
        pricePerUnit: 12,
        priceTier2: 12,
        priceTier3: 12,
        priceTier4: 12,
        priceTier5: 12,
      });
      (db.product.findMany as jest.Mock).mockResolvedValue([prod("prod-1"), prod("prod-2")]);
      const invItem = (id: string, productId: string) => ({
        id,
        orderItemId: `oi-${productId}`,
        productId,
        qty: 1,
        unitPrice: 12,
        subtotal: 12,
        boxes: null,
        pieces: null,
        unitsPerBox: 12,
        promoFreeUnits: null,
        taxRate: 0,
        categoryTaxAmount: 0,
      });
      (db.invoice.findMany as jest.Mock).mockResolvedValue([
        {
          orderId: "order-1",
          subtotal: 24,
          discount: 0,
          taxAmount: 0,
          items: [invItem("ii-1", "prod-1"), invItem("ii-2", "prod-2")],
        },
      ]);
      // prod-1: stored pack, no split, no invoice split => unknown basis; prod-2: a split line => factor 1.
      (db.orderItem.findMany as jest.Mock).mockResolvedValue([
        {
          id: "oi-prod-1",
          productId: "prod-1",
          qty: 1,
          unitsPerBox: 12,
          boxes: null,
          pieces: null,
        },
        { id: "oi-prod-2", productId: "prod-2", qty: 12, unitsPerBox: 12, boxes: 1, pieces: 0 },
      ]);
      (db.invoiceItem.findMany as jest.Mock).mockResolvedValue([]);
      (db.return.findMany as jest.Mock).mockResolvedValue([
        { items: [{ productId: "prod-1", qty: 1 }] },
      ]);
      (db.returnItem.findMany as jest.Mock).mockResolvedValue([]);
    };

    it("quotes the clean product on the same source order", async () => {
      seed();
      const result = await service.quote(
        { customerId: "cust-1", items: [{ productId: "prod-2", qty: 1, boxes: 1, pieces: 0 }] },
        OPERATOR,
      );
      expect(result.total).toBe(12.0);
    });

    it("refuses the unclassifiable product's own line with the reason", async () => {
      seed();
      await expect(
        service.quote(
          { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, boxes: 1, pieces: 0 }] },
          OPERATOR,
        ),
      ).rejects.toMatchObject({ response: { code: "INLINE_RETURN_PRIOR_BASIS_UNKNOWN" } });
    });
  });

  it("SA-101(2): an unknown pack (no candidate lines, no product.unitsPerBox) refuses a BOXED request with a 409 — never silently credits $0", async () => {
    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    (db.customerPrice.findMany as jest.Mock).mockResolvedValue([]);
    (db.product.findMany as jest.Mock).mockResolvedValue([
      {
        id: "prod-1",
        pricePerUnit: 12,
        priceTier2: 12,
        priceTier3: 12,
        priceTier4: 12,
        priceTier5: 12,
      },
    ]);
    // No invoiced sales at all — and the product itself carries no unitsPerBox either.
    (db.invoice.findMany as jest.Mock).mockResolvedValue([]);
    (db.return.findMany as jest.Mock).mockResolvedValue([]);
    (db.returnItem.findMany as jest.Mock).mockResolvedValue([]);

    await expect(
      service.quote(
        { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, boxes: 1, pieces: 0 }] },
        OPERATOR,
      ),
    ).rejects.toThrow(ConflictException);
  });

  // SA-108 regression fix: buildQuoteRequest/buildCaptureRequest ALWAYS send `boxes`
  // explicitly (0 for a non-boxed product — see packages/returns/src/inline-return-state.ts).
  // Before this fix, the unknown-pack guard checked `item.boxes != null`, which is true for
  // EVERY web-dialog request regardless of product — every loose-product return was refused
  // with "pack unknown". The guard must only fire when boxes is an actual positive count.
  it("SA-108 regression: {boxes:0, pieces:5} with an unknown pack is NOT refused — boxes:0 is how a loose product is ALWAYS sent, never a real box count", async () => {
    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    (db.customerPrice.findMany as jest.Mock).mockResolvedValue([]);
    (db.product.findMany as jest.Mock).mockResolvedValue([
      { id: "prod-1", pricePerUnit: 3, priceTier2: 3, priceTier3: 3, priceTier4: 3, priceTier5: 3 },
    ]);
    (db.invoice.findMany as jest.Mock).mockResolvedValue([]);
    (db.return.findMany as jest.Mock).mockResolvedValue([]);
    (db.returnItem.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.quote(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, boxes: 0, pieces: 5 }] },
      OPERATOR,
    );
    expect(result.total).toBe(15.0);
  });

  it("SA-108b: {pieces:5} with NO boxes field at all (not even 0) is also NOT refused with an unknown pack — the same guard, one field shape further", async () => {
    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    (db.customerPrice.findMany as jest.Mock).mockResolvedValue([]);
    (db.product.findMany as jest.Mock).mockResolvedValue([
      { id: "prod-1", pricePerUnit: 3, priceTier2: 3, priceTier3: 3, priceTier4: 3, priceTier5: 3 },
    ]);
    (db.invoice.findMany as jest.Mock).mockResolvedValue([]);
    (db.return.findMany as jest.Mock).mockResolvedValue([]);
    (db.returnItem.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.quote(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 1, pieces: 5 } as QuoteInlineReturnItemDto],
      },
      OPERATOR,
    );
    expect(result.total).toBe(15.0);
  });

  it("SA-101(2): an unknown pack on a BARE qty request (no boxes/pieces given) is NOT refused — qty is already pieces, nothing to convert", async () => {
    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    (db.customerPrice.findMany as jest.Mock).mockResolvedValue([]);
    (db.product.findMany as jest.Mock).mockResolvedValue([
      { id: "prod-1", pricePerUnit: 3, priceTier2: 3, priceTier3: 3, priceTier4: 3, priceTier5: 3 },
    ]);
    (db.invoice.findMany as jest.Mock).mockResolvedValue([]);
    (db.return.findMany as jest.Mock).mockResolvedValue([]);
    (db.returnItem.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.quote(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 5 } as QuoteInlineReturnItemDto],
      },
      OPERATOR,
    );
    expect(result.total).toBe(15.0);
  });

  // SA-107 (review of #1293/B774): fetchMatchingSet's own pack resolution (:370) skipped
  // SA-101(a)'s second step — a box-aware line with a null unitsPerBox snapshot (the DRAFT
  // invoice update() case) fell straight through to the LIVE product pack instead of first
  // recovering its own pack from its stored boxes/pieces/qty split. That live-pack fallback
  // could silently disagree with a properly-snapshotted sibling line and trip the SA-101(2)
  // conflict guard over a repack that never actually affected either line.
  it("SA-107: a null-snapshot line recovers its OWN pack from its boxes/pieces/qty split (12) rather than the live product pack (6) — agrees with a snapshotted sibling, no false conflict", async () => {
    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    (db.customerPrice.findMany as jest.Mock).mockResolvedValue([]);
    (db.product.findMany as jest.Mock).mockResolvedValue([
      {
        id: "prod-1",
        pricePerUnit: 12,
        priceTier2: 12,
        priceTier3: 12,
        priceTier4: 12,
        priceTier5: 12,
        // The product has since been repacked to 6 — the LIVE pack must never win over a
        // line's own recoverable split.
        unitsPerBox: 6,
      },
    ]);
    (db.invoice.findMany as jest.Mock).mockResolvedValue([
      {
        orderId: "order-null-snapshot",
        subtotal: 48,
        discount: 0,
        taxAmount: 0,
        items: [
          {
            id: "invitem-null-snapshot",
            orderItemId: "oi-1",
            productId: "prod-1",
            // A DRAFT invoice's update() stores a boxed line with unitsPerBox: null — but its
            // own split (24 pieces / 2 boxes) still says 12, not the live 6.
            qty: 24,
            unitPrice: 2,
            subtotal: 48,
            boxes: 2,
            pieces: 0,
            unitsPerBox: null,
            promoFreeUnits: null,
            taxRate: 0,
            categoryTaxAmount: 0,
          },
        ],
      },
      {
        orderId: "order-snapshotted",
        subtotal: 24,
        discount: 0,
        taxAmount: 0,
        items: [
          {
            id: "invitem-snapshotted",
            orderItemId: "oi-2",
            productId: "prod-1",
            qty: 1,
            unitPrice: 24,
            subtotal: 24,
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

    // Both lines resolve to pack 12 — no SA-101(2) conflict, quote succeeds normally.
    const result = await service.quote(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, boxes: 1, pieces: 0 }] },
      OPERATOR,
    );
    expect(result.total).toBe(24.0);
  });
});

// PR-1c deferred item (from PR-1b): an unreferenced chunk with NO candidate invoice line at
// all used to fall back to a hand-rolled 0 tax rate — every such chunk was silently zero-taxed
// regardless of the tenant's configured rate. Fixed via the shared currentTaxRate() reader.
describe("InlineReturnsQuoteService — PR-1c: unreferenced-chunk tax fallback reads the tenant's current rate", () => {
  let service: InlineReturnsQuoteService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: ReturnType<PrismaService["forTenant"]>;
  let systemConfig: { get: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    systemConfig = { get: jest.fn().mockResolvedValue("8") }; // 8% tenant rate
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InlineReturnsQuoteService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: systemConfig },
      ],
    }).compile();
    service = module.get(InlineReturnsQuoteService);
    db = prisma.forTenant();

    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    (db.customerPrice.findMany as jest.Mock).mockResolvedValue([]);
    (db.product.findMany as jest.Mock).mockResolvedValue([
      {
        id: "prod-1",
        pricePerUnit: 10,
        priceTier2: 10,
        priceTier3: 10,
        priceTier4: 10,
        priceTier5: 10,
      },
      {
        id: "prod-2",
        pricePerUnit: 20,
        priceTier2: 20,
        priceTier3: 20,
        priceTier4: 20,
        priceTier5: 20,
      },
    ]);
    // NO candidate invoice line at all for this product — every returned piece is the
    // unreferenced (case 3, BASE price) chunk, which is exactly where the fallback fires.
    (db.invoice.findMany as jest.Mock).mockResolvedValue([]);
    (db.return.findMany as jest.Mock).mockResolvedValue([]);
    (db.returnItem.findMany as jest.Mock).mockResolvedValue([]);
  });

  it("prices tax at the tenant's CURRENT 8% rate — $50.00 subtotal, $4.00 tax (revert ⇒ $0.00 tax)", async () => {
    const result = await service.quote(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 5 } as QuoteInlineReturnItemDto],
      },
      OPERATOR,
    );

    expect(result.subtotal).toBe(50.0);
    expect(result.taxAmount).toBe(4.0);
    expect(result.taxAmount).not.toBe(0);
    expect(systemConfig.get).toHaveBeenCalledWith("settings.taxRate");
  });

  it("still charges $0.00 tax for an exempt customer, even with a non-zero tenant rate", async () => {
    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: true,
    });

    const result = await service.quote(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 5 } as QuoteInlineReturnItemDto],
      },
      OPERATOR,
    );

    expect(result.taxAmount).toBe(0);
  });

  it("reads the tenant rate ONCE per quote — not once per item", async () => {
    await service.quote(
      {
        customerId: "cust-1",
        items: [
          { productId: "prod-1", qty: 5 } as QuoteInlineReturnItemDto,
          { productId: "prod-2", qty: 3 } as QuoteInlineReturnItemDto,
        ],
      },
      OPERATOR,
    );
    expect(systemConfig.get).toHaveBeenCalledTimes(1);
  });
});

describe("InlineReturnsQuoteService — #2695 (SA-557): a staff per-line credit price override", () => {
  let service: InlineReturnsQuoteService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: ReturnType<PrismaService["forTenant"]>;

  const TENANT_ADMIN = { ...OPERATOR, sub: "user-ta-1", role: "TENANT_ADMIN" } as JwtPayload;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InlineReturnsQuoteService,
        { provide: PrismaService, useValue: prisma },
        // The tenant's CURRENT rate is 8% — a matched chunk must never be taxed at it.
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("8") } },
      ],
    }).compile();
    service = module.get(InlineReturnsQuoteService);
    db = prisma.forTenant();

    (db.customer.findFirst as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    (db.customerPrice.findMany as jest.Mock).mockResolvedValue([]);
    (db.product.findMany as jest.Mock).mockResolvedValue([
      {
        id: "prod-1",
        name: "Widget",
        pricePerUnit: 6,
        priceTier2: 6,
        priceTier3: 6,
        priceTier4: 6,
        priceTier5: 6,
      },
    ]);
    // 10 pieces sold at $5.00 on a 5% snapshot line, $2.00 excise booked.
    (db.invoice.findMany as jest.Mock).mockResolvedValue([
      {
        orderId: "order-1",
        subtotal: 50,
        discount: 0,
        taxAmount: 2.5,
        items: [
          {
            id: "invitem-1",
            orderItemId: "oi-1",
            productId: "prod-1",
            qty: 10,
            unitPrice: 5,
            subtotal: 50,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            promoFreeUnits: null,
            taxRate: 0.05,
            categoryTaxAmount: 2,
          },
        ],
      },
    ]);
    (db.return.findMany as jest.Mock).mockResolvedValue([]);
    (db.returnItem.findMany as jest.Mock).mockResolvedValue([]);
  });

  const quote = (item: Record<string, unknown>, user: JwtPayload = OPERATOR) =>
    service.quote(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", boxes: 0, pieces: 4, ...item } as any],
      },
      user,
    );
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: any) => ({ status: e?.getStatus?.(), ...(e?.getResponse?.() ?? {}) }),
    );

  it("NEITHER field: today's chunks, byte-identical (PR-1 is a no-op for every existing client)", async () => {
    const result = await quote({});
    expect(JSON.stringify(result.chunks)).toBe(
      JSON.stringify([
        {
          sourceOrderId: "order-1",
          sourceInvoiceItemId: "invitem-1",
          sourceOrderItemId: "oi-1",
          productId: "prod-1",
          pieces: 4,
          subtotal: 20,
          taxAmount: 1,
          categoryTax: 0.8,
          priceSource: "SOURCE_INVOICE",
          unitPrice: 5,
        },
      ]),
    );
    expect(result.total).toBe(21.8);
  });

  it("an override EQUAL to the default is not an override: the same chunks as no override at all", async () => {
    const none = await quote({});
    const equal = await quote({ creditUnitPrice: 5, overrideReason: "same" });
    expect(JSON.stringify(equal)).toBe(JSON.stringify(none));
  });

  it("BELOW the default: the matched chunk re-prices at the override, taxed at the 5% SNAPSHOT (never the tenant's 8%), excise carried", async () => {
    const result = await quote({ creditUnitPrice: 3.5, overrideReason: "  damaged in transit  " });
    expect(result.chunks).toEqual([
      expect.objectContaining({
        sourceInvoiceItemId: "invitem-1",
        pieces: 4,
        subtotal: 14, // 4 x $3.50 (revert: $20.00)
        taxAmount: 0.7, // $14 x 5% snapshot (tenant rate would give $1.12)
        categoryTax: 0.8, // carried
        priceSource: "MANUAL",
        unitPrice: 3.5,
        originalPrice: 5,
        overrideReason: "damaged in transit", // trimmed
        overriddenBy: "user-op-1",
      }),
    ]);
    expect(result.total).toBe(15.5);
  });

  it("a TENANT_ADMIN may override too", async () => {
    const result = await quote({ creditUnitPrice: 4, overrideReason: "goodwill" }, TENANT_ADMIN);
    expect(result.chunks[0]).toMatchObject({ priceSource: "MANUAL", overriddenBy: "user-ta-1" });
  });

  it("ABOVE the default ⇒ 400 RETURN_CREDIT_OVER_CAP naming the cap (no uncapped path)", async () => {
    expect(await refusal(quote({ creditUnitPrice: 5.01, overrideReason: "x" }))).toMatchObject({
      status: 400,
      code: RETURN_CREDIT_OVERRIDE_ERROR_CODES.OVER_CAP,
      defaultUnitPrice: 5,
      creditUnitPrice: 5.01,
    });
  });

  it("the unreferenced (over-return) chunk is capped at ITS default and taxed at the quote rate", async () => {
    // 12 requested, 10 sold: 2 unreferenced pieces at the $6.00 base price, taxed at the quote's
    // fallback rate (the product's candidate line's 5% here; the tenant's rate only with none).
    const result = await quote({ pieces: 12, creditUnitPrice: 4, overrideReason: "x" });
    expect(
      result.chunks.map((c) => [c.priceSource, c.subtotal, c.taxAmount, c.originalPrice]),
    ).toEqual([
      ["MANUAL", 40, 2, 5],
      ["MANUAL", 8, 0.4, 6], // the quote rate: the product's candidate-line 5%, as the default used
    ]);
    // $5.50 is under the $6 unreferenced default but above the $5 matched one: refused.
    expect(
      (await refusal(quote({ pieces: 12, creditUnitPrice: 5.5, overrideReason: "x" })))?.code,
    ).toBe(RETURN_CREDIT_OVERRIDE_ERROR_CODES.OVER_CAP);
  });

  // B961 / SA-071c: an over-return chunk of a product the customer DID buy (a candidate invoice line exists, all of it already
  // returned) is flagged "already returned or credited"; a never-invoiced product's chunk stays "not on any invoice".
  it("B961 (Opus B1): buy 10, return 12 with NOTHING returned before: the 2 extra are the ordinary over-return, NOT flagged", async () => {
    const result = await quote({ pieces: 12 }); // 10 sold on a candidate line, 2 over, no prior return
    const [matched, over] = result.chunks;
    expect(matched).not.toHaveProperty("alreadyReturned");
    expect(over).toMatchObject({ priceSource: "BASE", pieces: 2 });
    expect(over).not.toHaveProperty("alreadyReturned");
  });

  it("B961 (SA-071h): the in-window line carries a PRIOR return (4 of 10 back) and an unreferenced chunk remains (6 matched + 2 over): the over-return IS flagged", async () => {
    (db.returnItem.findMany as jest.Mock).mockResolvedValue([{ productId: "prod-1", qty: 4 }]);
    const result = await quote({ pieces: 8 });
    const [matched, over] = result.chunks;
    expect(matched).toMatchObject({ pieces: 6 });
    expect(matched).not.toHaveProperty("alreadyReturned");
    expect(over).toMatchObject({ pieces: 2, sourceInvoiceItemId: null, alreadyReturned: true });
  });

  describe("SA-071f: the flag uses LIFETIME exhaustion (the 90-day window is for PRICING only)", () => {
    const oldLine = {
      orderId: "order-old",
      subtotal: 50,
      discount: 0,
      taxAmount: 0,
      items: [
        {
          id: "invitem-old",
          orderItemId: "oi-old",
          productId: "prod-1",
          qty: 10,
          unitPrice: 5,
          subtotal: 50,
          boxes: null,
          pieces: null,
          unitsPerBox: null,
          promoFreeUnits: null,
          taxRate: 0,
          categoryTaxAmount: null,
        },
      ],
    };
    /** the standard-return read (kind STANDARD) and the inline read share db.returnItem: answer each with its own rows */
    const returnRows = (rows: unknown[], standard: unknown[] = []) =>
      (db.returnItem.findMany as jest.Mock).mockImplementation(async (args: any) => {
        if (args?.where?.return?.kind === "STANDARD") return standard;
        // honour the order filter (eq or in), like the database: an order must see ONLY its own returns
        const so = args?.where?.sourceOrderId;
        const wanted: string[] | null =
          so == null ? null : typeof so === "string" ? [so] : (so.in ?? null);
        return wanted
          ? (rows as Array<{ sourceOrderId?: string }>).filter(
              (r) => r.sourceOrderId != null && wanted.includes(r.sourceOrderId),
            )
          : rows;
      });
    // inside the 90-day window: nothing; the lifetime read (a window far wider) sees the 120-day-old sale
    const soldLongAgo = () =>
      (db.invoice.findMany as jest.Mock).mockImplementation(async (args: any) => {
        // the PRICING read has an issueDate window (90 days: sees nothing); the lifetime flag read has none
        return args?.where?.issueDate ? [] : [oldLine];
      });

    it("a sale 120 days ago FULLY returned, then an inline return today: the unreferenced chunk is flagged", async () => {
      soldLongAgo();
      returnRows([{ productId: "prod-1", qty: 10, sourceOrderId: "order-old" }]);
      const result = await quote({ pieces: 2 });
      expect(result.chunks).toEqual([
        expect.objectContaining({ sourceInvoiceItemId: null, pieces: 2, alreadyReturned: true }),
      ]);
    });

    it("lead N-a: the lifetime check costs a CONSTANT number of reads however many invoices (orders) the customer has", async () => {
      const manyOld = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          ...oldLine,
          orderId: `order-old-${i}`,
          items: [{ ...oldLine.items[0], id: `invitem-old-${i}` }],
        }));
      const reads = async (n: number) => {
        (db.invoice.findMany as jest.Mock).mockImplementation(async (args: any) => {
          const since: Date | undefined = args?.where?.issueDate?.gte;
          const days = since ? (Date.now() - since.getTime()) / 86_400_000 : 0;
          return days > 200 || !since ? manyOld(n) : [];
        });
        for (const m of [
          db.invoice.findMany,
          db.return.findMany,
          db.returnItem.findMany,
          db.creditNoteItem.findMany,
        ])
          (m as jest.Mock).mockClear();
        returnRows([]);
        await quote({ pieces: 2 });
        return [
          db.invoice.findMany,
          db.return.findMany,
          db.returnItem.findMany,
          db.creditNoteItem.findMany,
        ].map((m) => (m as jest.Mock).mock.calls.length);
      };
      expect(await reads(25)).toEqual(await reads(1));
    });

    it("SA-071h repeat buyer: A (200 days, NEVER returned) + B (30 days, fully refunded), then an inline return of 10: FLAGGED", async () => {
      const lineB = {
        ...oldLine,
        orderId: "order-b",
        items: [{ ...oldLine.items[0], id: "invitem-b" }],
      };
      const lineA = {
        ...oldLine,
        orderId: "order-a",
        items: [{ ...oldLine.items[0], id: "invitem-a" }],
      };
      // the 90-day pricing read sees only B; any wider (lifetime) read, dated or undated, sees A and B
      (db.invoice.findMany as jest.Mock).mockImplementation(async (args: any) => {
        const since: Date | undefined = args?.where?.issueDate?.gte;
        const days = since ? (Date.now() - since.getTime()) / 86_400_000 : Infinity;
        return days > 200 ? [lineA, lineB] : [lineB];
      });
      returnRows([{ productId: "prod-1", qty: 10, sourceOrderId: "order-b" }]); // B fully returned
      const result = await quote({ pieces: 10 });
      expect(result.chunks).toEqual([
        expect.objectContaining({ sourceInvoiceItemId: null, pieces: 10, alreadyReturned: true }),
      ]);
    });

    it("a STANDARD return of the old order counts in pieces through the order's own line factor (a 2-pack x 5 sold = 10 pieces, 5 units returned)", async () => {
      (db.invoice.findMany as jest.Mock).mockImplementation(async (args: any) =>
        args?.where?.issueDate
          ? []
          : [
              {
                ...oldLine,
                items: [{ ...oldLine.items[0], qty: 5, unitsPerBox: 2, boxes: null }],
              },
            ],
      );
      returnRows([], [{ qty: 5, return: { orderId: "order-old" } }]);
      const result = await quote({ pieces: 2 });
      expect(result.chunks[0]).toMatchObject({ alreadyReturned: true });
    });

    it("a sale 120 days ago NOT returned: a legitimate old-purchase return, unflagged", async () => {
      soldLongAgo();
      const result = await quote({ pieces: 2 });
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]).not.toHaveProperty("alreadyReturned");
    });

    it("returned + CREDIT-NOTE-credited together reaching the sold qty flags it (4 returned + 6 credited of 10)", async () => {
      soldLongAgo();
      returnRows([{ productId: "prod-1", qty: 4, sourceOrderId: "order-old" }]);
      (db.creditNoteItem.findMany as jest.Mock).mockResolvedValue([
        { invoiceItemId: "invitem-old", qty: 6, creditNoteId: "cn-manual" },
      ]);
      (db.return.findMany as jest.Mock).mockResolvedValue([]); // cn-manual backs no return
      const result = await quote({ pieces: 2 });
      expect(result.chunks[0]).toMatchObject({ alreadyReturned: true });
    });

    it("a credit note that IS a return's refund is not counted twice (6 returned + a 6-pc refund note of those same returns: 6 of 10 is not exhausted)", async () => {
      soldLongAgo();
      returnRows([{ productId: "prod-1", qty: 6, sourceOrderId: "order-old" }]);
      (db.creditNoteItem.findMany as jest.Mock).mockResolvedValue([
        { invoiceItemId: "invitem-old", qty: 6, creditNoteId: "cn-refund" },
      ]);
      (db.return.findMany as jest.Mock).mockImplementation(async (args: any) =>
        args?.where?.creditNoteId ? [{ creditNoteId: "cn-refund" }] : [],
      );
      const result = await quote({ pieces: 2 });
      expect(result.chunks[0]).not.toHaveProperty("alreadyReturned");
    });
  });

  it("B961: a product that was FULLY returned before (nothing left on its candidate line) flags the whole quantity", async () => {
    // the prior-returned reader counts earlier returns of the product off this source order (here as inline rows)
    (db.returnItem.findMany as jest.Mock).mockResolvedValue([{ productId: "prod-1", qty: 10 }]);
    const result = await quote({ pieces: 2 });
    expect(result.chunks).toEqual([
      expect.objectContaining({ pieces: 2, sourceInvoiceItemId: null, alreadyReturned: true }),
    ]);
  });

  it("B961: a NEVER-invoiced product stays 'not on any invoice' (no flag): today's SA-071(2) behaviour", async () => {
    (db.invoice.findMany as jest.Mock).mockResolvedValue([]);
    const result = await quote({ pieces: 3 });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).not.toHaveProperty("alreadyReturned");
  });

  it("B961: a DRIVER carrying alreadyReturnedReason ⇒ 400 FORBIDDEN, before any read (staff only)", async () => {
    const r = await refusal(
      service.quote(
        {
          customerId: "cust-1",
          routeRunStopId: "stop-1",
          items: [
            { productId: "prod-1", boxes: 0, pieces: 4, alreadyReturnedReason: "customer says so" },
          ] as any,
        },
        DRIVER,
      ),
    );
    expect(r).toMatchObject({ status: 400, code: RETURN_CREDIT_OVERRIDE_ERROR_CODES.FORBIDDEN });
    expect(db.customer.findFirst).not.toHaveBeenCalled();
  });

  it("a DRIVER carrying either field ⇒ 400, before any read (never silently dropped)", async () => {
    for (const item of [
      { creditUnitPrice: 1, overrideReason: "x" },
      { creditUnitPrice: 1 },
      { overrideReason: "x" },
      { creditUnitPrice: null },
    ]) {
      const r = await refusal(
        service.quote(
          {
            customerId: "cust-1",
            routeRunStopId: "stop-1",
            items: [{ productId: "prod-1", boxes: 0, pieces: 4, ...item } as any],
          },
          DRIVER,
        ),
      );
      expect(r).toMatchObject({ status: 400, code: RETURN_CREDIT_OVERRIDE_ERROR_CODES.FORBIDDEN });
    }
    expect(db.driver.findFirst).not.toHaveBeenCalled();
    expect(db.customer.findFirst).not.toHaveBeenCalled();
  });

  it("a CUSTOMER stays the existing 403 (refused before the override check)", async () => {
    await expect(quote({ creditUnitPrice: 1, overrideReason: "x" }, CUSTOMER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("whole-cent prices are accepted even where x*100 is inexact in floats (19.99*100 = 1998.9999999999998)", async () => {
    for (const creditUnitPrice of [19.99, 1.1, 4.35, 0.07, 2.3, 0.29]) {
      const r = await refusal(quote({ creditUnitPrice, overrideReason: "x" }));
      // Accepted past validation: the only refusal left is the lower-only cap ($5.00 default).
      if (creditUnitPrice <= 5) expect(r).toBeNull();
      else expect(r?.code).toBe(RETURN_CREDIT_OVERRIDE_ERROR_CODES.OVER_CAP);
    }
  });

  it("every whole-cent value from $0.00 to $100.00 passes validation (the lead's 10,001-value sweep)", () => {
    const refused: number[] = [];
    for (let cents = 0; cents <= 10000; cents++) {
      const creditUnitPrice = cents / 100;
      try {
        creditOverridesOf(
          [{ productId: "p", boxes: 0, pieces: 1, creditUnitPrice, overrideReason: "x" }],
          OPERATOR,
        );
      } catch {
        refused.push(creditUnitPrice);
      }
    }
    expect(refused).toEqual([]); // 475b41e9 refused 1,146 of them (19.99, 1.10, 4.35, 0.07, …)
  });

  it("SA-557c tripwire: the cents check is the shared isWholeCents — no local `* 100` comparison here", () => {
    const src = readFileSync(join(__dirname, "inline-returns-quote.service.ts"), "utf8");
    expect(src).toContain("isWholeCents(price)");
    expect(src).not.toMatch(/\*\s*100\b/);
  });

  it("a $19.99 override prices as $19.99 (a $25.00 default line)", async () => {
    (db.invoice.findMany as jest.Mock).mockResolvedValue([
      {
        orderId: "order-1",
        subtotal: 250,
        discount: 0,
        taxAmount: 0,
        items: [
          {
            id: "invitem-1",
            orderItemId: "oi-1",
            productId: "prod-1",
            qty: 10,
            unitPrice: 25,
            subtotal: 250,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            promoFreeUnits: null,
            taxRate: 0,
            categoryTaxAmount: null,
          },
        ],
      },
    ]);
    const result = await quote({ creditUnitPrice: 19.99, overrideReason: "x" });
    expect(result.chunks[0]).toMatchObject({
      priceSource: "MANUAL",
      unitPrice: 19.99,
      subtotal: 79.96,
      originalPrice: 25,
    });
  });

  it("sub-cent prices are refused INVALID, before the cap", async () => {
    for (const creditUnitPrice of [1.005, 19.999, 0.001, NaN, Infinity, -0.01]) {
      expect((await refusal(quote({ creditUnitPrice, overrideReason: "x" })))?.code).toBe(
        RETURN_CREDIT_OVERRIDE_ERROR_CODES.INVALID,
      );
    }
  });

  it("a price without a reason, a blank reason, a reason without a price, or a sub-cent price ⇒ 400 INVALID", async () => {
    for (const item of [
      { creditUnitPrice: 3 },
      { creditUnitPrice: 3, overrideReason: "   " },
      { creditUnitPrice: 3, overrideReason: "x".repeat(201) },
      { overrideReason: "why" },
      { creditUnitPrice: 3.001, overrideReason: "why" },
      { creditUnitPrice: -1, overrideReason: "why" },
    ]) {
      expect(await refusal(quote(item))).toMatchObject({
        status: 400,
        code: RETURN_CREDIT_OVERRIDE_ERROR_CODES.INVALID,
      });
    }
    expect(db.customer.findFirst).not.toHaveBeenCalled();
  });
});
