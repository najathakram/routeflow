// OrdersService / InvoicesService pull ESM-only modules Jest's CommonJS parser cannot load; mocked at the boundary.
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));

// The shared Postgres advisory lock is replaced by a pass-through with the same contract (fn runs under the lock).
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
import { WalkInCustomerService } from "./walk-in-customer";
import { FULFILMENT_CAPABILITY_READER } from "./fulfilment-capability-reader";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { createMockPrisma } from "../../testing/prisma-mock";
import * as fs from "fs";
import * as path from "path";
import { assertLegsAgainstTotal } from "./counter-sale-legs";

/**
 * B1209: a walk-in has no account, so a CASH (or card/check) tender below the SERVER-computed total is refused with
 * 400 COUNTER_TENDER_SHORT BEFORE anything is committed (a refusal after the commit would leave the whole sale an
 * open invoice on the shared walk-in customer). The total is only known inside create() (tax, tiers, overrides), so
 * ring() hands createSale a `beforeWrite(total)` hook that create() calls right after pricing and before the stock
 * lock / transaction. Mirrors pickup-complete's walk-in guard (one code, one status: 400).
 */
const cap = {
  counter: "always",
  methods: ["PICKUP"],
  consistent: true,
} as unknown as FulfilmentCapability;
const staff = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const TOTAL = 37.25;

