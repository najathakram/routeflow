import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";

// B127 — apps/api/src/customers/customers.service.ts deleteAllCustomers()
//
// Reference behaviour: the sibling batchDelete() (~1926-1944) runs a PAID/SENT
// pre-flight via `prisma.forTenant().invoice.groupBy({ by: ["customerId"],
// where: { customerId: { in }, status: { in: ["PAID", "SENT"] } }, _count: { _all: true } })`
// and throws ConflictException naming each blocking customer + its invoice count
// before anything is deleted. deleteAllCustomers() must match that behaviour
// exactly — see test-plan.md T7-T9 / spec.md R5-R6.
//
// The mock below reacts to the `status.in` array it is actually called with
// (rather than unconditionally resolving a fixed blocker row) so that a fix
// which only checks PAID — and forgets SENT — cannot pass T8 vacuously.
describe("CustomersService.deleteAllCustomers — PAID/SENT pre-flight (B127)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const SEEDED_CUSTOMERS = [
    { id: "cust-1", userId: "user-1" },
    { id: "cust-2", userId: "user-2" },
  ];

  // Simulates Prisma's real groupBy filtering: a blocker row for a given
  // customer/count is only returned if the caller's `where.status.in` actually
  // asked for that status — exactly like a real PAID or SENT invoice row would
  // only surface when the query filters for it.
  const blockOnStatus = (status: "PAID" | "SENT", customerId: string, count: number) =>
    jest.fn(({ where }: any) => {
      const statuses: string[] = where?.status?.in ?? [];
      if (!statuses.includes(status)) return Promise.resolve([]);
      return Promise.resolve([{ customerId, _count: { _all: count } }]);
    });

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.customer.findMany.mockResolvedValue(SEEDED_CUSTOMERS as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        // B65-class invariant: CustomersService now reverses a destroyed
        // invoice's regulated-ledger entries, so the collaborator must be provided.
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue("mock-key"),
            delete: jest.fn().mockResolvedValue(undefined),
            presignedUrl: jest.fn().mockResolvedValue("https://mock-url"),
          },
        },
        {
          provide: MeterService,
          useValue: {
            read: jest.fn().mockResolvedValue({
              meter: "CUSTOMERS",
              used: 0,
              included: null,
              remaining: null,
              resetsAt: null,
            }),
          },
        },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn(),
            syncOrderInvoices: jest.fn(),
            syncInvoiceCommission: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CustomersService>(CustomersService);
  });

  // REG-B127 — canonical regression pin for the fix landed in #506 (cc8c7d46):
  // DELETE /customers/all hard-deleted every customer plus PAID/SENT invoices/payments
  // that the sibling batchDelete() refuses to touch, and on a null-tenant (SUPER_ADMIN)
  // token span every tenant. This test collapses both load-bearing halves into one
  // oracle: (1) a PAID invoice blocks the wipe with the same pre-flight batchDelete runs,
  // and (2) a null tenantId is refused outright rather than falling through to an
  // unscoped delete. T7-T11 above are the detailed proof.
  it("REG-B127 DELETE /customers/all is blocked by PAID invoices and refuses a null tenantId", async () => {
    (prisma.invoice.groupBy as jest.Mock).mockImplementation(blockOnStatus("PAID", "cust-1", 2));

    const caught: any = await service.deleteAllCustomers().catch((e) => e);
    expect(caught).toBeInstanceOf(ConflictException);
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();

    (prisma.invoice.groupBy as jest.Mock).mockClear();
    (prisma.tenantTransaction as jest.Mock).mockClear();
    prisma.getTenantId.mockReturnValue(null);

    prisma.customer.findMany.mockClear();

    await expect(service.deleteAllCustomers()).rejects.toThrow(ForbiddenException);
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
    expect(prisma.invoice.groupBy).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  // ─── T7 (R5) — a PAID invoice blocks the bulk customer delete ─────────────

  it("T7: throws ConflictException naming the blocking customer + PAID count, and deletes nothing", async () => {
    (prisma.invoice.groupBy as jest.Mock).mockImplementation(blockOnStatus("PAID", "cust-1", 2));

    // `.catch((e) => e)` rather than try/catch: a wiring failure then reads as itself
    // (the resolved/rejected value is inspected below) instead of masquerading as a
    // missing-exception assertion.
    const caught: any = await service.deleteAllCustomers().catch((e) => e);

    expect(caught).toBeInstanceOf(ConflictException);
    // Same message shape as batchDelete: "<customerId>: <n> invoice(s)".
    expect(caught.message).toContain("cust-1");
    expect(caught.message).toContain("2 invoice(s)");

    // Pin the pre-flight to the sibling batchDelete's exact query. Without this the
    // ConflictException could have been thrown off some unrelated signal, or off a
    // status list narrower than the sibling's — R5 says "same statuses" explicitly.
    expect(prisma.invoice.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["customerId"],
        where: expect.objectContaining({
          customerId: { in: ["cust-1", "cust-2"] },
          status: { in: ["PAID", "SENT"] },
        }),
      }),
    );

    // Nothing was deleted — the pre-flight blocked before the transaction ever ran.
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();

    // R5's "same message shape" clause, pinned to the sibling instead of restated as
    // substrings: run batchDelete over the SAME blockers and compare messages verbatim.
    // The guard's message is a duplicated literal in customers.service.ts (batchDelete
    // and deleteAllCustomers); editing either copy desynchronizes the two endpoints'
    // UX, and this is the assertion that turns that red. Deliberately LAST — calling
    // batchDelete earlier would issue an identical groupBy and satisfy the query pin
    // above on deleteAllCustomers' behalf.
    const sibling: any = await service.batchDelete(["cust-1", "cust-2"]).catch((e) => e);
    expect(sibling).toBeInstanceOf(ConflictException);
    expect(caught.message).toBe(sibling.message);
  });

  // ─── T8 (R5) — a SENT invoice blocks it too ────────────────────────────────

  it("T8: throws ConflictException naming the blocking customer + SENT count, and deletes nothing", async () => {
    (prisma.invoice.groupBy as jest.Mock).mockImplementation(blockOnStatus("SENT", "cust-2", 1));

    const caught: any = await service.deleteAllCustomers().catch((e) => e);

    expect(caught).toBeInstanceOf(ConflictException);
    expect(caught.message).toContain("cust-2");
    expect(caught.message).toContain("1 invoice(s)");

    // Same query pin as T7 — the SENT blocker must be found by the sibling's own
    // ["PAID","SENT"] filter, not by some other lookup that happens to throw.
    expect(prisma.invoice.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["customerId"],
        where: expect.objectContaining({
          customerId: { in: ["cust-1", "cust-2"] },
          status: { in: ["PAID", "SENT"] },
        }),
      }),
    );

    // A fix that only checks PAID (narrowing the status list) would never see
    // this SENT-only blocker and would fall through to the transaction.
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  // ─── T9 (R6) — no blockers ⇒ the delete still happens (no over-correction) ─

  // Deliberately ONE test, not two. Asserting only "it still deletes" would restate
  // behaviour that already ships today and could never separate pre-fix from post-fix
  // code; the pre-flight assertion below is what makes this red now. The zero-customer
  // half rides along in the same test for the same reason — on its own it is
  // un-reddable, since the `customers.length === 0` short-circuit is untouched by
  // this change and a correct fix must skip the pre-flight there too.
  it("T9: no PAID/SENT blockers — runs the sibling's pre-flight, then deletes normally", async () => {
    (prisma.invoice.groupBy as jest.Mock).mockResolvedValue([]);

    const result = await service.deleteAllCustomers();

    // RED TODAY: deleteAllCustomers issues no pre-flight at all, so groupBy is never
    // called. Still red against an over-correcting fix that throws unconditionally.
    expect(prisma.invoice.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["customerId"],
        where: expect.objectContaining({
          customerId: { in: ["cust-1", "cust-2"] },
          status: { in: ["PAID", "SENT"] },
        }),
        _count: { _all: true },
      }),
    );
    expect(result).toEqual({ deleted: SEEDED_CUSTOMERS.length });
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);

    // Zero customers: the short-circuit must stay AHEAD of the new pre-flight —
    // no groupBy, no transaction, still { deleted: 0 }.
    (prisma.invoice.groupBy as jest.Mock).mockClear();
    (prisma.tenantTransaction as jest.Mock).mockClear();
    prisma.customer.findMany.mockResolvedValue([]);

    await expect(service.deleteAllCustomers()).resolves.toEqual({ deleted: 0 });
    expect(prisma.invoice.groupBy).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  // ─── T10 (R2, mirrored) — the null-tenant fall-through, closed here too ────

  // Same defect the financial-data wipe's T3 covers: forTenant() returns the UNSCOPED
  // client and tenantTransaction hands back the raw tx when there is no tenant
  // (prisma.service.ts), and DELETE /customers/all is reachable by SUPER_ADMIN, whose
  // tenantId is null. Without this refusal the listing, the pre-flight and the wipe all
  // span every tenant — and the ConflictException would enumerate other tenants' ids.
  it("T10: a null tenantId refuses with ForbiddenException before reading or deleting anything", async () => {
    prisma.getTenantId.mockReturnValue(null);

    await expect(service.deleteAllCustomers()).rejects.toThrow(ForbiddenException);

    expect(prisma.customer.findMany).not.toHaveBeenCalled();
    expect(prisma.invoice.groupBy).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  // ─── T11 — the 409 breakdown is bounded ────────────────────────────────────

  // batchDelete()'s blocker list is bounded by the caller's selection; this one is every
  // customer in the tenant, so the message must cap rather than emit a six-figure wall of
  // uuids. Under the cap the two messages stay byte-identical (pinned by T7).
  it("T11: caps the blocker enumeration instead of listing every customer in the tenant", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      customerId: `cust-${i}`,
      _count: { _all: 1 },
    }));
    prisma.customer.findMany.mockResolvedValue(
      many.map((b) => ({ id: b.customerId, userId: `user-${b.customerId}` })) as any,
    );
    (prisma.invoice.groupBy as jest.Mock).mockResolvedValue(many);

    const caught: any = await service.deleteAllCustomers().catch((e) => e);

    expect(caught).toBeInstanceOf(ConflictException);
    expect(caught.message).toContain("cust-9");
    expect(caught.message).not.toContain("cust-10");
    expect(caught.message).toContain("and 15 more");
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });
});
