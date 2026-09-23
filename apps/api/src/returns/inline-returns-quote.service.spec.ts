/**
 * M8 scoping (design.md §7): a DRIVER may only quote for the customer of a stop on
 * their OWN currently-IN_PROGRESS run — mirrors orders.service.ts's B309 guard.
 * Pricing math itself is covered exhaustively by inline-returns-pricing.spec.ts;
 * these tests focus on the scoping gate and basic service wiring.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

// PR-1c: priceInlineReturn's unreferenced-chunk tax fallback reads the tenant's current
// rate (deferred PR-1b item) via SystemConfigService — 0% here so every pre-existing oracle
// in this file (hand-derived before this reader existed) is unaffected; the fallback itself
// gets its own dedicated tax-rate describe block below.
const ZERO_TAX_SYSTEM_CONFIG = { get: jest.fn().mockResolvedValue(null) };
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
      providers: [
        InlineReturnsQuoteService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: ZERO_TAX_SYSTEM_CONFIG },
      ],
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
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 5 }] },
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
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 5 }] },
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
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 5 }] },
      OPERATOR,
    );

    expect(result.taxAmount).toBe(0);
  });

  it("reads the tenant rate ONCE per quote — not once per item", async () => {
    await service.quote(
      {
        customerId: "cust-1",
        items: [
          { productId: "prod-1", qty: 5 },
          { productId: "prod-2", qty: 3 },
        ],
      },
      OPERATOR,
    );
    expect(systemConfig.get).toHaveBeenCalledTimes(1);
  });
});
