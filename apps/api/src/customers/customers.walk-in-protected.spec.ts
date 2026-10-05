/**
 * SA-672a (e): the tenant's system walk-in customer (counter sales) can never be deactivated, deleted or
 * merged away: every sale to it would lose its customer. Each guarded entry point refuses with a 400 coded
 * WALK_IN_PROTECTED BEFORE any write; a bulk wipe skips the row instead.
 */
import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { EmailService } from "../email/email.service";

const WALK_IN = { id: "cust-walk", userId: "user-walk", deletedAt: null, isWalkIn: true };
const NORMAL = { id: "cust-1", userId: "user-1", deletedAt: null, isWalkIn: null };

describe("the walk-in customer is protected (WALK_IN_PROTECTED)", () => {
  let service: CustomersService;
  let prisma: any;

  beforeEach(async () => {
    const rows: Record<string, any> = { [WALK_IN.id]: WALK_IN, [NORMAL.id]: NORMAL };
    const scoped: any = {
      customer: {
        findUnique: jest.fn(async ({ where }: any) => rows[where.id] ?? null),
        findMany: jest.fn(async () => [WALK_IN]),
        deleteMany: jest.fn(),
        update: jest.fn(),
      },
      user: { update: jest.fn() },
      customerLink: { findFirst: jest.fn(async () => null) },
      order: { count: jest.fn(async () => 0), updateMany: jest.fn() },
      invoice: {
        count: jest.fn(async () => 0),
        groupBy: jest.fn(async () => []),
        updateMany: jest.fn(),
      },
    };
    prisma = {
      customer: { findFirst: jest.fn(async ({ where }: any) => rows[where.id] ?? null) },
      customerLink: scoped.customerLink,
      forTenant: () => scoped,
      scoped,
      getTenantId: () => "t1",
      tenantTransaction: jest.fn(),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        ...[
          ConfigService,
          StorageService,
          MeterService,
          PlanCatalogService,
          EntitlementAuthority,
          CommissionEngineService,
          RegulatedLedgerService,
          EmailService,
        ].map((provide) => ({ provide, useValue: {} })),
      ],
    }).compile();
    service = mod.get(CustomersService);
  });

  const protectedError = async (p: Promise<unknown>) => {
    const e: any = await p.then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.getResponse()).toMatchObject({ code: "WALK_IN_PROTECTED" });
  };

  it.each(["INACTIVE", "SUSPENDED"])("deactivating it (status %s) is refused", async (status) => {
    await protectedError(service.changeStatus(WALK_IN.id, { status } as never));
    expect(prisma.scoped.user.update).not.toHaveBeenCalled();
  });

  it("re-activating it is harmless and allowed", async () => {
    prisma.scoped.user.update.mockResolvedValue({ id: "user-walk", status: "ACTIVE" });
    await expect(
      service.changeStatus(WALK_IN.id, { status: "ACTIVE" } as never),
    ).resolves.toBeDefined();
  });

  it("an ordinary customer still deactivates", async () => {
    prisma.scoped.user.update.mockResolvedValue({ id: "user-1", status: "INACTIVE" });
    await service.changeStatus(NORMAL.id, { status: "INACTIVE" } as never);
    expect(prisma.scoped.user.update).toHaveBeenCalled();
  });

  it("deleting it (single, forced or not) is refused before any count or write", async () => {
    await protectedError(service.deleteCustomer(WALK_IN.id, true));
    await protectedError(service.deleteCustomer(WALK_IN.id));
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.scoped.order.count).not.toHaveBeenCalled();
  });

  it("a batch delete reports it as failed (it goes through deleteCustomer) and deletes nothing", async () => {
    const r = await service.batchDelete([WALK_IN.id]);
    expect(r.deleted).toBe(0);
    expect(r.failed).toEqual([{ id: WALK_IN.id, reason: expect.stringMatching(/walk-in/i) }]);
  });

  it("merging it as either side is refused", async () => {
    await protectedError(service.mergeCustomers(WALK_IN.id, NORMAL.id));
    await protectedError(service.mergeCustomers(NORMAL.id, WALK_IN.id));
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  it("delete-all skips it: a tenant holding only the walk-in deletes nothing", async () => {
    await expect(service.deleteAllCustomers()).resolves.toEqual({ deleted: 0 });
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  it("a portal invite (and a resend) for it is refused before anything is written", async () => {
    await protectedError(
      service.sendPortalInvite(WALK_IN.id, { method: "EMAIL", overrideEmail: "a@b.co" }, "t1"),
    );
    prisma.customerLink.findFirst.mockResolvedValue({ status: "INVITED", inviteMethod: "EMAIL" });
    await protectedError(service.resendPortalInvite(WALK_IN.id, "t1"));
  });

  describe("hidden from the customer list and export by default", () => {
    // OR is the search clause's key: the walk-in filter must not collide with it.
    const keepsNullAndFalse = (where: any) => {
      const clause = (where.AND ?? []).find((c: any) => Array.isArray(c.OR));
      expect(clause).toEqual({ OR: [{ isWalkIn: null }, { isWalkIn: false }] });
    };

    it("findAll's where (page and count) excludes isWalkIn=true but keeps NULL rows, alongside a search", async () => {
      prisma.scoped.customer.findMany.mockResolvedValue([]);
      prisma.scoped.customer.count = jest.fn(async () => 0);
      prisma.scoped.invoice.findMany = jest.fn(async () => []);
      prisma.scoped.advancePayment = { findMany: jest.fn(async () => []) };
      await service.findAll({ page: 1, limit: 20, search: "walk" } as never);
      const where = prisma.scoped.customer.findMany.mock.calls[0][0].where;
      keepsNullAndFalse(where);
      expect(where.OR).toBeDefined(); // the search clause survives
      keepsNullAndFalse(prisma.scoped.customer.count.mock.calls[0][0].where);
    });

    it("the CSV export uses the same where", async () => {
      prisma.scoped.customer.findMany.mockResolvedValue([]);
      await service.exportCustomers({} as never).catch(() => undefined);
      keepsNullAndFalse(prisma.scoped.customer.findMany.mock.calls[0][0].where);
    });
  });
});
