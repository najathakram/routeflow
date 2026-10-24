// Row 498 (SA-837) / lead ruling 3: POST /bookkeeping/transactions/:id/payments (`BookkeepingService.recordPayment`)
// is an InvoicePayment writer outside the SA-824 keyed path. It goes through the SAME reference predicate
// (payment-ref-dedupe.ts) and the same `payment-ref` lock as the invoice writers. Passes the options through
// `as any` and imports nothing new, so it runs on master, where the second payment is recorded.
const mockLocks: string[] = [];
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (opts: { family: string; key: string }, fn: () => unknown) => {
    mockLocks.push(`${opts.family}:${opts.key}`);
    return { acquired: true, value: await fn() };
  }),
}));
jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("./invoice.service", () => ({
  InvoiceService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../vendor-bills/vendor-bills.service", () => ({
  VendorBillsService: jest.fn().mockImplementation(() => ({})),
}));

import { Test } from "@nestjs/testing";
import { BookkeepingService } from "./bookkeeping.service";
import { InvoiceService } from "./invoice.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { createMockPrisma } from "../testing/prisma-mock";

const DUP = "DUPLICATE_PAYMENT_REF";

describe("row 498: BookkeepingService.recordPayment dedupes on a normalised reference", () => {
  let service: BookkeepingService;
  let pays: any[];
  let audits: any[];
  let seq: number;
  const owners: Record<string, string> = {
    "inv-1": "cust-1",
    "inv-2": "cust-1",
    "inv-3": "cust-2",
    "walk-1": "cust-walk",
    "walk-2": "cust-walk",
  };

  beforeEach(async () => {
    const prisma = createMockPrisma();
    pays = [];
    audits = [];
    seq = 0;
    mockLocks.length = 0;
    prisma.getTenantId.mockReturnValue("tenant-a");
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      const stagePays: any[] = [];
      const stageAudits: any[] = [];
      const tx = {
        $executeRaw: jest.fn(),
        $queryRaw: jest.fn(async () => []),
        invoice: {
          findMany: jest.fn(async () => []),
          findUnique: jest.fn(async (a: any) => ({
            id: a.where.id,
            customerId: owners[a.where.id],
            invoiceNumber: `N-${a.where.id}`,
            status: "SENT",
            total: 100,
            payments: [],
          })),
          update: jest.fn(async (a: any) => ({
            id: a.where.id,
            status: "PARTIAL",
            total: 100,
            payments: [],
            customer: null,
            order: null,
          })),
        },
        customer: {
          findUnique: jest.fn(async (a: any) => ({
            id: a.where.id,
            isWalkIn: a.where.id === "cust-walk",
          })),
        },
        invoicePayment: {
          create: jest.fn(async ({ data }: any) => {
            const row = { id: `pay-${++seq}`, paymentNumber: `PAY-${seq}`, ...data };
            stagePays.push(row);
            return row;
          }),
          findMany: jest.fn(async (a: any) =>
            pays
              .filter(
                (p) =>
                  owners[p.invoiceId] === a?.where?.invoice?.customerId &&
                  p.method === a.where.method &&
                  p.status !== "VOID" &&
                  p.reference != null,
              )
              .map((p) => ({ ...p, invoice: { invoiceNumber: `N-${p.invoiceId}` } })),
          ),
        },
        advancePayment: { findMany: jest.fn(async () => []) },
        auditLog: {
          create: jest.fn(async ({ data }: any) => {
            stageAudits.push(data);
            return data;
          }),
        },
      };
      const out = await fn(tx);
      pays.push(...stagePays);
      audits.push(...stageAudits);
      return out;
    });
    const module = await Test.createTestingModule({
      providers: [
        BookkeepingService,
        { provide: PrismaService, useValue: prisma },
        { provide: InvoiceService, useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: VendorBillsService, useValue: {} },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn(), set: jest.fn(), getAll: jest.fn() },
        },
        { provide: PlatformConfigService, useValue: {} },
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = module.get(BookkeepingService);
  });

  const dto = (over: Record<string, unknown> = {}) =>
    ({ amount: 40, method: "CHECK", reference: "CHK-7788", ...over }) as any;
  const pay = (id: string, over: Record<string, unknown> = {}, opts?: Record<string, unknown>) =>
    (service as any).recordPayment(id, dto(over), opts);

  it("the same normalised reference, amount, customer and method on another invoice is 409, naming the first payment", async () => {
    await pay("inv-1");
    const err: any = await pay("inv-2", { reference: " chk 7788 " }).catch((e: unknown) => e);
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: DUP,
      existingPayment: { id: "pay-1", amount: 40, invoiceId: "inv-1", invoiceNumber: "N-inv-1" },
    });
    expect(pays).toHaveLength(1);
  });

  it("a different customer, amount or method is allowed; no reference is never deduped", async () => {
    await pay("inv-1");
    await pay("inv-3");
    await pay("inv-2", { amount: 41 });
    await pay("inv-2", { method: "ACH" });
    await pay("inv-2", { reference: undefined });
    await pay("inv-2", { reference: undefined });
    expect(pays).toHaveLength(6);
  });

  it("recordAnyway by staff saves it with exactly one audit row; from a non-staff role it is ignored (409)", async () => {
    await pay("inv-1");
    const refused: any = await pay(
      "inv-2",
      {},
      {
        refDedupe: { actor: "u-9", role: "CUSTOMER", recordAnyway: true },
      },
    ).catch((e: unknown) => e);
    expect(refused?.getStatus?.()).toBe(409);
    expect(audits).toHaveLength(0);

    await pay(
      "inv-2",
      {},
      { refDedupe: { actor: "u-1", role: "TENANT_ADMIN", recordAnyway: true } },
    );
    expect(pays).toHaveLength(2);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: "u-1",
      entityId: "inv-2",
      meta: expect.objectContaining({ normalisedRef: "CHK7788", duplicateOfPaymentId: "pay-1" }),
    });
  });

  it("the walk-in identity is never deduped", async () => {
    await pay("walk-1");
    await pay("walk-2");
    expect(pays).toHaveLength(2);
  });

  it("takes the payment-ref lock keyed tenant:method:normRef, and none without a reference", async () => {
    await pay("inv-1", { reference: "chk 77-88" });
    expect(mockLocks).toEqual(["payment-ref:tenant-a:CHECK:CHK7788"]);
    mockLocks.length = 0;
    await pay("inv-1", { reference: undefined });
    expect(mockLocks).toEqual([]);
  });
});
