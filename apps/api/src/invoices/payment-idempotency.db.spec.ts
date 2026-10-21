/**
 * DB twin for SA-824 (row 661 step 1): a customer payment submitted twice with the same
 * `Idempotency-Key` records ONE payment set, against real Postgres.
 *
 * WHY THE DB LANE: the guarantee is a transaction/race shape. The claim is the first statement of
 * the writer's own transaction (`INSERT ... ON CONFLICT ("tenantId","key") DO NOTHING RETURNING
 * id`), and only Postgres can show that a concurrent duplicate WAITS on the unique index for the
 * first transaction and then sees its committed row. This drives the REAL InvoicesService through
 * TWO PrismaService instances (two pools, so two connections), with the winner held open inside
 * its money transaction (the SA-818 `inTx` seam) while the duplicate is in flight.
 *
 *  - T1 (MUST b): concurrent same-key submits on two connections give exactly one payment set; the
 *    loser waits for the winner's commit, then returns the winner's result (`replayed: true`).
 *  - T2 (MUST d): a throw after the claim commits no key and no money; a retry with the same key
 *    records exactly once.
 *  - T3 (MUST g): the same key in two tenants records two independent payments.
 *
 * SAFETY: throwaway `qa-sa824-<run>-<n>-<label>` tenants only (`assertTestTenant`); `afterAll`
 * deletes exactly what this run created.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-sa824-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "payment-idempotency.db.spec.ts",
  );
}

/** One InvoicesService on its OWN PrismaService (its own pool = its own connections). */
async function buildInvoices(prisma: PrismaService, tenantCtx: TenantContextService) {
  const module = await Test.createTestingModule({
    providers: [
      InvoicesService,
      NumberingService,
      {
        provide: SellingRestrictionsService,
        useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: PrismaService, useValue: prisma },
      { provide: TenantContextService, useValue: tenantCtx },
      { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
      { provide: EmailService, useValue: { sendInvoice: jest.fn(), isEmailConfigured: jest.fn() } },
      { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
      {
        provide: SystemConfigService,
        useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
      },
      {
        provide: RegulatedLedgerService,
        useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
      },
      {
        provide: AuthorizationGuardService,
        useValue: {
          assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
          checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
        },
      },
      {
        provide: CreditNotesService,
        useValue: {
          autoApplyOldestCreditsInTx: jest
            .fn()
            .mockResolvedValue({ applied: 0, invoiceStatus: null }),
          releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
        },
      },
      {
        provide: MessagingService,
        useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
      },
      { provide: StorageService, useValue: {} },
      { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
      { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
      {
        provide: CommissionEngineService,
        useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
      },
    ],
  }).compile();
  return module.get(InvoicesService);
}

describeDb(
  "SA-824 payment Idempotency-Key claims inside the money transaction — real Postgres",
  () => {
    let tenantCtx: TenantContextService;
    let prismaA: PrismaService;
    let prismaB: PrismaService;
    let invoicesA: InvoicesService;
    let invoicesB: InvoicesService;
    const createdTenantIds: string[] = [];

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prismaA = new PrismaService(tenantCtx);
      prismaB = new PrismaService(tenantCtx);
      await prismaA.$connect();
      await prismaB.$connect();
      invoicesA = await buildInvoices(prismaA, tenantCtx);
      invoicesB = await buildInvoices(prismaB, tenantCtx);
    });

    afterAll(async () => {
      for (const tenantId of createdTenantIds) {
        // eslint-disable-next-line no-await-in-loop
        await cleanupTenant(tenantId).catch(() => undefined);
      }
      await prismaA?.$disconnect();
      await prismaB?.$disconnect();
    });

    async function cleanupTenant(tenantId: string): Promise<void> {
      await prismaA.paymentIdempotencyKey.deleteMany({ where: { tenantId } });
      await prismaA.advancePayment.deleteMany({ where: { tenantId } });
      await prismaA.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
      await prismaA.invoice.deleteMany({ where: { tenantId } });
      await prismaA.paymentCounter.deleteMany({ where: { id: tenantId } });
      await prismaA.customer.deleteMany({ where: { tenantId } });
      await prismaA.user.deleteMany({ where: { tenantId } });
      await prismaA.tenant.delete({ where: { id: tenantId } });
    }

    async function seed(label: string) {
      const slug = freshTenantSlug(label);
      const tenant = await prismaA.tenant.create({ data: { slug, name: `SA824 ${slug}` } });
      createdTenantIds.push(tenant.id);
      const user = await prismaA.user.create({
        data: {
          email: `${tenant.id}@example.invalid`,
          username: tenant.id,
          role: "CUSTOMER",
          tenantId: tenant.id,
        },
      });
      const customer = await prismaA.customer.create({
        data: {
          userId: user.id,
          businessName: "SA824 customer",
          contactName: "SA824 contact",
          tenantId: tenant.id,
        },
      });
      const invoice = await prismaA.invoice.create({
        data: {
          tenantId: tenant.id,
          customerId: customer.id,
          invoiceNumber: `INV-SEED-${randomUUID().slice(0, 8)}`,
          status: "SENT",
          subtotal: 1000,
          total: 1000,
        },
      });
      const dto = {
        customerId: customer.id,
        totalAmount: 300,
        method: "CASH",
        reference: "receipt 7",
        paidAt: "2026-10-20",
        allocations: [{ invoiceId: invoice.id, amount: 300 }],
      } as any;
      const asTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenant.id, fn);
      const state = async () => ({
        payments: await prismaA.invoicePayment.findMany({ where: { invoiceId: invoice.id } }),
        keys: await prismaA.paymentIdempotencyKey.findMany({ where: { tenantId: tenant.id } }),
      });
      return { tenant, dto, asTenant, state };
    }

    it("T1 (b) two connections, same key, concurrent: exactly one payment set; the loser waits for the winner's commit and replays its result", async () => {
      const { dto, asTenant, state } = await seed("t1");
      const key = `race-${randomUUID()}`;
      let winnerInTx!: () => void;
      const winnerHoldsKey = new Promise<void>((r) => (winnerInTx = r));
      let releasedAt = 0;

      // A claims and writes, then holds its transaction open for 800ms inside the money tx.
      const winner = asTenant(() =>
        invoicesA.recordStandalonePayment(dto, {
          idempotencyKey: key,
          inTx: async () => {
            winnerInTx();
            await new Promise((r) => setTimeout(r, 800));
            releasedAt = Date.now();
          },
        }),
      );
      await winnerHoldsKey;
      // B starts while A's claim is uncommitted: its pre-read sees nothing, its claim WAITS on the index.
      let loserDoneAt = 0;
      const loser = asTenant(() =>
        invoicesB.recordStandalonePayment(dto, { idempotencyKey: key }).then((r) => {
          loserDoneAt = Date.now(); // the loser's OWN resolve time, not the Promise.all's
          return r;
        }),
      );

      const [w, l]: any[] = await Promise.all([winner, loser]);

      expect(w.replayed).toBeUndefined();
      expect(l.replayed).toBe(true);
      expect(l.paymentGroupId).toBe(w.paymentGroupId);
      expect(releasedAt).toBeGreaterThan(0);
      expect(loserDoneAt).toBeGreaterThanOrEqual(releasedAt); // it waited for the winner's commit
      const after = await state();
      expect(after.payments).toHaveLength(1);
      expect(after.payments[0].paymentGroupId).toBe(w.paymentGroupId);
      expect(after.keys).toHaveLength(1);
      expect(after.keys[0]).toMatchObject({
        scope: "STANDALONE_PAYMENT",
        paymentGroupId: w.paymentGroupId,
      });
    }, 60_000);

    it("T2 (d) a throw after the claim commits no key and no money; the same-key retry records once", async () => {
      const { dto, asTenant, state } = await seed("t2");
      const key = `fail-${randomUUID()}`;

      await expect(
        asTenant(() =>
          invoicesA.recordStandalonePayment(dto, {
            idempotencyKey: key,
            inTx: async () => {
              throw new Error("injected failure after the claim");
            },
          }),
        ),
      ).rejects.toThrow("injected failure after the claim");
      const afterFailure = await state();
      expect({ payments: afterFailure.payments.length, keys: afterFailure.keys.length }).toEqual({
        payments: 0,
        keys: 0,
      });

      const retry: any = await asTenant(() =>
        invoicesB.recordStandalonePayment(dto, { idempotencyKey: key }),
      );
      expect(retry.replayed).toBeUndefined();
      const afterRetry = await state();
      expect({ payments: afterRetry.payments.length, keys: afterRetry.keys.length }).toEqual({
        payments: 1,
        keys: 1,
      });
    }, 60_000);

    it("T3 (g) the same key in two tenants records two independent payments", async () => {
      const one = await seed("t3a");
      const two = await seed("t3b");
      const key = `shared-${randomUUID()}`;

      const a: any = await one.asTenant(() =>
        invoicesA.recordStandalonePayment(one.dto, { idempotencyKey: key }),
      );
      const b: any = await two.asTenant(() =>
        invoicesB.recordStandalonePayment(two.dto, { idempotencyKey: key }),
      );

      expect(b.replayed).toBeUndefined();
      expect(b.paymentGroupId).not.toBe(a.paymentGroupId);
      expect((await one.state()).payments).toHaveLength(1);
      expect((await two.state()).payments).toHaveLength(1);
    }, 60_000);
  },
);
