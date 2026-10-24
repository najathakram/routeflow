/**
 * W-763 (SA-903): mergeCustomers merges two customers of ONE business only.
 *
 * POST /customers/merge is @Roles(OPERATOR), and SUPER_ADMIN satisfies every role, so a merge can run with NO tenant.
 * Then `forTenant()` is unscoped, and both customers load whatever business they belong to. Nothing compared the two
 * tenantIds, so one business's orders, invoices, estimates, credit notes and returns could be re-pointed under another
 * business's customer. The merge now refuses with a 400 (`CUSTOMER_MERGE_TENANT_MISMATCH`) BEFORE its transaction when:
 * the two tenantIds differ, either is null, or a tenant session does not own them. The message names no tenant.
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
import { API_ERROR_CODES } from "../common/api-error-codes";
import { createOpLogTx } from "../testing/op-log-tx";

const TENANT_A = "tenant-acme-a";
const TENANT_B = "tenant-acme-b";
const customer = (id: string, tenantId: string | null) => ({
  id,
  tenantId,
  userId: `user-${id}`,
  deletedAt: null,
});

/** A CustomersService whose `forTenant()` hands back exactly these rows (a leak, if the session does not own them). */
async function build(session: string | null, rows: Array<ReturnType<typeof customer>>) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const { tx, log } = createOpLogTx((op, args) =>
    op === "customer.findUnique" ? byId.get(args?.where?.id) : undefined,
  );
  const prisma = {
    forTenant: () => ({
      customer: { findUnique: async ({ where }: any) => byId.get(where.id) ?? null },
    }),
    tenantTransaction: jest.fn((fn: (t: any) => unknown) => fn(tx)),
    getTenantId: () => session,
  };
  const module = await Test.createTestingModule({
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
  return { service: module.get(CustomersService), prisma, log };
}

/** Rejects with the registered 400, opens no transaction, writes nothing, and names neither tenant. */
async function expectRefused(
  session: string | null,
  primary: ReturnType<typeof customer>,
  secondary: ReturnType<typeof customer>,
) {
  const { service, prisma, log } = await build(session, [primary, secondary]);
  const err = await service.mergeCustomers(primary.id, secondary.id).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  const body = (err as BadRequestException).getResponse() as { code?: string; message?: string };
  expect(body.code).toBe(API_ERROR_CODES.CUSTOMER_MERGE_TENANT_MISMATCH);
  expect(JSON.stringify(body)).not.toMatch(/tenant-acme/);
  expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  expect(log).toEqual([]);
}

describe("mergeCustomers — both customers of one business (W-763, SA-903)", () => {
  it("T1: refuses two customers of DIFFERENT businesses under a tenantless (SUPER_ADMIN) session", async () => {
    await expectRefused(null, customer("p", TENANT_A), customer("s", TENANT_B));
  });

  it.each([
    ["the secondary has no tenantId", TENANT_A, null],
    ["the primary has no tenantId", null, TENANT_A],
    ["neither has a tenantId", null, null],
  ])("T2: refuses when %s", async (_label, pt: string | null, st: string | null) => {
    await expectRefused(null, customer("p", pt), customer("s", st));
  });

  it.each([[TENANT_A], [null]])(
    "T3: merges two customers of ONE business (session %s)",
    async (session: string | null) => {
      const primary = customer("p", TENANT_A);
      const { service, prisma } = await build(session, [primary, customer("s", TENANT_A)]);
      await expect(service.mergeCustomers("p", "s")).resolves.toEqual(primary);
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    },
  );

  it("T4: refuses two customers of one business that the session's (different) business does not own", async () => {
    await expectRefused(TENANT_B, customer("p", TENANT_A), customer("s", TENANT_A));
  });
});
