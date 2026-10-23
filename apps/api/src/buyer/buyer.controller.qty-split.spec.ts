/**
 * Row 531 F2 on the BUYER paths: a boxed line that names a `qty` and a `boxes`/`pieces` split that
 * disagree is refused with a coded 400 QTY_SPLIT_MISMATCH BEFORE anything is read for write, locked
 * or saved. `createOrder` covers both its create branch and its fold into an active order (the
 * buyer "merge"); `updateOrderItems` is the buyer edit-lines route.
 */
const withAdvisoryLock = jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
  acquired: true,
  value: await fn(),
}));
jest.mock("../common/db-locks", () => ({
  LockTimeoutError: class LockTimeoutError extends Error {},
  LockUnavailableError: class LockUnavailableError extends Error {},
  withAdvisoryLock: (...a: [unknown, () => Promise<unknown>]) => withAdvisoryLock(...a),
}));

import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
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

const CTX = {
  customerId: "cust-1",
  tenantId: "tenant-xyz",
  tenantSlug: "acme",
  userId: null,
  customer: { id: "cust-1", businessName: "Qty Split Buyer" },
};

describe("row 531 F2: buyer paths refuse a contradictory qty / box split", () => {
  let controller: BuyerController;
  let svc: Record<string, jest.Mock>;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    withAdvisoryLock.mockClear();
    svc = {
      findActiveOrder: jest.fn().mockResolvedValue(null),
      findOrderIdByIdempotencyKey: jest.fn().mockResolvedValue(null),
      replayMergeReconcile: jest.fn(),
      liveTrioByProduct: jest.fn().mockResolvedValue(new Map()),
      updateOrderItems: jest.fn().mockResolvedValue({ id: "ord-1", lineItems: [] }),
      recordIdempotencyKey: jest.fn(),
      applyBuyerMergeHeader: jest.fn(),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "ord-1", customerId: "cust-1", lineItems: [] }),
      findOne: jest.fn().mockResolvedValue({ id: "ord-1", customerId: "cust-1", lineItems: [] }),
    };
    prisma = createMockPrisma();
    prisma.forTenant().product.findMany.mockResolvedValue([
      { id: "boxed", unitsPerBox: 12 },
      { id: "plain", unitsPerBox: null },
    ]);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuyerController],
      providers: [
        oversellReaderOffProvider,
        { provide: BuyerService, useValue: {} },
        { provide: BuyerCatalogService, useValue: {} },
        { provide: BuyerDashboardService, useValue: {} },
        { provide: ReplenishmentService, useValue: {} },
        { provide: ShelfService, useValue: {} },
        { provide: StockAlertService, useValue: {} },
        { provide: PromotionsService, useValue: {} },
        { provide: OrdersService, useValue: svc },
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
          useValue: { run: jest.fn((_id, fn) => fn()), getOrNull: jest.fn().mockReturnValue(null) },
        },
      ],
    }).compile();
    controller = module.get(BuyerController);
  });

  const expectRefusedUntouched = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: "QTY_SPLIT_MISMATCH",
      productIds: ["boxed"],
    });
    // nothing was read for write, locked, created or folded
    expect(svc.create).not.toHaveBeenCalled();
    expect(svc.updateOrderItems).not.toHaveBeenCalled();
    expect(svc.findActiveOrder).not.toHaveBeenCalled();
    expect(withAdvisoryLock).not.toHaveBeenCalled();
    expect(svc.recordIdempotencyKey).not.toHaveBeenCalled();
  };

  describe("createOrder", () => {
    it("the P0 payload {qty 2, boxes 1, pieces 0} on a 12/box product is a coded 400, nothing written", async () => {
      await expectRefusedUntouched(
        controller.createOrder(
          { items: [{ productId: "boxed", qty: 2, boxes: 1, pieces: 0 }] } as any,
          CTX as any,
        ),
      );
    });

    it("also refused with an Idempotency-Key and when it would have folded into an open order", async () => {
      svc.findActiveOrder.mockResolvedValue({ id: "ord-open", lineItems: [] });
      await expectRefusedUntouched(
        controller.createOrder(
          { items: [{ productId: "boxed", qty: 30, boxes: 1, pieces: 0 }] } as any,
          CTX as any,
          "key-1",
        ),
      );
    });

    it("a consistent payload still creates (boxed split, plain qty, and a mix)", async () => {
      await controller.createOrder(
        {
          items: [
            { productId: "boxed", qty: 24, boxes: 2, pieces: 0 },
            { productId: "plain", qty: 3 },
          ],
        } as any,
        CTX as any,
      );
      expect(svc.create).toHaveBeenCalledTimes(1);
    });

    it("a bare qty (no split) is never a mismatch; zero / absent splits are 'not using box entry'", async () => {
      await controller.createOrder(
        {
          items: [
            { productId: "boxed", qty: 2 },
            { productId: "boxed", qty: 2, boxes: 0, pieces: 0 },
          ],
        } as any,
        CTX as any,
      );
      expect(svc.create).toHaveBeenCalledTimes(1);
    });

    it("a product the lookup does not return is not checkable (no pack size) and passes through", async () => {
      await controller.createOrder(
        { items: [{ productId: "unknown", qty: 2, boxes: 1, pieces: 0 }] } as any,
        CTX as any,
      );
      expect(svc.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("updateOrderItems (buyer edit lines)", () => {
    it("a contradictory entry is a coded 400 before the service is called", async () => {
      const err = await controller
        .updateOrderItems(
          "ord-1",
          {
            items: [{ productId: "boxed", orderItemId: "li-1", qty: 2, boxes: 1, pieces: 0 }],
          } as any,
          CTX as any,
        )
        .then(
          () => null,
          (e) => e,
        );
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: "QTY_SPLIT_MISMATCH",
      });
      expect(svc.updateOrderItems).not.toHaveBeenCalled();
    });

    // S3: an entry that names a stored line is checked against THAT line's pack snapshot (what the buyer
    // sees and echoes back), falling back to the live product's pack only when no line is named / found.
    describe("S3: against the stored line's pack", () => {
      const entry = (over: Record<string, unknown>) => ({
        items: [{ productId: "boxed", orderItemId: "li-1", ...over }],
      });
      const asStored = (pack: number | null) =>
        prisma
          .forTenant()
          .orderItem.findMany.mockResolvedValue([{ id: "li-1", unitsPerBox: pack }]);

      it("a pair consistent with the STORED pack (6) passes although the live pack is 12", async () => {
        asStored(6);
        await controller.updateOrderItems(
          "ord-1",
          entry({ qty: 12, boxes: 2, pieces: 0 }) as any,
          CTX as any,
        );
        expect(svc.updateOrderItems).toHaveBeenCalledTimes(1);
      });

      it("a pair that contradicts the STORED pack is a coded 400, nothing written", async () => {
        asStored(6);
        const err = await controller
          .updateOrderItems("ord-1", entry({ qty: 2, boxes: 1, pieces: 0 }) as any, CTX as any)
          .then(
            () => null,
            (e) => e,
          );
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: "QTY_SPLIT_MISMATCH",
        });
        expect(svc.updateOrderItems).not.toHaveBeenCalled();
      });

      it("the stored-line lookup is scoped to THIS order and THIS buyer's customer", async () => {
        asStored(6);
        await controller.updateOrderItems(
          "ord-1",
          entry({ qty: 12, boxes: 2, pieces: 0 }) as any,
          CTX as any,
        );
        expect(prisma.forTenant().orderItem.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              id: { in: ["li-1"] },
              orderId: "ord-1",
              order: { customerId: CTX.customerId },
            }),
          }),
        );
      });

      it("no stored line found (a foreign or unknown id) falls back to the live pack (12)", async () => {
        prisma.forTenant().orderItem.findMany.mockResolvedValue([]);
        const err = await controller
          .updateOrderItems("ord-1", entry({ qty: 12, boxes: 2, pieces: 0 }) as any, CTX as any)
          .then(
            () => null,
            (e) => e,
          );
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: "QTY_SPLIT_MISMATCH",
        });
      });

      it("an old line with no pack snapshot (null) falls back to the live pack", async () => {
        asStored(null);
        await controller.updateOrderItems(
          "ord-1",
          entry({ qty: 24, boxes: 2, pieces: 0 }) as any,
          CTX as any,
        );
        expect(svc.updateOrderItems).toHaveBeenCalledTimes(1);
      });
    });

    it("the usual buyer edit entry ({productId, orderItemId, qty}) is untouched", async () => {
      await controller.updateOrderItems(
        "ord-1",
        { items: [{ productId: "boxed", orderItemId: "li-1", qty: 3 }] } as any,
        CTX as any,
      );
      expect(svc.updateOrderItems).toHaveBeenCalledTimes(1);
    });
  });
});
