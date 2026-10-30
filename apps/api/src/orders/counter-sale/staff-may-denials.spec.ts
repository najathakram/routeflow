// The services import OrdersService / InvoicesService, whose module graph Jest's CommonJS parser cannot load; both are
// mocks at the module boundary here.
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
}));

import { Test } from "@nestjs/testing";
import type { FulfilmentCapability } from "@routeflow/types";
import { CounterSaleService } from "./counter-sale.service";
import { CounterSaleVoidService } from "./counter-sale-void.service";
import { WalkInCustomerService } from "./walk-in-customer";
import { FULFILMENT_CAPABILITY_READER } from "./fulfilment-capability-reader";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { RouteFlowGateway } from "../../gateways/routeflow.gateway";
import { createMockPrisma } from "../../testing/prisma-mock";

/**
 * W-870: a till capability decided on the request path reads the OPERATOR's denied permission groups live
 * (`operatorDeniedGroups`), like the till guard. An operator whose admin switched a group off is refused what that
 * group gates; TENANT_ADMIN is unaffected. Before the fix both calls passed no denials, so the denied operator got
 * through.
 */

const operator = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const admin = { sub: "ad-1", role: "TENANT_ADMIN", tenantId: "t-1" } as never;
const item = { productId: "p1", qty: 2, unitPrice: 5 };

const cap = {
  methods: ["ROUTE", "SHIP"],
  staffDefault: "ROUTE",
  staffOpensAs: "order",
  portalMethods: [],
  portalDefault: null,
  counter: "optional",
  fleet: true,
  consistent: true,
} as unknown as FulfilmentCapability;

/** The operator's stored row: `deniedPermissionGroups` is what the admin switched off. */
const deny = (prisma: ReturnType<typeof createMockPrisma>, groups: string[]) =>
  prisma.user.findFirst.mockResolvedValue({
    deniedPermissionGroups: groups,
    permissionsVersion: 2,
  });

describe("counter-sale void: VOID_SALE reads the operator's denied groups (W-870)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: CounterSaleVoidService;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.order.findFirst.mockResolvedValue(null); // past the permission check: a plain 404
    const mod = await Test.createTestingModule({
      providers: [
        CounterSaleVoidService,
        { provide: OrdersService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: {} },
      ],
    }).compile();
    service = mod.get(CounterSaleVoidService);
  });

  const statusOf = (user: never) =>
    service.voidSale("ord-1", { reason: "wrong item" } as never, user).then(
      () => 200,
      (e: any) => e.getStatus?.() ?? e,
    );

  it("an operator denied ORDERS is refused 403 before any order read (was: let through to the 404)", async () => {
    deny(prisma, ["ORDERS"]);
    expect(await statusOf(operator)).toBe(403);
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it("an operator holding ORDERS, and a TENANT_ADMIN, still reach the sale lookup", async () => {
    deny(prisma, ["PRICING"]);
    expect(await statusOf(operator)).toBe(404);
    expect(await statusOf(admin)).toBe(404);
  });
});

describe("counter sale: EDIT_LINE_PRICE reads the operator's denied groups (W-870)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: CounterSaleService;
  let createSale: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    createSale = jest.fn(async () => ({ id: "inv-1", orderId: "ord-1", invoiceNumber: "INV-1" }));
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.tenantConfig.findUnique.mockResolvedValue({ creditAutoApplyOnSend: true });
    prisma.order.findFirst.mockResolvedValue({ id: "ord-1", orderNumber: "ORD-1" });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoice.findMany.mockResolvedValue([
      { id: "inv-1", total: 10, status: "SENT", createdAt: new Date(), payments: [] },
    ]);
    const mod = await Test.createTestingModule({
      providers: [
        CounterSaleService,
        {
          provide: OrdersService,
          useValue: { createSale, findReplayCandidateByKey: jest.fn(async () => null) },
        },
        {
          provide: InvoicesService,
          useValue: { recordPayment: jest.fn(async () => ({ createdPaymentId: "pay-1" })) },
        },
        { provide: WalkInCustomerService, useValue: { getOrCreateWalkIn: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: FULFILMENT_CAPABILITY_READER, useValue: { get: jest.fn(async () => cap) } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CounterSaleService);
  });

  const priceEditAllowed = async (user: never) => {
    await service.ring(
      { customerId: "cust-1", items: [item], payment: { method: "CASH" } } as never,
      user,
    );
    return createSale.mock.calls[0][2].priceEditAllowed;
  };

  it("an operator denied PRICING may not change a till price (was: priceEditAllowed true, a $0 line accepted)", async () => {
    deny(prisma, ["PRICING"]);
    expect(await priceEditAllowed(operator)).toBe(false);
  });

  it("an operator holding PRICING, and a TENANT_ADMIN, may", async () => {
    deny(prisma, ["FINANCE"]);
    expect(await priceEditAllowed(operator)).toBe(true);
    createSale.mockClear();
    expect(await priceEditAllowed(admin)).toBe(true);
  });
});
