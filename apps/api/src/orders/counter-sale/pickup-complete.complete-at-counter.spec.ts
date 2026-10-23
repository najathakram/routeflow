// OrdersService / InvoicesService pull ESM-only modules Jest's CommonJS parser cannot load: mocks at the boundary.
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../order-status-invoicing", () => ({ settleOrderInvoice: jest.fn() }));
jest.mock("../../credit-notes/auto-apply-candidates", () => ({
  ...jest.requireActual("../../credit-notes/auto-apply-candidates"),
  creditAutoApplyOnSend: async () => false,
}));
const mockLock = { tenderNotAcquired: false, calls: 0 };
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: async (opts: any, fn: () => Promise<unknown>) => {
    mockLock.calls += 1;
    const isTender = opts.sharedAlso !== undefined; // the claim section takes no shared close lock
    if (isTender && mockLock.tenderNotAcquired) return { acquired: false };
    return { acquired: true, value: await fn() };
  },
}));

import { Test } from "@nestjs/testing";
import { PickupCompleteService } from "./pickup-complete.service";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { createMockPrisma } from "../../testing/prisma-mock";
import { FULFILMENT_CAPABILITY_READER } from "./fulfilment-capability-reader";
import { UNSET_FULFILMENT_CAPABILITIES } from "@routeflow/types";

/**
 * I-120 "Complete at counter" (SA-861): the hand-over engine widened to any not-yet-delivered order, on the mocked
 * collaborators of pickup-complete.service.spec.ts. Red on master (PICKUP_ONLY / PICKUP_NOT_READY / no silent option /
 * no completion email), green after. The money and message paths also run on real Postgres
 * (pickup-complete.complete-at-counter.db.spec.ts).
 */
const staff = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const T_DELIVERED = 1000;
const STORE_PICKUP = {
  ...UNSET_FULFILMENT_CAPABILITIES,
  methods: ["ROUTE", "SHIP", "PICKUP"] as never,
};

