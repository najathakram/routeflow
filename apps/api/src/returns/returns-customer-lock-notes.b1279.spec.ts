/**
 * B1279 follow-up (review B on #4215, LOW 3 and LOW 1; SA-1101 A-7).
 *
 * (3) STANDARD `create()` took the customer returns lock only `if (this.idempotency)`; `IdempotencyService` is
 *     `@Optional()` there, so a build without it skipped the lock silently. The lock is unconditional now: the key
 *     helper always runs, the lock statement always goes out.
 * (1) SA-1101 A-7: every seat keys the lock on the ROW's tenant (the order's, the customer's), never on the caller's
 *     tenant context. Before, a tenantless call (a SUPER_ADMIN: `getTenantId()` null) hashed "none" in create and
 *     capture while the live-return guard hashed the row's tenant, so the two never excluded each other (rows L-1, L-2).
 *     Under a tenant request the row's tenant IS the context's, so the key is byte-identical for every business (L-3).
 *
 * The expected keys below are derived from a plain `IdempotencyService` (the old definition), never from the helper
 * under test, so a wrong key goes red by value.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ReturnsService } from "./returns.service";
import { InlineReturnsService } from "./inline-returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { IdempotencyService } from "../common/idempotency.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { lockReturnCustomersOf } from "./return-customer-lock";

const idem = new IdempotencyService();
const oldKey = (customerId: string, tenantId: string | null) =>
  idem.hashFor(customerId, tenantId, "returns.customer");
/** The key for ("cust-1", "t1") at 389ef8362c (before A-7): pinned, so no business sees a change (L-3). */
const KEY_CUST1_T1_AT_389E = "3e153d378cd519c6db0ca5804da502dc1a248faa3f7895d27851348d758a3d51";

async function createLocks(opts: { contextTenant: string | null; withService: boolean }) {
  const prisma = createMockPrisma();
  prisma.getTenantId.mockReturnValue(opts.contextTenant);
  prisma.order.findUnique.mockResolvedValue({
    id: "ord-a",
    status: "DELIVERED",
    customerId: "cust-1",
    tenantId: "t1",
    customer: { id: "cust-1", businessName: "Acme Co" },
    lineItems: [{ productId: "p1", qty: 10, unitPrice: 5, status: "PENDING", subtotal: 50 }],
    invoices: [],
  });
  const locked: string[] = [];
  prisma.tenantTransaction.mockImplementation(async (fn: any) =>
    fn({
      return: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: "ret-1", items: [] }),
      },
      returnItem: { findMany: jest.fn().mockResolvedValue([]) },
      order: prisma.order,
      customer: prisma.customer,
      $executeRaw: jest.fn(async (q: TemplateStringsArray, ...v: unknown[]) => {
        if (q.join("").includes("pg_advisory_xact_lock")) locked.push(String(v[1]));
        return 0;
      }),
      $queryRaw: jest.fn(),
    }),
  );
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      ReturnsService,
      { provide: PrismaService, useValue: prisma },
      { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
      { provide: RegulatedLedgerService, useValue: {} },
      { provide: CreditNotesService, useValue: {} },
      {
        provide: NumberingService,
        useValue: { reserveNext: jest.fn().mockResolvedValue("RET-1") },
      },
      // without the provider the service runs as in a build lacking it (@Optional() on ReturnsService)
      ...(opts.withService ? [IdempotencyService] : []),
    ],
  }).compile();
  await mod
    .get(ReturnsService)
    .create(
      { orderId: "ord-a", reason: "DAMAGED", items: [{ productId: "p1", qty: 1 }] },
      "user-1",
    );
  return locked;
}

/** The inline capture/approve seat: `lockCustomerInTx` on a service whose tenant context is `contextTenant`. */
async function inlineLocks(contextTenant: string | null, customerTenant: string | null = "t1") {
  const svc: any = Object.create(InlineReturnsService.prototype);
  svc.idempotency = new IdempotencyService();
  svc.prisma = { getTenantId: () => contextTenant };
  const locked: string[] = [];
  const tx = {
    $executeRaw: jest.fn(async (q: TemplateStringsArray, ...v: unknown[]) => {
      if (q.join("").includes("pg_advisory_xact_lock")) locked.push(String(v[1]));
      return 0;
    }),
    customer: {
      findUnique: jest.fn(async () => ({ id: "cust-1", tenantId: customerTenant })),
    },
  };
  await svc.lockCustomerInTx(tx, "cust-1");
  return locked;
}

/** The guard seat: `lockReturnCustomersOf` over an order whose row carries tenant "t1". */
async function guardLocks() {
  const taken: string[] = [];
  const tx = {
    $executeRaw: jest.fn(async (_q: TemplateStringsArray, ...v: unknown[]) => {
      taken.push(String(v[1]));
    }),
    order: { findMany: jest.fn(async () => [{ customerId: "cust-1", tenantId: "t1" }]) },
  };
  await lockReturnCustomersOf(tx, ["ord-a"]);
  return taken;
}

describe("B1279 note 3: STANDARD create takes the customer lock without an injected IdempotencyService", () => {
  it("sends the customer-scoped lock statement for the order's customer and tenant", async () => {
    const locked = await createLocks({ contextTenant: "t1", withService: false });
    expect(locked).toContain(oldKey("cust-1", "t1"));
  });
});

describe("SA-1101 A-7: every seat keys the lock on the row's tenant", () => {
  it("L-1: with no tenant context, STANDARD create and the guard over the same order take the SAME key", async () => {
    const created = await createLocks({ contextTenant: null, withService: true });
    const guarded = await guardLocks();
    expect(created).toContain(oldKey("cust-1", "t1"));
    expect(created).not.toContain(oldKey("cust-1", null)); // the "none" key is gone
    expect(guarded).toEqual([oldKey("cust-1", "t1")]);
  });

  it("L-2: with no tenant context, inline capture/approve and the guard for the same customer take the SAME key", async () => {
    const inline = await inlineLocks(null);
    const guarded = await guardLocks();
    expect(inline).toEqual([oldKey("cust-1", "t1")]);
    expect(inline).toEqual(guarded);
  });

  it("L-3: under a tenant request all three seats give the key they gave at 389ef8362c", async () => {
    const created = await createLocks({ contextTenant: "t1", withService: true });
    const inline = await inlineLocks("t1");
    const guarded = await guardLocks();
    expect(created).toContain(KEY_CUST1_T1_AT_389E);
    expect(inline).toEqual([KEY_CUST1_T1_AT_389E]);
    expect(guarded).toEqual([KEY_CUST1_T1_AT_389E]);
  });

  it("inline lock: a customer that does not exist is a 404, and takes no lock", async () => {
    const svc: any = Object.create(InlineReturnsService.prototype);
    svc.idempotency = new IdempotencyService();
    svc.prisma = { getTenantId: () => "t1" };
    const tx = {
      $executeRaw: jest.fn(),
      customer: { findUnique: jest.fn(async () => null) },
    };
    await expect(svc.lockCustomerInTx(tx, "cust-missing")).rejects.toThrow("Customer not found");
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
