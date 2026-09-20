// Mock InvoicesService / NotificationsService before they are imported: they pull ESM-only modules
// (@react-pdf/renderer, expo-server-sdk) that Jest's CommonJS transform cannot parse.
jest.mock("../invoices/invoices.service", () => ({ InvoicesService: jest.fn() }));
jest.mock("../notifications/notifications.service", () => ({ NotificationsService: jest.fn() }));

import * as fs from "fs";
import * as path from "path";
import { Test } from "@nestjs/testing";
import { ConflictException, Logger } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { OrdersService } from "./orders.service";
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
 * B585 — the credit check when an order goes OUT for delivery (operator `changeStatus` to
 * OUT_FOR_DELIVERY), behind the per-tenant switch #1043 introduced: absent = OFF (one switch read,
 * nothing else), "dark" = observe, "true" = enforce. It runs BEFORE any write, so nothing is half
 * committed. The driver's stop completion (`RoutesService`) is deliberately NOT gated.
 */
describe("OrdersService.changeStatus — B585 credit check at delivery", () => {
  const operator = { sub: "u-op", username: "op", role: "OPERATOR", tenantId: "t-1" } as never;
  const tenantAdmin = {
    sub: "u-ta",
    username: "ta",
    role: "TENANT_ADMIN",
    tenantId: "t-1",
  } as never;
  const driver = { sub: "u-dr", username: "dr", role: "DRIVER", tenantId: "t-1" } as never;
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
  const sent = (total: number) => ({
    total,
    status: "SENT",
    orderId: null,
    order: null,
    payments: [],
  });

  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let warn: jest.SpyInstance;

  const out = (user = operator, status = "OUT_FOR_DELIVERY") =>
    service.changeStatus("ord-1", { status: status as never }, user);
  const setSwitch = (value: string | null) =>
    prisma.systemConfig.findFirst.mockResolvedValue(value === null ? null : { value });
  /** limit 100; the customer already owes 60 on a sent invoice; this order is 50 => 110 (over). */
  const overLimit = () => {
    prisma.customer.findFirst.mockResolvedValue({ creditLimit: 100 });
    prisma.invoice.findMany.mockResolvedValue([sent(60)]);
    prisma.order.findMany.mockResolvedValue([]);
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    // A permissive stub: every method is a resolved jest.fn. `then` / symbols answer undefined, else
    // Nest would await the proxy as a thenable that never settles.
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
    const module = await Test.createTestingModule({
      providers: [
        OrdersService,
        {
          provide: TenantContextService,
          useValue: { run: (_t: unknown, fn: () => unknown) => fn() },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken("invoices"), useValue: { add: jest.fn() } },
        { provide: RouteFlowGateway, useValue: perm() },
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
    prisma.order.findUnique.mockResolvedValue({ ...ORDER });
    prisma.order.update.mockResolvedValue({ ...ORDER, status: "OUT_FOR_DELIVERY" });
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("OFF (switch absent): the order goes out, ONE switch read and no exposure derivation at all", async () => {
    setSwitch(null);
    overLimit();
    await expect(out()).resolves.toMatchObject({ status: "OUT_FOR_DELIVERY" });

    expect(prisma.systemConfig.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(prisma.order.update).toHaveBeenCalledTimes(1);
  });

  it("DARK ('dark'): an over-limit delivery is ALLOWED and exactly one would-deny line is logged", async () => {
    setSwitch("dark");
    overLimit();
    await expect(out()).resolves.toMatchObject({ status: "OUT_FOR_DELIVERY" });

    const lines = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("would DENY"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("delivery");
    expect(prisma.order.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an OPERATOR", operator],
    ["a TENANT_ADMIN", tenantAdmin],
  ])(
    "ENFORCED ('true'), %s: refused 409 with the figures, BEFORE any write",
    async (_who, user) => {
      setSwitch("true");
      overLimit();
      const err = await out(user).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: "CREDIT_LIMIT_EXCEEDED",
        limit: 100,
        exposure: 110,
      });
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    },
  );

  it("ENFORCED and within the limit: the order goes out", async () => {
    setSwitch("true");
    prisma.customer.findFirst.mockResolvedValue({ creditLimit: 100 });
    prisma.invoice.findMany.mockResolvedValue([sent(40)]); // 40 + 50 = 90 <= 100
    prisma.order.findMany.mockResolvedValue([]);
    await expect(out()).resolves.toMatchObject({ status: "OUT_FOR_DELIVERY" });
  });

  it("the order being sent out is never counted twice: it is an OPEN order AND the projected total, so it is excluded from its own exposure", async () => {
    setSwitch("true");
    prisma.customer.findFirst.mockResolvedValue({ creditLimit: 100 });
    prisma.invoice.findMany.mockResolvedValue([sent(40)]);
    prisma.order.findMany.mockResolvedValue([{ id: "ord-1", total: 50 }]); // itself, still CONFIRMED
    // excluded: 40 + 50 = 90 <= 100 (counted twice it would be 140 and refused)
    await expect(out()).resolves.toMatchObject({ status: "OUT_FOR_DELIVERY" });
  });

  describe("the fleet-lead ruling: a WRITTEN_OFF invoice covers nothing, so its order stays counted", () => {
    const orderInvoice = (status: string) => ({
      total: 100,
      status,
      orderId: "o-old",
      order: { id: "o-old", status: "CONFIRMED", total: 100 },
      payments: [{ amount: 100, status: "PAID" }],
    });
    const arrange = (status: string) => {
      setSwitch("true");
      prisma.customer.findFirst.mockResolvedValue({ creditLimit: 120 });
      prisma.invoice.findMany.mockResolvedValue([orderInvoice(status)]);
      prisma.order.findMany.mockResolvedValue([{ id: "o-old", total: 100 }]);
    };

    it("WRITTEN_OFF: the old order still counts 100, so delivering a 50 order is refused (150 > 120)", async () => {
      arrange("WRITTEN_OFF");
      await expect(out()).rejects.toMatchObject({ response: { code: "CREDIT_LIMIT_EXCEEDED" } });
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("control — PAID covers its order: the same delivery goes out (0 + 50 <= 120)", async () => {
      arrange("PAID");
      await expect(out()).resolves.toMatchObject({ status: "OUT_FOR_DELIVERY" });
    });
  });

  it("only OUT_FOR_DELIVERY is gated: a PENDING -> CONFIRMED (even by a driver) never reads the switch", async () => {
    setSwitch("true");
    overLimit();
    prisma.order.findUnique.mockResolvedValue({ ...ORDER, status: "PENDING" });
    prisma.order.update.mockResolvedValue({ ...ORDER, status: "CONFIRMED" });
    await out(driver, "CONFIRMED");

    expect(prisma.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it("the driver's route-stop completion is NOT gated: RoutesService never touches the credit gate", () => {
    const routes = fs.readFileSync(path.join(__dirname, "../routes/routes.service.ts"), "utf8");
    expect(routes).not.toMatch(/creditGate|assertCreditAtEnforcementPoint|credit_limit\.enforce/);
  });
});