describe("PickupCompleteService.complete: Complete at counter (I-120, SA-861)", () => {
  let service: PickupCompleteService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let order: any;
  let invoices: any[];
  let claims: any[];
  let capability: any;
  const calls: string[] = [];
  const orders = {
    changeStatus: jest.fn(),
    updateFulfillPath: jest.fn(),
  };
  const inv = {
    send: jest.fn(),
    recordPayment: jest.fn(),
    sendCompletionEmail: jest.fn(),
  };
  const orderRow = (status: string, over: object = {}) => ({
    id: "ord-1",
    orderNumber: "ORD-1",
    status,
    fulfillPath: "PICKUP",
    deliveredAt: status === "DELIVERED" ? new Date(T_DELIVERED) : null,
    customerId: "cust-1",
    customer: { isWalkIn: false },
    shippedAt: null,
    ...over,
  });
  const cash = { payment: { method: "CASH", amount: 50 } } as never;
  const run = (body: unknown = cash, key = "key-1") =>
    service.complete("ord-1", body as never, staff, key);
  const errorOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as any;
    }
    throw new Error("expected a rejection");
  };

  beforeEach(async () => {
    calls.length = 0;
    claims = [];
    mockLock.tenderNotAcquired = false;
    capability = STORE_PICKUP;
    prisma = createMockPrisma();
    order = orderRow("OUT_FOR_DELIVERY");
    invoices = [{ id: "inv-1", total: 50, status: "DRAFT", createdAt: new Date(1), payments: [] }];
    orders.changeStatus
      .mockReset()
      .mockImplementation(async (_id: string, dto: any, _u: any, opts: any) => {
        calls.push(`changeStatus:${dto.status}:${opts?.silent === true ? "silent" : "loud"}`);
        order = {
          ...order,
          status: dto.status,
          ...(dto.status === "DELIVERED" ? { deliveredAt: new Date(T_DELIVERED) } : {}),
        };
        return order;
      });
    orders.updateFulfillPath.mockReset().mockImplementation(async (_id: string, dto: any) => {
      calls.push(`updateFulfillPath:${dto.fulfillPath}`);
      order = { ...order, fulfillPath: dto.fulfillPath };
      return order;
    });
    inv.send.mockReset().mockImplementation(async (id: string, opts: any) => {
      calls.push(`send:${opts?.suppressNotify === true ? "quiet" : "notify"}`);
      invoices.find((i) => i.id === id).status = "SENT";
      return { id };
    });
    inv.recordPayment.mockReset().mockImplementation(async (invoiceId: string, dto: any) => {
      calls.push("recordPayment");
      invoices
        .find((i) => i.id === invoiceId)
        .payments.push({
          id: `p-${calls.length}`,
          amount: dto.amount,
          method: dto.method,
          status: "PAID",
          createdAt: new Date(T_DELIVERED + 10),
        });
      return { id: invoiceId };
    });
    inv.sendCompletionEmail.mockReset().mockImplementation(async () => {
      calls.push("completionEmail");
      return { delivered: true };
    });
    prisma.order.findFirst.mockImplementation(async () => order);
    prisma.auditLog.findFirst.mockImplementation(async () => claims[0] ?? null);
    prisma.auditLog.create.mockImplementation(async ({ data }: any) => {
      claims.push({ id: "claim-1", ...data });
      return claims[0];
    });
    prisma.auditLog.update.mockImplementation(async ({ data }: any) => {
      claims[0] = { ...claims[0], ...data };
      return claims[0];
    });
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockImplementation(async () =>
      invoices.map((i) => ({ ...i, payments: [...i.payments], invoiceNumber: `N-${i.id}` })),
    );

    const mod = await Test.createTestingModule({
      providers: [
        PickupCompleteService,
        { provide: OrdersService, useValue: orders },
        { provide: InvoicesService, useValue: inv },
        { provide: PrismaService, useValue: prisma },
        { provide: FULFILMENT_CAPABILITY_READER, useValue: { get: async () => capability } },
      ],
    }).compile();
    service = mod.get(PickupCompleteService);
  });

  it("R1 a PENDING ROUTE order: Store pickup first, then CONFIRMED and DELIVERED (both silent), a quiet send, the tender, ONE completion email", async () => {
    order = orderRow("PENDING", { fulfillPath: "ROUTE" });
    const res: any = await run();
    expect(calls).toEqual([
      "updateFulfillPath:PICKUP",
      "changeStatus:CONFIRMED:silent",
      "changeStatus:DELIVERED:silent",
      "send:quiet",
      "recordPayment",
      "completionEmail",
    ]);
    expect(inv.sendCompletionEmail).toHaveBeenCalledWith("ord-1", ["inv-1"], "op-1");
    expect(res.emailed).toBe(true);
  });

  it("R1 the DELIVERED step nets the till tender at the credit gate (creditPaidNow), the S1 rule", async () => {
    order = orderRow("CONFIRMED", { fulfillPath: "ROUTE" });
    await run();
    const delivered = orders.changeStatus.mock.calls.find((c) => c[1].status === "DELIVERED");
    expect(typeof delivered[3].creditPaidNow).toBe("function");
    expect(delivered[3].creditPaidNow(50)).toBe(50); // cash for the full balance: all of it is paid now
  });

  it("R2 a CONFIRMED SHIP order not shipped: Store pickup, then DELIVERED (silent), one completion email", async () => {
    order = orderRow("CONFIRMED", { fulfillPath: "SHIP" });
    await run();
    expect(calls).toEqual([
      "updateFulfillPath:PICKUP",
      "changeStatus:DELIVERED:silent",
      "send:quiet",
      "recordPayment",
      "completionEmail",
    ]);
  });

  it("R3 a PICKUP order OUT_FOR_DELIVERY ('ready'): no path switch, DELIVERED silent, a quiet send, one email", async () => {
    await run();
    expect(calls).toEqual([
      "changeStatus:DELIVERED:silent",
      "send:quiet",
      "recordPayment",
      "completionEmail",
    ]);
  });

  it("R4 a walk-in gets no email", async () => {
    order = orderRow("OUT_FOR_DELIVERY", { customer: { isWalkIn: true } });
    const res: any = await run();
    expect(inv.sendCompletionEmail).not.toHaveBeenCalled();
    expect(res.emailed ?? false).toBe(false);
  });

  it("R5 a replay with the same key after the email went: no second email, no second tender, alreadyPickedUp", async () => {
    await run();
    expect(claims[0].meta.completionEmailedAt).toBeTruthy();
    const res: any = await run();
    expect(inv.sendCompletionEmail).toHaveBeenCalledTimes(1);
    expect(inv.recordPayment).toHaveBeenCalledTimes(1);
    expect(res.alreadyPickedUp).toBe(true);
  });

  it("R6 a tender lock not taken (paymentRecorded false): no email; the retry records the payment and emails once", async () => {
    mockLock.tenderNotAcquired = true;
    const first: any = await run();
    expect(first.paymentRecorded).toBe(false);
    expect(inv.sendCompletionEmail).not.toHaveBeenCalled();
    mockLock.tenderNotAcquired = false;
    await run();
    expect(inv.recordPayment).toHaveBeenCalledTimes(1);
    expect(inv.sendCompletionEmail).toHaveBeenCalledTimes(1);
  });

  it("R7 the path switch refuses (selling restrictions at the store's state): nothing else is written", async () => {
    order = orderRow("CONFIRMED", { fulfillPath: "ROUTE" });
    orders.updateFulfillPath.mockRejectedValueOnce(
      Object.assign(new Error("restricted"), {
        getStatus: () => 409,
        getResponse: () => ({ code: "SELLING_RESTRICTED" }),
      }),
    );
    const e = await errorOf(run());
    expect(e.getStatus()).toBe(409);
    expect(orders.changeStatus).not.toHaveBeenCalled();
    expect(inv.send).not.toHaveBeenCalled();
    expect(inv.recordPayment).not.toHaveBeenCalled();
    expect(inv.sendCompletionEmail).not.toHaveBeenCalled();
  });

  it("R12 a ROUTE order still linked to a finished run goes through the switch (which releases the link) and completes", async () => {
    order = orderRow("CONFIRMED", { fulfillPath: "ROUTE", routeRunId: "run-done" });
    await run();
    expect(calls[0]).toBe("updateFulfillPath:PICKUP");
    expect(calls).toContain("completionEmail");
  });

  it("R12 (SA-872) the switch answers ORDER_RUN_LINK_CHANGED: that coded refusal, and NOTHING is written", async () => {
    order = orderRow("CONFIRMED", { fulfillPath: "ROUTE", routeRunId: "run-done" });
    orders.updateFulfillPath.mockRejectedValueOnce(
      Object.assign(new Error("changed"), {
        getStatus: () => 409,
        getResponse: () => ({ code: "ORDER_RUN_LINK_CHANGED" }),
      }),
    );
    const e = await errorOf(run());
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse().code).toBe("ORDER_RUN_LINK_CHANGED");
    expect(orders.changeStatus).not.toHaveBeenCalled();
    expect(inv.send).not.toHaveBeenCalled();
    expect(inv.recordPayment).not.toHaveBeenCalled();
    expect(inv.sendCompletionEmail).not.toHaveBeenCalled();
  });

  it("R11 a tenant with no store pickup (no PICKUP method, counter off) is refused before any write", async () => {
    capability = UNSET_FULFILMENT_CAPABILITIES;
    const e = await errorOf(run());
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse().code).toBe("COUNTER_COMPLETE_UNAVAILABLE");
    expect(calls).toEqual([]);
  });

  it.each(["DRAFT", "PARTIALLY_DELIVERED", "CANCELLED"])(
    "a %s order stays refused (PICKUP_NOT_READY), any path",
    async (status) => {
      order = orderRow(status, { fulfillPath: "ROUTE" });
      const e = await errorOf(run());
      expect(e.getResponse().code).toBe("PICKUP_NOT_READY");
      expect(calls).toEqual([]);
    },
  );

  // SA-861 R8/R9: waiting on OWNER-QUEUE 7a (owner Q1/Q2); built once the owner answers or the SA rules they can ship without.
  it.todo(
    "R8 an order on an active run (or OUT_FOR_DELIVERY on a route) -> per Q1; a stop IN_PROGRESS is refused in every answer",
  );
  it.todo("R9 a shipped SHIP order (shippedAt set) -> per Q2");
});
