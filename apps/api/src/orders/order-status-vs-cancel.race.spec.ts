// SA-434: ownership is pinned in driver-edit-access*.spec.ts; this spec is about the status write.
jest.mock("./driver-edit-access", () => ({
  ...jest.requireActual("./driver-edit-access"),
  assertDriverMayEditOrder: jest.fn(),
}));
// Mock InvoicesService / NotificationsService before they are imported: they pull ESM-only modules
// (@react-pdf/renderer, expo-server-sdk) that Jest's CommonJS transform cannot parse.
jest.mock("../invoices/invoices.service", () => ({ InvoicesService: jest.fn() }));
jest.mock("../notifications/notifications.service", () => ({ NotificationsService: jest.fn() }));
// The delivered-invoice settle is observed, not run: a lost CAS must never reach it.
jest.mock("./order-status-invoicing", () => ({
  ...jest.requireActual("./order-status-invoicing"),
  settleOrderInvoice: jest.fn().mockResolvedValue(undefined),
}));

import { oversellReaderOffProvider } from "./testing/policy-reader-provider";
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { OrdersService } from "./orders.service";
import { settleOrderInvoice } from "./order-status-invoicing";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";

/**
 * B1095 — a status change racing a cancel.
 *
 * `changeStatus` validates the transition against an UNLOCKED pre-read, and the generic transitions
 * (PENDING -> CONFIRMED, CONFIRMED -> OUT_FOR_DELIVERY, ...) then wrote the new status with a plain
 * `update({ where: { id } })`. A cancel that committed between the read and the write (it voids the
 * invoices and returns the stock) was silently overwritten: the order came back to life as
 * OUT_FOR_DELIVERY with its invoices VOID and its stock already credited back.
 *
 * The fix is a compare-and-set on the status the transition was validated against. The mirror half
 * (the cancel losing to a status change that committed first) is already a compare-and-set on the
 * cancellable set under the Order lock (SA-404f F2, order-cancel-cas.spec.ts; #3219 S5 for the carrier
 * in-transit case), so it is not re-pinned here.
 *
 * The interleaving is modelled at mock level: a one-row "table" whose status is flipped to CANCELLED
 * the moment the pre-read returns, and an `order.update` that honours a `status` in its `where` the way
 * Postgres does (no match => Prisma P2025). A real two-connection race needs Postgres (Mac mini lane).
 */
describe("B1095 — changeStatus vs a cancel that commits between the read and the write", () => {
  const operator = { sub: "u-op", username: "op", role: "OPERATOR", tenantId: "t-1" } as never;
  const ORDER = {
    id: "ord-1",
    customerId: "cust-1",
    tenantId: "t-1",
    orderNumber: "ORD-1",
    status: "CONFIRMED",
    total: 50,
    routeRunId: null,
    routeRunStopId: null,
    customer: { businessName: "Acme" },
    lineItems: [],
  };

  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let gateway: { emitOrderStatusChanged: jest.Mock; [k: string]: jest.Mock };
  let row: { status: string };

  /** The pre-read: hands back the order as the status change saw it, THEN the racing cancel commits. */
  const arrange = (from: string, cancelCommitsAfterRead: boolean) => {
    row = { status: from };
    prisma.order.findUnique.mockImplementation(async () => {
      const seen = { ...ORDER, status: row.status };
      if (cancelCommitsAfterRead) row.status = "CANCELLED";
      return seen;
    });
    prisma.order.update.mockImplementation(async (args: any) => {
      if (args.where.status !== undefined && args.where.status !== row.status) {
        throw new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
          code: "P2025",
          clientVersion: "test",
        });
      }
      row.status = args.data.status;
      return { ...ORDER, ...args.data };
    });
  };

  beforeEach(async () => {
    (settleOrderInvoice as jest.Mock).mockClear();
    prisma = createMockPrisma();
    const perm = () =>
      new Proxy(
        {},
        {
          get: (_t, k) =>
            k === "then" || typeof k === "symbol"
              ? undefined
              : jest.fn().mockResolvedValue(undefined),
        },
      );
    gateway = { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() } as never;
    const module = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrdersService,
        {
          provide: TenantContextService,
          useValue: { run: (_t: unknown, fn: () => unknown) => fn() },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken("invoices"), useValue: { add: jest.fn() } },
        { provide: RouteFlowGateway, useValue: gateway },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(0.1) } },
        { provide: InvoicesService, useValue: perm() },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: NotificationsService, useValue: perm() },
        { provide: InventoryService, useValue: perm() },
        { provide: SellingRestrictionsService, useValue: perm() },
        { provide: AuthorizationGuardService, useValue: perm() },
        { provide: PromotionsService, useValue: perm() },
        { provide: MessagingService, useValue: perm() },
        { provide: CreditNotesService, useValue: perm() },
        { provide: CommissionEngineService, useValue: perm() },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        { provide: RegulatedLedgerService, useValue: perm() },
      ],
    }).compile();
    service = module.get(OrdersService);
  });

  it.each([
    ["CONFIRMED", "OUT_FOR_DELIVERY"],
    ["PENDING", "CONFIRMED"],
  ])(
    "%s -> %s loses to a cancel that committed after the read: 409, the order stays CANCELLED",
    async (from, to) => {
      arrange(from, true);
      const err = await service
        .changeStatus("ord-1", { status: to as never }, operator)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: "ORDER_CHANGED_DURING_EDIT",
      });
      expect(row.status).toBe("CANCELLED"); // never resurrected
      expect(gateway.emitOrderStatusChanged).not.toHaveBeenCalled(); // nothing announced
    },
  );

  it("CONFIRMED -> DELIVERED that loses the CAS never settles the invoice (a cancelled order is not billed)", async () => {
    arrange("CONFIRMED", true);
    await expect(
      service.changeStatus("ord-1", { status: "DELIVERED" as never }, operator),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(row.status).toBe("CANCELLED");
    expect(settleOrderInvoice).not.toHaveBeenCalled();
  });

  it("control: CONFIRMED -> DELIVERED with no cancel in between settles the invoice once", async () => {
    arrange("CONFIRMED", false);
    await service.changeStatus("ord-1", { status: "DELIVERED" as never }, operator);
    expect(settleOrderInvoice).toHaveBeenCalledTimes(1);
  });

  it("control: no cancel in between => the transition lands", async () => {
    arrange("CONFIRMED", false);
    await expect(
      service.changeStatus("ord-1", { status: "OUT_FOR_DELIVERY" as never }, operator),
    ).resolves.toMatchObject({ status: "OUT_FOR_DELIVERY" });
    expect(row.status).toBe("OUT_FOR_DELIVERY");
    expect(gateway.emitOrderStatusChanged).toHaveBeenCalledTimes(1);
  });

  it("the write is conditional on the status the transition was validated against", async () => {
    arrange("CONFIRMED", false);
    await service.changeStatus("ord-1", { status: "OUT_FOR_DELIVERY" as never }, operator);
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ord-1", status: "CONFIRMED" } }),
    );
  });

  it("an unrelated database error is not swallowed into a 409", async () => {
    arrange("CONFIRMED", false);
    prisma.order.update.mockRejectedValueOnce(new Error("connection reset"));
    await expect(
      service.changeStatus("ord-1", { status: "OUT_FOR_DELIVERY" as never }, operator),
    ).rejects.toThrow("connection reset");
  });
});
