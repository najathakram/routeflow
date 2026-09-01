/**
 * F06 campaign — TP3: buyer merge controller wiring (REG-B47 / REG-B78).
 *
 * `BuyerController.createOrder`'s merge branch (an existing active DRAFT/PENDING
 * order + a new cart) is exercised with a mocked `OrdersService` + `PrismaService`.
 * Proves:
 *   - REG-B47 (T14 companion): the merge folds the existing + incoming lines
 *     through the denomination-aware fold (never a naive qty sum) and hands
 *     `updateOrderItems` an explicit `replaceAll: true` payload with unlisted
 *     (catalog-free) lines filtered out — the server preserves those in place.
 *   - REG-B78 (T14): the merge forwards notes/urgent/requestedDeliveryDate onto
 *     the winning order via `OrdersService.applyBuyerMergeHeader`, called BEFORE
 *     the sibling-order sweep (`mergeAllPendingForCustomer`) so the header lands
 *     on the order that survives.
 *   - T16 (pin — green pre-fix): the fresh-create branch (no active order) is
 *     untouched by this campaign — regression pin, not a bug fix.
 *
 * Module setup copied from `./buyer.controller.spec.ts`. Written before WP2/WP3
 * exist: `OrdersService.applyBuyerMergeHeader` does not exist on the real class
 * yet, but `OrdersService` is fully mocked here (`useValue`), so referencing it
 * on the mock is safe — its absence surfaces as an unmet call-count assertion,
 * never a TypeError.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { BuyerController } from "./buyer.controller";
import { BuyerService } from "./buyer.service";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { ReplenishmentService } from "./replenishment.service";
import { ShelfService } from "./shelf.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { PromotionsService } from "../promotions/promotions.service";
import { OrdersService } from "../orders/orders.service";
import { ChangeRequestsService } from "../orders/change-requests.service";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { StatementService } from "./statement.service";
import { StatementPdfService } from "./statement-pdf.service";
import { CustomersService } from "../customers/customers.service";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { AuthorizationsService } from "../authorizations/authorizations.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { createMockPrisma } from "../testing/prisma-mock";

const MOCK_CTX = {
  customerId: "cust-merge-1",
  tenantId: "tenant-xyz",
  tenantSlug: "acme",
  userId: null, // buyer-portal-only account — no operator-portal user
  customer: { id: "cust-merge-1", businessName: "Merge Test Buyer" },
};

describe("BuyerController.createOrder merge branch (TP3 / REG-B47 / REG-B78)", () => {
  let controller: BuyerController;
  let ordersService: {
    findActiveOrder: jest.Mock;
    updateOrderItems: jest.Mock;
    applyBuyerMergeHeader: jest.Mock;
    mergeAllPendingForCustomer: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
  };
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    ordersService = {
      findActiveOrder: jest.fn().mockResolvedValue(null),
      updateOrderItems: jest.fn().mockResolvedValue(undefined),
      applyBuyerMergeHeader: jest.fn().mockResolvedValue(undefined),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "order-fresh" }),
      findOne: jest.fn().mockResolvedValue({ id: "order-merged" }),
    };
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuyerController],
      providers: [
        { provide: BuyerService, useValue: {} },
        { provide: BuyerCatalogService, useValue: {} },
        { provide: BuyerDashboardService, useValue: {} },
        { provide: ReplenishmentService, useValue: {} },
        { provide: ShelfService, useValue: {} },
        { provide: StockAlertService, useValue: {} },
        { provide: PromotionsService, useValue: {} },
        { provide: OrdersService, useValue: ordersService },
        { provide: ChangeRequestsService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
        { provide: InvoicePdfService, useValue: {} },
        { provide: StatementService, useValue: {} },
        { provide: StatementPdfService, useValue: {} },
        { provide: CustomersService, useValue: {} },
        { provide: OrderTemplatesService, useValue: {} },
        { provide: AuthorizationsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: {} },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((id, fn) => fn()), getOrNull: jest.fn().mockReturnValue(null) },
        },
      ],
    }).compile();

    controller = module.get<BuyerController>(BuyerController);
  });

  // ─── REG-B47 (T14 companion): denomination-aware fold, replaceAll, no unlisted ──

  it("REG-B47 (T14 companion): merges a box-unaware existing line + boxed incoming add into a single {qty:36, boxes:3, pieces:0} line, replaceAll:true, no unlisted entries — never the naive qty sum", async () => {
    // Register scenario (T2): existing line states qty in SELLING UNITS (boxes
    // null/unaware) for a boxed product (upb 12) — 2 boxes worth. Buyer adds 1
    // more box. Naive qty summing gives 2+12=14 (today); the fix must fold
    // denominations: 2 boxes + 1 box = 3 boxes = 36 pieces.
    const activeOrder = {
      id: "order-active-1",
      customerId: MOCK_CTX.customerId,
      lineItems: [
        {
          id: "li-boxed",
          productId: "prod-boxed",
          qty: 2,
          boxes: null,
          pieces: null,
          unitPrice: 10.0,
          name: null,
        },
        // Operator-added unlisted line — must NOT reappear in the buyer's
        // merge payload; the server now preserves it in place (B51).
        {
          id: "li-unlisted",
          productId: null,
          qty: 1,
          boxes: null,
          pieces: null,
          unitPrice: 25.0,
          name: "Setup fee",
        },
      ],
    };
    ordersService.findActiveOrder.mockResolvedValue(activeOrder);
    prisma.forTenant().product.findMany.mockResolvedValue([{ id: "prod-boxed", unitsPerBox: 12 }]);

    const dto = { items: [{ productId: "prod-boxed", qty: 12, boxes: 1 }] };

    await controller.createOrder(dto as any, MOCK_CTX as any);

    expect(ordersService.updateOrderItems).toHaveBeenCalledTimes(1);
    const [orderId, updateDto] = ordersService.updateOrderItems.mock.calls[0];
    expect(orderId).toBe(activeOrder.id);
    expect(updateDto).toMatchObject({
      replaceAll: true,
      items: [{ productId: "prod-boxed", qty: 36, boxes: 3, pieces: 0 }],
    });
  });

  it("REG-B47 (T14 companion): a BARE-qty incoming add folds against the stored line in SELLING UNITS — 2 + 2 = a plain qty 4, never 2 boxes + 2 loose pieces", async () => {
    // The other half of the denomination convention. `foldMergeItems` reads a bare
    // incoming `{productId, qty}` as loose PIECES (right for the staff scan path),
    // but every BUYER client states a bare qty in SELLING UNITS — create() stores
    // it box-unaware and bills qty x the BOX price, and the mobile Reorder builder
    // copies a box-unaware past line forward as exactly this shape. Normalizing the
    // stored side alone would fold 2 selling units + a bare 2 into {qty:26, boxes:2,
    // pieces:2} and bill $21.67 where the buyer ordered 4 boxes ($40).
    const activeOrder = {
      id: "order-active-bare",
      customerId: MOCK_CTX.customerId,
      lineItems: [
        {
          id: "li-boxed-unaware",
          productId: "prod-boxed",
          qty: 2,
          boxes: null,
          pieces: null,
          unitPrice: 10.0,
          name: null,
        },
      ],
    };
    ordersService.findActiveOrder.mockResolvedValue(activeOrder);
    // A live unitsPerBox IS available — the point is that it must not be applied
    // to a line whose incoming counterpart carries no split of its own.
    prisma.forTenant().product.findMany.mockResolvedValue([{ id: "prod-boxed", unitsPerBox: 12 }]);

    const dto = { items: [{ productId: "prod-boxed", qty: 2 }] };

    await controller.createOrder(dto as any, MOCK_CTX as any);

    const [, updateDto] = ordersService.updateOrderItems.mock.calls[0];
    // toEqual, not toMatchObject: a boxes/pieces key appearing here at all is the
    // bug — it flips the line into box-split denomination server-side.
    expect(updateDto.items).toEqual([{ productId: "prod-boxed", qty: 4 }]);
  });

  it("REG-B47 (T14 companion): a BARE-qty incoming add against a box-SPLIT stored line expands to boxes — 2 boxes + 2 = {qty:48, boxes:4}, never {qty:26, boxes:2, pieces:2}", async () => {
    // The other stored shape. A box-split line's fold accumulator is in PIECES, so
    // the bare buyer qty (SELLING UNITS) does NOT agree with it — the incoming side
    // must be expanded instead. Reachable today: the buyer taps Reorder on an older
    // order whose line was box-unaware, so mobile buildReorderItems emits a bare
    // {productId, qty} while the active order already carries a cart-added split.
    // Folding it as loose pieces bills 2 + 2/12 boxes ($21.67) for 4 boxes ($40).
    const activeOrder = {
      id: "order-active-split",
      customerId: MOCK_CTX.customerId,
      lineItems: [
        {
          id: "li-boxed-split",
          productId: "prod-boxed",
          qty: 24,
          boxes: 2,
          pieces: 0,
          unitsPerBox: 12,
          unitPrice: 10.0,
          priceType: "STANDARD",
          name: null,
        },
      ],
    };
    ordersService.findActiveOrder.mockResolvedValue(activeOrder);
    prisma.forTenant().product.findMany.mockResolvedValue([{ id: "prod-boxed", unitsPerBox: 12 }]);

    const dto = { items: [{ productId: "prod-boxed", qty: 2 }] };

    await controller.createOrder(dto as any, MOCK_CTX as any);

    const [, updateDto] = ordersService.updateOrderItems.mock.calls[0];
    expect(updateDto.items).toEqual([{ productId: "prod-boxed", qty: 48, boxes: 4, pieces: 0 }]);
  });

  // ─── REG-B78 (T14): header fields forwarded, ordered before the sibling sweep ──

  it("REG-B78 (T14): applies notes/urgent/requestedDeliveryDate via applyBuyerMergeHeader on the winning order, BEFORE mergeAllPendingForCustomer", async () => {
    const activeOrder = {
      id: "order-active-2",
      customerId: MOCK_CTX.customerId,
      lineItems: [
        {
          id: "li-plain",
          productId: "prod-plain",
          qty: 3,
          boxes: null,
          pieces: null,
          unitPrice: 5,
        },
      ],
    };
    ordersService.findActiveOrder.mockResolvedValue(activeOrder);
    prisma.forTenant().product.findMany.mockResolvedValue([{ id: "prod-plain", unitsPerBox: 1 }]);

    const dto = {
      items: [{ productId: "prod-plain", qty: 2 }],
      notes: "ring bell",
      urgent: true,
      requestedDeliveryDate: "2026-09-05",
    };

    await controller.createOrder(dto as any, MOCK_CTX as any);

    // Fails today: the merge branch forwards only {items} — applyBuyerMergeHeader
    // is never called (method absent pre-implementation; the mock records 0 calls).
    expect(ordersService.applyBuyerMergeHeader).toHaveBeenCalledTimes(1);
    expect(ordersService.applyBuyerMergeHeader).toHaveBeenCalledWith(
      activeOrder.id,
      { notes: "ring bell", urgent: true, requestedDeliveryDate: "2026-09-05" },
      expect.any(Object),
    );

    // Ordering: the header must land BEFORE the sibling-order sweep so it
    // survives on whichever order mergeAllPendingForCustomer keeps as winner.
    const headerCallOrder = ordersService.applyBuyerMergeHeader.mock.invocationCallOrder[0];
    const sweepCallOrder = ordersService.mergeAllPendingForCustomer.mock.invocationCallOrder[0];
    expect(headerCallOrder).toBeLessThan(sweepCallOrder);
  });

  // OrdersService is mocked wholesale here, so nothing below this line can say
  // anything about what the helper DOES with the header — the only-sets-true /
  // notes-append / date-set rules are proven against the real method in
  // `../orders/orders.update-items-guards.spec.ts` ("applyBuyerMergeHeader —
  // merge semantics + ownership (T14 / REG-B78)").
  it("REG-B78 (T14): urgent:false passes through to applyBuyerMergeHeader verbatim — the controller forwards, the helper alone owns only-sets-true semantics", async () => {
    const activeOrder = {
      id: "order-active-3",
      customerId: MOCK_CTX.customerId,
      lineItems: [] as Array<Record<string, unknown>>,
    };
    ordersService.findActiveOrder.mockResolvedValue(activeOrder);

    const dto = { items: [{ productId: "prod-y", qty: 1 }], urgent: false };

    await controller.createOrder(dto as any, MOCK_CTX as any);

    expect(ordersService.applyBuyerMergeHeader).toHaveBeenCalledWith(
      activeOrder.id,
      expect.objectContaining({ urgent: false }),
      expect.any(Object),
    );
  });

  // ─── T16 (pin — green pre-fix): fresh-create branch is out of scope ──────────

  describe("T16 (pin — green pre-fix)", () => {
    it("no active order: ordersService.create is called with today's dto mapping (items+notes+urgent+requestedDeliveryDate+status)", async () => {
      ordersService.findActiveOrder.mockResolvedValue(null);
      const createdOrder = { id: "order-fresh-1" };
      ordersService.create.mockResolvedValue(createdOrder);
      ordersService.mergeAllPendingForCustomer.mockResolvedValue(null);

      const dto = {
        items: [{ productId: "prod-z", qty: 4, boxes: 1, pieces: 0, notes: "case" }],
        notes: "fresh order notes",
        urgent: true,
        requestedDeliveryDate: "2026-09-10",
        status: "PENDING",
      };

      const result = await controller.createOrder(dto as any, MOCK_CTX as any);

      expect(ordersService.create).toHaveBeenCalledTimes(1);
      const [createArg, user] = ordersService.create.mock.calls[0];
      expect(createArg).toEqual({
        items: [{ productId: "prod-z", qty: 4, boxes: 1, pieces: 0, notes: "case" }],
        notes: "fresh order notes",
        urgent: true,
        requestedDeliveryDate: "2026-09-10",
        status: "PENDING",
      });
      expect(user.role).toBe(UserRole.CUSTOMER);
      expect(result).toEqual(createdOrder);
    });
  });
});
