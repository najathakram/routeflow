/**
 * B1279 follow-up notes (review B on #4215, LOW 3 and LOW 1).
 *
 * (3) STANDARD `create()` took the customer returns lock only `if (this.idempotency)`; `IdempotencyService` is
 *     `@Optional()` there, so a build without it skipped the lock silently. The lock is unconditional now: the key
 *     helper always runs, the lock statement always goes out.
 * (1) The key's tenant input differs by seat when there is no tenant context (a SUPER_ADMIN call: `getTenantId()` is
 *     null, so create/capture hash "none"), while the live-return guard keys on the Order row's own tenant. This file
 *     PINS that behaviour; it does not change it. SA-1101 A-6 does not rule on the tenantless seam, so the choice
 *     (key every seat on the row's tenant, or refuse a tenantless return create) stays with the lead/SA.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { IdempotencyService } from "../common/idempotency.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { lockReturnCustomersOf, returnCustomerLockKey } from "./return-customer-lock";

async function createLocks(tenantId: string | null, withService: boolean) {
  const prisma = createMockPrisma();
  prisma.getTenantId.mockReturnValue(tenantId);
  prisma.order.findUnique.mockResolvedValue({
    id: "ord-a",
    status: "DELIVERED",
    customerId: "cust-1",
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
      ...(withService ? [IdempotencyService] : []),
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

describe("B1279 note 3: STANDARD create takes the customer lock without an injected IdempotencyService", () => {
  it("sends the customer-scoped lock statement keyed by returnCustomerLockKey", async () => {
    const locked = await createLocks("t1", false);
    expect(locked).toContain(returnCustomerLockKey("cust-1", "t1"));
  });
});

describe("B1279 note 1 (pinned, not changed): the tenant input of the key without tenant context", () => {
  it("create with no tenant context hashes the 'none' tenant", async () => {
    const locked = await createLocks(null, true);
    expect(locked).toContain(returnCustomerLockKey("cust-1", null));
    expect(locked).not.toContain(returnCustomerLockKey("cust-1", "t1"));
  });

  it("the guard keys on the Order row's own tenant, so it takes a DIFFERENT lock than a tenantless create", async () => {
    const taken: string[] = [];
    const tx = {
      $executeRaw: jest.fn(async (_q: TemplateStringsArray, ...v: unknown[]) => {
        taken.push(String(v[1]));
      }),
      order: { findMany: jest.fn(async () => [{ customerId: "cust-1", tenantId: "t1" }]) },
    };
    await lockReturnCustomersOf(tx, ["ord-a"]);
    expect(taken).toEqual([returnCustomerLockKey("cust-1", "t1")]);
    // the seam: the two seats do not exclude each other when create runs without tenant context
    expect(taken).not.toContain(returnCustomerLockKey("cust-1", null));
  });
});