describe("CounterSaleService.ring: walk-in tender must cover the server total (B1209)", () => {
  let service: CounterSaleService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let written: boolean;
  let createSale: jest.Mock;
  let recordPayment: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    written = false;
    // The real createSale prices, calls beforeWrite(total), THEN writes. This stand-in keeps that order.
    createSale = jest.fn(async (_dto: any, _u: any, sale: any) => {
      await sale?.beforeWrite?.({ total: TOTAL });
      written = true;
      return { id: "inv-1", orderId: "ord-1" };
    });
    recordPayment = jest.fn(async () => ({ id: "inv-1", createdPaymentId: "pay-1" }));
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.tenantConfig.findUnique.mockResolvedValue({ creditAutoApplyOnSend: true });
    prisma.order.findFirst.mockResolvedValue({ id: "ord-1", orderNumber: "ORD-1" });
    const stored: any[] = [];
    prisma.invoice.findMany.mockImplementation(async () => [
      { id: "inv-1", total: TOTAL, status: "SENT", createdAt: new Date(), payments: stored },
    ]);
    const mod = await Test.createTestingModule({
      providers: [
        CounterSaleService,
        { provide: OrdersService, useValue: { createSale, findReplayCandidateByKey: jest.fn() } },
        { provide: InvoicesService, useValue: { recordPayment } },
        {
          provide: WalkInCustomerService,
          useValue: { getOrCreateWalkIn: jest.fn().mockResolvedValue("cust-walkin") },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: FULFILMENT_CAPABILITY_READER,
          useValue: { get: jest.fn().mockResolvedValue(cap) },
        },
      ],
    }).compile();
    service = mod.get(CounterSaleService);
  });

  const walkInSale = (payment: any) =>
    ({ walkIn: true, items: [{ productId: "p1", qty: 2, unitPrice: 5 }], payment }) as never;

  it("walk-in CASH short of the total: 400 COUNTER_TENDER_SHORT, and NOTHING was written or recorded", async () => {
    const err: any = await service.ring(walkInSale({ method: "CASH", amount: 20 }), staff).then(
      () => null,
      (e) => e,
    );
    expect(err?.getStatus?.()).toBe(400);
    expect(err.getResponse().code).toBe("COUNTER_TENDER_SHORT");
    expect(written).toBe(false);
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it("walk-in CASH 0 is short too (it can no longer leave an open invoice on the shared walk-in)", async () => {
    const err: any = await service.ring(walkInSale({ method: "CASH", amount: 0 }), staff).then(
      () => null,
      (e) => e,
    );
    expect(err?.getResponse().code).toBe("COUNTER_TENDER_SHORT");
    expect(written).toBe(false);
  });

  it("walk-in CASH exactly the total, or more, or no amount (= exact) is rung and paid", async () => {
    for (const amount of [37.25, 50, undefined]) {
      written = false;
      recordPayment.mockClear();
      const r = await service.ring(walkInSale({ method: "CASH", amount }), staff);
      expect(written).toBe(true);
      expect(r.orderId).toBe("ord-1");
      expect(recordPayment).toHaveBeenCalledTimes(1);
    }
  });

  it("a NAMED customer may still part-pay cash (the rest stays on their account)", async () => {
    const r = await service.ring(
      {
        customerId: "cust-1",
        items: [{ productId: "p1", qty: 2, unitPrice: 5 }],
        payment: { method: "CASH", amount: 20 },
      } as never,
      staff,
    );
    expect(written).toBe(true);
    expect(r.orderId).toBe("ord-1");
  });

  it("a same-key REPLAY of a committed sale with a short tender body: no refusal, the saved order comes back", async () => {
    // create() answers a replay from its pre-check, before pricing, so it never calls beforeWrite.
    const hook = jest.fn();
    createSale.mockImplementationOnce(async (_d: any, _u: any, sale: any) => {
      sale.onReplay?.({ id: "ord-1", counterSale: true });
      return { id: "inv-1", orderId: "ord-1" };
    });
    const r = await service.ring(walkInSale({ method: "CASH", amount: 1 }), staff, "key-1");
    expect(hook).not.toHaveBeenCalled();
    expect(r.orderId).toBe("ord-1");
    expect(r.replayed).toBe(true);
  });

  it("the hook is the only thing deciding: it receives the SERVER total, never a client figure", async () => {
    await service.ring(walkInSale({ method: "CASH", amount: 40 }), staff);
    const sale = createSale.mock.calls[0][2];
    expect(typeof sale.beforeWrite).toBe("function");
    expect(() => sale.beforeWrite({ total: 37.25 })).not.toThrow();
    expect(() => sale.beforeWrite({ total: 40.01 })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});

describe("assertLegsAgainstTotal (walk-in, one leg)", () => {
  it("never refuses an omitted amount or ON_ACCOUNT; a short stated amount is refused", () => {
    expect(() =>
      assertLegsAgainstTotal([{ method: "CASH", amount: 37.25 }], 37.25, true),
    ).not.toThrow();
    expect(() =>
      assertLegsAgainstTotal([{ method: "CASH", amount: 37.24 }], 37.25, true),
    ).toThrow();
    expect(() => assertLegsAgainstTotal([{ method: "CASH" }], 37.25, true)).not.toThrow();
    expect(() => assertLegsAgainstTotal([{ method: "ON_ACCOUNT" }], 37.25, true)).not.toThrow();
  });
});

describe("B1209: one code, one status; the hook never fires on a replay", () => {
  it("ring() and pickup-complete answer COUNTER_TENDER_SHORT with the SAME status (400)", () => {
    let ringStatus = 0;
    try {
      assertLegsAgainstTotal([{ method: "CASH", amount: 1 }], 5, true);
    } catch (e: any) {
      ringStatus = e.getStatus();
    }
    const pickup = fs.readFileSync(path.join(__dirname, "pickup-complete.service.ts"), "utf8");
    const block = pickup.slice(
      pickup.indexOf("must pay the full balance") - 200,
      pickup.indexOf("must pay the full balance"),
    );
    expect(block).toContain("API_ERROR_CODES.COUNTER_TENDER_SHORT");
    expect(pickup).toMatch(
      /throw new BadRequestException\(\{\s*code: API_ERROR_CODES\.COUNTER_TENDER_SHORT/,
    );
    expect(ringStatus).toBe(400);
  });

  it("create() runs both replay exits' onReplay path BEFORE it prices (the only caller of beforeWrite)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "orders.service.ts"), "utf8");
    const preCheck = src.indexOf("options.onReplay?.(existing)");
    const hook = src.indexOf("options.beforeWrite?.(");
    expect(preCheck).toBeGreaterThan(0);
    expect(hook).toBeGreaterThan(preCheck);
    expect(src.split("options.beforeWrite?.(").length - 1).toBe(1);
  });
});
