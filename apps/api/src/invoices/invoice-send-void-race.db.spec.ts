/**
 * B214 (train 4 Run A) — DB-lane repro: `deleteInvoice` must refuse (409
 * INVOICE_HAS_UNSPENT_CREDIT) while a credit note it sourced still has an unspent balance,
 * instead of unlinking it (`invoiceId: null`) and deleting the invoice out from under it.
 * Design of record: `.claude/pipeline/2026-09-10-train4-run-a/cause-ruling.md`;
 * test plan: `.claude/pipeline/2026-09-10-train4-run-a/bug-test-plan.md` (T9, T10, P5-P7).
 *
 * WHY THE DB LANE: the FK's `ON DELETE SET NULL` behavior (`0_init/migration.sql:3783`) and
 * whether a rolled-back transaction actually leaves the credit note linked are only provable
 * against a REAL Postgres — a mocked `tx.invoice.delete` can't reproduce either. Collected only
 * by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`
 * (`node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api"`), which points
 * DATABASE_URL at the compose Postgres and sets RUN_DB_SPECS. `requireLocalDatabaseUrl()`
 * refuses any non-local host.
 *
 * This spec drives the REAL `InvoicesService.deleteInvoice()` through a NestJS TestingModule
 * wired with a REAL `PrismaService` (bound to the compose DB) and a REAL `TenantContextService`,
 * with every OTHER collaborator mocked at the module boundary exactly as
 * `invoice-numbering.db.spec.ts` does (same jest.mock shims for `InvoicePdfService` /
 * `compressDocument` — ESM traversal guard).
 *
 * SAFETY: every tenant this file creates is a throwaway `qa-f2-2255-<run>-<n>-<label>` slug,
 * approved by `assertTestTenant` (`scripts/lib/test-tenants.cjs`); `afterAll` deletes exactly the
 * tenants THIS run created, in FK order (CreditNote → InvoiceItem → Invoice → Customer → User →
 * Tenant), best-effort, never anyone else's rows.
 *
 * SELF-CONTAINED ORACLES: T9 and T10 each seed their own tenant/invoice/credit-note trio, so
 * neither test's expectation depends on a sibling having run first.
 */

// Prevent Jest from traversing ESM-only dependencies (same guard as invoices.service.spec.ts /
// invoice-numbering.db.spec.ts).
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { AfterCommit } from "../common/after-commit";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
/** A fresh, policy-approved throwaway tenant slug — never reused across tests in this file. */
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-f2-2255-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "invoice-send-void-race-sa404.db.spec.ts",
  );
}

describeDb(
  "SA-404 (#2255) send/void re-check under the Invoice lock — two real connections",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoicesService: InvoicesService;
    const createdTenantIds: string[] = [];

    const mockGateway = {
      emitInvoiceUpdated: jest.fn(),
      emitOrderCreated: jest.fn(),
      emitOrderStatusChanged: jest.fn(),
      emitLowStock: jest.fn(),
      emitStopCompleted: jest.fn(),
      emitUrgentOrder: jest.fn(),
    };
    const mockEmailService = {
      sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
      isEmailConfigured: jest.fn().mockResolvedValue(true),
    };
    const mockSystemConfig = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const mockCreditNotes = {
      autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
      settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
      releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
    };
    const mockMessaging = {
      notify: jest.fn().mockResolvedValue([]),
      notifyEvent: jest.fn().mockResolvedValue(undefined),
    };
    const mockStorage = {
      upload: jest.fn().mockResolvedValue("stored"),
      presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    // flag.msrp OFF: applyMsrpSnapshots no-ops.
    const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
    const mockCommissionEngine = {
      syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
      syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
      removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
    };

    beforeAll(async () => {
      // Nothing env-dependent may run at collection time (db-lane rule): the real connection is
      // built here, inside a hook, never at module top level.
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          InvoicesService,
          {
            provide: SellingRestrictionsService,
            useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
          },
          EstimatesService,
          NumberingService,
          { provide: PrismaService, useValue: prisma },
          { provide: RouteFlowGateway, useValue: mockGateway },
          { provide: EmailService, useValue: mockEmailService },
          { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
          { provide: SystemConfigService, useValue: mockSystemConfig },
          {
            provide: RegulatedLedgerService,
            useValue: {
              writeSaleEntries: jest.fn(),
              reverseInvoiceEntries: jest.fn(),
              syncInvoiceEntries: jest.fn(),
            },
          },
          {
            provide: AuthorizationGuardService,
            useValue: {
              assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
              checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
            },
          },
          { provide: CreditNotesService, useValue: mockCreditNotes },
          { provide: MessagingService, useValue: mockMessaging },
          { provide: StorageService, useValue: mockStorage },
          { provide: EntitlementsService, useValue: mockEntitlements },
          entitlementAuthorityFromEntitlements, // #2241
          { provide: CommissionEngineService, useValue: mockCommissionEngine },
        ],
      }).compile();

      invoicesService = module.get(InvoicesService);
    });

    afterAll(async () => {
      for (const tenantId of createdTenantIds) {
        // eslint-disable-next-line no-await-in-loop
        await cleanupTenant(tenantId).catch(() => {
          // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
        });
      }
      await prisma?.$disconnect();
    });

    // ─── F2 throwaway (#2258 / SA-404): T2 = a raw pg client holding the Invoice row lock ───
    const { Client } = require("pg");
    const url = () => process.env.DATABASE_URL as string;
    async function cleanupTenant(tenantId: string): Promise<void> {
      // B562 PR-2 pin below: its SALE rows and order lines go before their order and product.
      await prisma.stockMovement.deleteMany({ where: { product: { tenantId } } });
      await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
      await prisma.invoicePayment.deleteMany({ where: { tenantId } });
      await prisma.invoiceItem.deleteMany({ where: { tenantId } });
      await prisma.invoice.deleteMany({ where: { tenantId } });
      await prisma.order.deleteMany({ where: { tenantId } });
      await prisma.product.deleteMany({ where: { tenantId } });
      await prisma.paymentCounter.deleteMany({ where: { id: tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
    async function seed(label: string, status: "DRAFT" | "SENT") {
      const slug = freshTenantSlug(label);
      const tenant = await prisma.tenant.create({ data: { slug, name: `F2 2255 ${slug}` } });
      createdTenantIds.push(tenant.id);
      const idBase = `${tenant.id}-${label}`;
      const user = await prisma.user.create({
        data: {
          email: `${idBase}@example.invalid`,
          username: idBase,
          role: "CUSTOMER",
          tenantId: tenant.id,
        },
      });
      const customer = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: `F2 ${label}`,
          contactName: "F2",
          email: `${idBase}@example.invalid`,
          tenantId: tenant.id,
        } as any,
      });
      const inv = await prisma.invoice.create({
        data: {
          tenantId: tenant.id,
          customerId: customer.id,
          invoiceNumber: `INV-F2-2255-${RUN_SUFFIX}-${label}`,
          status,
          subtotal: 50,
          total: 50,
          items: {
            create: [
              { tenantId: tenant.id, description: "f2 line", qty: 1, unitPrice: 50, subtotal: 50 },
            ],
          },
        } as any,
      });
      return { tenantId: tenant.id, invoiceId: inv.id };
    }
    /** T2 takes the Invoice row lock; T1 starts and must be BLOCKED on it (after its pre-read); T2 runs `between`, COMMITs. */
    async function interleave(
      invoiceId: string,
      t1: () => Promise<unknown>,
      between: (c: any) => Promise<void>,
    ) {
      const t2 = new Client({ connectionString: url() });
      await t2.connect();
      try {
        await t2.query("BEGIN");
        await t2.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [invoiceId]);
        const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const p1 = t1().then(
          (v) => ({ ok: true as const, v }),
          (e) => ({ ok: false as const, e }),
        );
        let blocked = false;
        for (let i = 0; i < 800 && !blocked; i++) {
          const r = await t2.query(
            `SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
            [pid],
          );
          blocked = r.rows[0].n > 0;
          if (!blocked) await new Promise((x) => setTimeout(x, 25));
        }
        if (!blocked) {
          await between(t2);
          await t2.query("COMMIT");
          const r0 = await p1;
          return { ...r0, notBlocked: true } as any;
        }
        await between(t2);
        await t2.query("COMMIT");
        return await p1;
      } finally {
        await t2.end();
      }
    }
    const status400 = (r: any) => !r.ok && (r.e?.getStatus?.() ?? r.e?.status) === 400;
    const emails = () => mockEmailService.sendInvoice.mock.calls.length;
    /** A REAL 40001 raised by a trigger on the FIRST update of this invoice only (a sequence is non-transactional). */
    async function armOnce40001(invoiceId: string) {
      const tag = invoiceId.replace(/-/g, "").slice(0, 12);
      await prisma.$executeRawUnsafe(`CREATE SEQUENCE f2_once_${tag}`);
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION f2_raise_${tag}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${invoiceId}' AND nextval('f2_once_${tag}') = 1 THEN RAISE EXCEPTION 'f2 forced conflict' USING ERRCODE = '40001'; END IF; RETURN NEW; END $$`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER f2_trg_${tag} BEFORE UPDATE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION f2_raise_${tag}()`,
      );
      return async () => {
        const fired = Number(
          (
            await prisma.$queryRawUnsafe<any[]>(`SELECT last_value, is_called FROM f2_once_${tag}`)
          )[0].last_value,
        );
        await prisma.$executeRawUnsafe(`DROP TRIGGER f2_trg_${tag} ON "Invoice"`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION f2_raise_${tag}()`);
        await prisma.$executeRawUnsafe(`DROP SEQUENCE f2_once_${tag}`);
        return fired;
      };
    }

    it("(a1) send(): VOID committed between the pre-read and the lock ⇒ 400, status stays VOID, no sentAt, no email", async () => {
      const s = await seed("a1", "DRAFT");
      const e0 = emails();
      const r = await interleave(
        s.invoiceId,
        () =>
          tenantCtx.run(s.tenantId, () =>
            invoicesService.send(s.invoiceId, { allowPreDelivery: true }),
          ),
        async (c) => {
          await c.query(`UPDATE "Invoice" SET status='VOID' WHERE id=$1`, [s.invoiceId]);
        },
      );
      expect(status400(r)).toBe(true);
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
      expect(inv.status).toBe("VOID");
      expect(inv.sentAt).toBeNull();
      expect(emails() - e0).toBe(0);
    });

    it("(a2) sendEmail(): VOID committed between the pre-read and the lock ⇒ 400, status stays VOID, and NO email", async () => {
      const s = await seed("a2", "DRAFT");
      const e0 = emails();
      const r = await interleave(
        s.invoiceId,
        () => tenantCtx.run(s.tenantId, () => invoicesService.sendEmail(s.invoiceId)),
        async (c) => {
          await c.query(`UPDATE "Invoice" SET status='VOID' WHERE id=$1`, [s.invoiceId]);
        },
      );
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
      expect({ is400: status400(r), status: inv.status, emailsSent: emails() - e0 }).toEqual({
        is400: true,
        status: "VOID",
        emailsSent: 0,
      });
      // 60 s, not the lane's 30 s default: the first sendEmail of a run pays a cold warm-up
      // (F2 measured 22–25 s once), and a timeout there is a false red, not a race result.
    }, 60_000);

    // SA-404b documented residual, red BY DESIGN: a bare payment INSERT that never touches the
    // Invoice row is invisible to void's Serializable snapshot. No production writer does that —
    // invoice-payment-writers.coverage.spec.ts pins it (SA-404a b1 / SA-404d R2) — so it is skipped.
    it.skip("(b1) voidInvoice(): a CASH payment row INSERTED ALONE (invoice row untouched) between the pre-read and the lock ⇒ 400, invoice NOT voided", async () => {
      const s = await seed("b", "SENT");
      const r = await interleave(
        s.invoiceId,
        () => tenantCtx.run(s.tenantId, () => invoicesService.voidInvoice(s.invoiceId)),
        async (c) => {
          await c.query(
            `INSERT INTO "InvoicePayment" (id, "tenantId", "invoiceId", amount, method, status, "paidAt", "createdAt") VALUES (gen_random_uuid()::text, $1, $2, 20, 'CASH', 'PAID', now(), now())`,
            [s.tenantId, s.invoiceId],
          );
        },
      );
      expect(status400(r)).toBe(true);
      expect(
        (await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } })).status,
      ).not.toBe("VOID");
    });

    it("(b2) voidInvoice(): a CASH payment committed the way recordPayment writes it (payment + Invoice row update) between the pre-read and the lock ⇒ 400, invoice NOT voided", async () => {
      const s = await seed("b2", "SENT");
      const r = await interleave(
        s.invoiceId,
        () => tenantCtx.run(s.tenantId, () => invoicesService.voidInvoice(s.invoiceId)),
        async (c) => {
          await c.query(
            `INSERT INTO "InvoicePayment" (id, "tenantId", "invoiceId", amount, method, status, "paidAt", "createdAt") VALUES (gen_random_uuid()::text, $1, $2, 20, 'CASH', 'PAID', now(), now())`,
            [s.tenantId, s.invoiceId],
          );
          await c.query(
            `UPDATE "Invoice" SET status = 'PARTIAL', "updatedAt" = now() WHERE id = $1`,
            [s.invoiceId],
          );
        },
      );
      expect((r as any).notBlocked).toBeUndefined();
      expect(status400(r)).toBe(true);
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } })).status).toBe(
        "PARTIAL",
      );
    });

    it("(c1) send(): a forced 40001 on attempt 1 ⇒ the retry succeeds ONCE (status SENT, sentAt set)", async () => {
      const s = await seed("c1", "DRAFT");
      const disarm = await armOnce40001(s.invoiceId);
      try {
        await tenantCtx.run(s.tenantId, () =>
          invoicesService.send(s.invoiceId, { allowPreDelivery: true }),
        );
      } finally {
        expect(await disarm()).toBeGreaterThanOrEqual(2);
      }
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
      expect(inv.status).toBe("SENT");
      expect(inv.sentAt).not.toBeNull();
    });

    it("(c2) sendEmail(): a forced 40001 on attempt 1 ⇒ one email, one SENT", async () => {
      const s = await seed("c2", "DRAFT");
      const e0 = emails();
      const disarm = await armOnce40001(s.invoiceId);
      try {
        await tenantCtx.run(s.tenantId, () => invoicesService.sendEmail(s.invoiceId));
      } finally {
        expect(await disarm()).toBeGreaterThanOrEqual(2);
      }
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } })).status).toBe(
        "SENT",
      );
      expect(emails() - e0).toBe(1);
    });

    it("(c3) voidInvoice(): a forced 40001 on attempt 1 ⇒ the retry voids ONCE", async () => {
      const s = await seed("c3", "SENT");
      const disarm = await armOnce40001(s.invoiceId);
      try {
        await tenantCtx.run(s.tenantId, () => invoicesService.voidInvoice(s.invoiceId));
      } finally {
        expect(await disarm()).toBeGreaterThanOrEqual(2);
      }
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } })).status).toBe(
        "VOID",
      );
    });

    it("(d) controls: plain send → SENT; plain sendEmail → SENT + 1 email; plain void → VOID", async () => {
      const a = await seed("d1", "DRAFT");
      await tenantCtx.run(a.tenantId, () =>
        invoicesService.send(a.invoiceId, { allowPreDelivery: true }),
      );
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: a.invoiceId } })).status).toBe(
        "SENT",
      );
      const b = await seed("d2", "DRAFT");
      const e0 = emails();
      await tenantCtx.run(b.tenantId, () => invoicesService.sendEmail(b.invoiceId));
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: b.invoiceId } })).status).toBe(
        "SENT",
      );
      expect(emails() - e0).toBe(1);
      const c = await seed("d3", "SENT");
      await tenantCtx.run(c.tenantId, () => invoicesService.voidInvoice(c.invoiceId));
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: c.invoiceId } })).status).toBe(
        "VOID",
      );
    });

    // ─── cac84c18 additions (SA-404a/b) ───
    const msg = (r: any) => (r.ok ? null : String(r.e?.message ?? r.e));
    const retryWarns = (spy: jest.SpyInstance, label: string) =>
      spy.mock.calls.filter((c) => String(c[0]).includes(label)).length;

    it("(a2-msg) sendEmail(): VOID committed BEFORE the pre-check ⇒ 400 'Cannot send a voided invoice', no email, VOID", async () => {
      const s = await seed("a2m", "DRAFT");
      const e0 = emails();
      const r = await interleave(
        s.invoiceId,
        () => tenantCtx.run(s.tenantId, () => invoicesService.sendEmail(s.invoiceId)),
        async (c) => {
          await c.query(`UPDATE "Invoice" SET status='VOID' WHERE id=$1`, [s.invoiceId]);
        },
      );
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
      expect({
        blocked: (r as any).notBlocked === undefined,
        is400: status400(r),
        msg: msg(r),
        status: inv.status,
        sentAt: inv.sentAt,
        emailsSent: emails() - e0,
      }).toEqual({
        blocked: true,
        is400: true,
        msg: "Cannot send a voided invoice",
        status: "VOID",
        sentAt: null,
        emailsSent: 0,
      });
    });

    it("(a3) sendEmail(): VOID committed between the pre-check and markSent (during the email I/O) ⇒ email ONCE, 400 VOIDED_DURING_EMAIL, status stays VOID", async () => {
      const { VOIDED_DURING_EMAIL } = require("./invoice-send-guard");
      const s = await seed("a3", "DRAFT");
      const e0 = emails();
      let statusSeenInEmail: string | null = null;
      mockEmailService.sendInvoice.mockImplementationOnce(async () => {
        const c = new Client({ connectionString: url() });
        await c.connect();
        try {
          statusSeenInEmail = (
            await c.query(`SELECT status FROM "Invoice" WHERE id=$1`, [s.invoiceId])
          ).rows[0].status;
          await c.query(`UPDATE "Invoice" SET status='VOID' WHERE id=$1`, [s.invoiceId]);
        } finally {
          await c.end();
        }
        return { delivered: true, transport: "resend" };
      });
      const r: any = await tenantCtx
        .run(s.tenantId, () => invoicesService.sendEmail(s.invoiceId))
        .then(
          (v: any) => ({ ok: true, v }),
          (e: any) => ({ ok: false, e }),
        );
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
      expect({
        statusSeenInEmail,
        is400: status400(r),
        msg: msg(r),
        status: inv.status,
        sentAt: inv.sentAt,
        emailsSent: emails() - e0,
      }).toEqual({
        statusSeenInEmail: "DRAFT",
        is400: true,
        msg: VOIDED_DURING_EMAIL,
        status: "VOID",
        sentAt: null,
        emailsSent: 1,
      });
    });

    it("(a4) sendEmail(): a REAL 40001 inside the pre-check tx (row updated by a committed T2 after its snapshot) ⇒ retried, ONE email, SENT", async () => {
      const { Logger } = require("@nestjs/common");
      const warn = jest.spyOn(Logger.prototype, "warn");
      try {
        const s = await seed("a4", "DRAFT");
        const e0 = emails();
        let emailsWhenPrecheckBlocked = -1;
        const r: any = await interleave(
          s.invoiceId,
          () => tenantCtx.run(s.tenantId, () => invoicesService.sendEmail(s.invoiceId)),
          async (c) => {
            emailsWhenPrecheckBlocked = emails() - e0;
            await c.query(`UPDATE "Invoice" SET "updatedAt"=now() WHERE id=$1`, [s.invoiceId]);
          },
        );
        const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
        expect({
          ok: r.ok,
          err: r.ok ? null : msg(r),
          blocked: r.notBlocked === undefined,
          emailsWhenPrecheckBlocked,
          precheckRetries: retryWarns(warn, `invoice send pre-check id=${s.invoiceId}`),
          status: inv.status,
          emailsSent: emails() - e0,
        }).toEqual({
          ok: true,
          err: null,
          blocked: true,
          emailsWhenPrecheckBlocked: 0,
          precheckRetries: 1,
          status: "SENT",
          emailsSent: 1,
        });
      } finally {
        warn.mockRestore();
      }
    });

    it("(b1-ii) voidInvoice(): T2 records a REAL payment (invoicesService.recordPayment, CASH) between void's snapshot and its Invoice lock ⇒ T1 never voids (400 after retry)", async () => {
      const { Logger } = require("@nestjs/common");
      const warn = jest.spyOn(Logger.prototype, "warn");
      const s = await seed("b1ii", "SENT");
      try {
        const inv0 = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
        const order = await prisma.order.create({
          data: {
            tenantId: s.tenantId,
            customerId: inv0.customerId,
            orderNumber: `ORD-F2-${RUN_SUFFIX}-b1ii`,
          } as any,
        });
        await prisma.invoice.update({
          where: { id: s.invoiceId },
          data: { orderId: order.id } as any,
        });
        // T2raw holds the ORDER row: void's tx takes its snapshot, then blocks on the Order lock
        // (lockInvoiceRow locks Order → Invoice). recordPayment locks only the Invoice, so it commits meanwhile.
        const t2 = new Client({ connectionString: url() });
        await t2.connect();
        let r: any,
          payment: any,
          blocked = false;
        try {
          await t2.query("BEGIN");
          await t2.query(`SELECT id FROM "Order" WHERE id=$1 FOR UPDATE`, [order.id]);
          const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          const p1 = tenantCtx
            .run(s.tenantId, () => invoicesService.voidInvoice(s.invoiceId))
            .then(
              (v: any) => ({ ok: true, v }),
              (e: any) => ({ ok: false, e }),
            );
          for (let i = 0; i < 800 && !blocked; i++) {
            const q = await t2.query(
              `SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
              [pid],
            );
            blocked = q.rows[0].n > 0;
            if (!blocked) await new Promise((x) => setTimeout(x, 25));
          }
          payment = await tenantCtx.run(s.tenantId, () =>
            invoicesService.recordPayment(s.invoiceId, { amount: 20, method: "CASH" } as any),
          );
          await t2.query("COMMIT");
          r = await p1;
        } finally {
          await t2.end();
        }
        const inv = await prisma.invoice.findUniqueOrThrow({
          where: { id: s.invoiceId },
          include: { payments: true },
        });
        expect({
          blocked,
          paymentId: !!payment?.createdPaymentId,
          voidOk: r.ok,
          is400: status400(r),
          msg: msg(r)?.slice(0, 40),
          voidRetries: retryWarns(warn, `invoice void id=${s.invoiceId}`),
          status: inv.status,
          payments: inv.payments.map((p: any) => `${p.method} ${Number(p.amount)} ${p.status}`),
        }).toEqual({
          blocked: true,
          paymentId: true,
          voidOk: false,
          is400: true,
          msg: "Cannot void an invoice with $20.00 in ca",
          voidRetries: 1,
          status: "PARTIAL",
          payments: ["CASH 20 PAID"],
        });
      } finally {
        warn.mockRestore();
      }
    });
    // ─── SA-404d (#2255, bceaf3d2): order cancel under the Order → Invoice locks (R1) and a
    // DRAFT standalone payment vs a waiting void (R2) — F2 prover cases, two real connections ───
    const { OrdersService } = require("../orders/orders.service");
    const { Logger: NestLogger } = require("@nestjs/common");
    /** A real OrdersService over the real prisma + invoicesService; any other dependency is a no-op stub. */
    function ordersSvc(): any {
      const noop: any = new Proxy(async () => undefined, {
        get: () => noop,
        apply: async () => undefined,
      });
      const base = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        tenantCtx,
        invoicesService,
        creditNotes: {
          releaseOrderCreditsInTx: async () => undefined,
          previewOrderCreditRelease: async () => [],
          settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
        },
        logger: new NestLogger("OrdersService"),
      });
      return new Proxy(base, { get: (t, k, r) => (k in t ? Reflect.get(t, k, r) : noop) });
    }
    const opUser = (tenantId: string) =>
      ({ sub: "f2-op", role: "OPERATOR", tenantId, username: "f2-op" }) as any;
    /** A CONFIRMED order (no lines) with its SENT invoice linked by orderId. */
    async function seedOrder(label: string) {
      const s = await seed(label, "SENT");
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
      const order = await prisma.order.create({
        data: {
          tenantId: s.tenantId,
          customerId: inv.customerId,
          orderNumber: `ORD-F2-2258-${RUN_SUFFIX}-${label}`,
          status: "CONFIRMED",
          subtotal: 50,
          total: 50,
        } as any,
      });
      await prisma.invoice.update({
        where: { id: s.invoiceId },
        data: { orderId: order.id } as any,
      });
      return { ...s, orderId: order.id, customerId: inv.customerId };
    }
    /** T2raw holds the ORDER row; T1 starts and must block on it; `during` runs while T1 waits; T2raw commits. */
    async function holdOrder(
      orderId: string,
      t1: () => Promise<unknown>,
      during: () => Promise<unknown>,
    ) {
      const t2 = new Client({ connectionString: url() });
      await t2.connect();
      try {
        await t2.query("BEGIN");
        await t2.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [orderId]);
        const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const p1 = t1().then(
          (v) => ({ ok: true as const, v }),
          (e) => ({ ok: false as const, e }),
        );
        let blocked = false;
        for (let i = 0; i < 800 && !blocked; i++) {
          const q = await t2.query(
            `SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
            [pid],
          );
          blocked = q.rows[0].n > 0;
          if (!blocked) await new Promise((x) => setTimeout(x, 25));
        }
        const duringResult = await during();
        await t2.query("COMMIT");
        return { r: (await p1) as any, blocked, duringResult };
      } finally {
        await t2.end();
      }
    }
    const warnsFor = (spy: jest.SpyInstance, label: string) =>
      spy.mock.calls.filter((c) => String(c[0]).includes(label)).length;

    // B562 PR-2 × #2258: the cancel's stock credit (settleStockForEdit → its SALE "CANCEL" row) runs
    // INSIDE the retried cancel tx. A real 40001 raised AFTER the settle (on the invoice void) must
    // roll the credit back with everything else, and the retry must book it exactly once.
    it("(R1-40001-stock) cancel: a forced 40001 after the stock settle ⇒ ONE retry, ONE CANCEL movement, counter credited once", async () => {
      const warn = jest.spyOn(NestLogger.prototype, "warn");
      const s = await seedOrder("r1s");
      const operator = await prisma.user.create({
        data: {
          email: `${s.orderId}-op@example.invalid`,
          username: `${s.orderId}-op`,
          role: "OPERATOR",
          tenantId: s.tenantId,
        },
      });
      const product = await prisma.product.create({
        data: {
          name: `B562 ${s.orderId}`,
          unit: "ea",
          pricePerUnit: 10,
          currentStock: 95,
          tenantId: s.tenantId,
        } as any,
      });
      await prisma.orderItem.create({
        data: {
          orderId: s.orderId,
          productId: product.id,
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
          status: "CONFIRMED",
          tenantId: s.tenantId,
        } as any,
      });
      const tag = s.orderId.replace(/-/g, "").slice(0, 12);
      await prisma.$executeRawUnsafe(`CREATE SEQUENCE b562s_once_${tag}`);
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION b562s_raise_${tag}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${s.invoiceId}' AND nextval('b562s_once_${tag}') = 1 THEN RAISE EXCEPTION 'b562 forced conflict' USING ERRCODE = '40001'; END IF; RETURN NEW; END $$`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER b562s_trg_${tag} BEFORE UPDATE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION b562s_raise_${tag}()`,
      );
      let fired = 0;
      try {
        await tenantCtx.run(s.tenantId, () =>
          ordersSvc().changeStatus(
            s.orderId,
            { status: "CANCELLED" },
            {
              ...opUser(s.tenantId),
              sub: operator.id,
            },
          ),
        );
      } finally {
        fired = Number(
          (await prisma.$queryRawUnsafe<any[]>(`SELECT last_value FROM b562s_once_${tag}`))[0]
            .last_value,
        );
        await prisma.$executeRawUnsafe(`DROP TRIGGER b562s_trg_${tag} ON "Invoice"`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION b562s_raise_${tag}()`);
        await prisma.$executeRawUnsafe(`DROP SEQUENCE b562s_once_${tag}`);
      }
      const retries = warnsFor(warn, `order cancel void order=${s.orderId}`);
      warn.mockRestore();
      const rows = await prisma.stockMovement.findMany({
        where: { productId: product.id, reference: `ORDER:${s.orderId}` },
      });
      expect({
        fired: fired >= 2,
        retries,
        order: (await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } })).status,
        invoice: (await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } })).status,
        counter: Number(
          (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).currentStock,
        ),
        rows: rows.map((r) => [
          r.type,
          r.notes,
          Number(r.quantity),
          Number(r.stockAfter),
          r.performedById,
        ]),
      }).toEqual({
        fired: true,
        retries: 1,
        order: "CANCELLED",
        invoice: "VOID",
        counter: 100,
        rows: [["SALE", "CANCEL", 5, 100, operator.id]],
      });
    });

    it("(R1) cancel: a REAL CASH payment (recordPayment) committed between assertCancellableOrThrow and the cancel tx's locks ⇒ 400, order NOT cancelled, invoice NOT voided", async () => {
      const warn = jest.spyOn(NestLogger.prototype, "warn");
      try {
        const s = await seedOrder("r1");
        const orders = ordersSvc();
        const { r, blocked, duringResult } = await holdOrder(
          s.orderId,
          () =>
            tenantCtx.run(s.tenantId, () =>
              orders.changeStatus(s.orderId, { status: "CANCELLED" }, opUser(s.tenantId)),
            ),
          () =>
            tenantCtx.run(s.tenantId, () =>
              invoicesService.recordPayment(s.invoiceId, { amount: 20, method: "CASH" } as any),
            ),
        );
        const order = await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } });
        const inv = await prisma.invoice.findUniqueOrThrow({
          where: { id: s.invoiceId },
          include: { payments: true },
        });
        expect({
          blocked,
          paid: !!(duringResult as any)?.createdPaymentId,
          is400: status400(r),
          msg: msg(r)?.startsWith(
            "This order has payments that must be refunded before it can be cancelled",
          ),
          cancelRetries: warnsFor(warn, `order cancel void order=${s.orderId}`),
          orderStatus: order.status,
          invoiceStatus: inv.status,
          payments: inv.payments.map((p: any) => `${p.method} ${Number(p.amount)} ${p.status}`),
        }).toEqual({
          blocked: true,
          paid: true,
          is400: true,
          msg: true,
          cancelRetries: 1,
          orderStatus: "CONFIRMED",
          invoiceStatus: "PARTIAL",
          payments: ["CASH 20 PAID"],
        });
      } finally {
        warn.mockRestore();
      }
    });

    it("(R1-40001) cancel: a forced 40001 on attempt 1 (Order UPDATE trigger) ⇒ ONE retry, CANCELLED once, invoice VOID once", async () => {
      const warn = jest.spyOn(NestLogger.prototype, "warn");
      const s = await seedOrder("r1f");
      const tag = s.orderId.replace(/-/g, "").slice(0, 12);
      await prisma.$executeRawUnsafe(`CREATE SEQUENCE f2o_once_${tag}`);
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION f2o_raise_${tag}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${s.orderId}' AND nextval('f2o_once_${tag}') = 1 THEN RAISE EXCEPTION 'f2 forced conflict' USING ERRCODE = '40001'; END IF; RETURN NEW; END $$`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER f2o_trg_${tag} BEFORE UPDATE ON "Order" FOR EACH ROW EXECUTE FUNCTION f2o_raise_${tag}()`,
      );
      let fired = 0;
      try {
        await tenantCtx.run(s.tenantId, () =>
          ordersSvc().changeStatus(s.orderId, { status: "CANCELLED" }, opUser(s.tenantId)),
        );
      } finally {
        fired = Number(
          (await prisma.$queryRawUnsafe<any[]>(`SELECT last_value FROM f2o_once_${tag}`))[0]
            .last_value,
        );
        await prisma.$executeRawUnsafe(`DROP TRIGGER f2o_trg_${tag} ON "Order"`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION f2o_raise_${tag}()`);
        await prisma.$executeRawUnsafe(`DROP SEQUENCE f2o_once_${tag}`);
      }
      const retries = warnsFor(warn, `order cancel void order=${s.orderId}`);
      warn.mockRestore();
      expect({
        fired: fired >= 2,
        retries,
        order: (await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } })).status,
        invoice: (await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } })).status,
      }).toEqual({ fired: true, retries: 1, order: "CANCELLED", invoice: "VOID" });
    });

    it("(R1-control) plain cancel ⇒ CANCELLED + invoice VOID; with a CASH payment already on it ⇒ the pre-check 400, nothing changed", async () => {
      const a = await seedOrder("r1c");
      await tenantCtx.run(a.tenantId, () =>
        ordersSvc().changeStatus(a.orderId, { status: "CANCELLED" }, opUser(a.tenantId)),
      );
      expect((await prisma.order.findUniqueOrThrow({ where: { id: a.orderId } })).status).toBe(
        "CANCELLED",
      );
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: a.invoiceId } })).status).toBe(
        "VOID",
      );
      const b = await seedOrder("r1p");
      await tenantCtx.run(b.tenantId, () =>
        invoicesService.recordPayment(b.invoiceId, { amount: 20, method: "CASH" } as any),
      );
      const r: any = await tenantCtx
        .run(b.tenantId, () =>
          ordersSvc().changeStatus(b.orderId, { status: "CANCELLED" }, opUser(b.tenantId)),
        )
        .then(
          (v: any) => ({ ok: true, v }),
          (e: any) => ({ ok: false, e }),
        );
      expect(status400(r)).toBe(true);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: b.orderId } })).status).toBe(
        "CONFIRMED",
      );
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: b.invoiceId } })).status).toBe(
        "PARTIAL",
      );
    });

    // SA-404e: DRAFT, not PENDING — StandalonePaymentDto accepts only DRAFT | PAID, so PENDING cannot come through this path.
    // SA-404f (#2466) reworked R2: every payment writer now takes (Order →) Invoice FIRST, the same
    // order void takes — so a payment can no longer COMMIT while a void waits (the old R2 premise;
    // its harness held the Order lock while awaiting the payment and deadlocked). The invariant R2
    // guards is unchanged: a void and a concurrent payment on one invoice SERIALIZE — never a VOID
    // invoice holding a payment. ENTRY: T2 holds the ORDER row; the DRAFT payment starts and blocks
    // FIRST, then the void (its unlocked pre-read sees no payment) queues behind it — both waiters
    // asserted; T2 commits. SA-470c: queued payment-first so R2's original intent (the payment lands,
    // the void re-reads under the lock and refuses) is the branch exercised, while the assertion
    // stays winner-agnostic; the branch that occurred is logged for F2's report.
    it("(R2) void vs a DRAFT standalone payment, both queued on the Order lock ⇒ they serialize: never a VOID invoice holding a payment", async () => {
      const s = await seedOrder("r2");
      const t2 = new Client({ connectionString: url() });
      await t2.connect();
      let voidR: any;
      let payR: any;
      let waiters = 0;
      try {
        await t2.query("BEGIN");
        await t2.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [s.orderId]);
        const settle = (p: Promise<unknown>) =>
          p.then(
            (v) => ({ ok: true as const, v }),
            (e) => ({ ok: false as const, e }),
          );
        // #2472 (5) / SA-470d: count only backends waiting behind T2 — blocked by T2 itself, or by a
        // backend T2 blocks (the second waiter queues behind the first) — not every blocked backend.
        const t2pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const blockedCount = async () =>
          (
            await t2.query(
              `SELECT count(*)::int n FROM pg_stat_activity a
                WHERE a.datname = current_database()
                  AND EXISTS (SELECT 1 FROM unnest(pg_blocking_pids(a.pid)) b
                               WHERE b = $1 OR $1 = ANY(pg_blocking_pids(b)))`,
              [t2pid],
            )
          ).rows[0].n as number;
        // Bounded, and it THROWS: a barrier that never forms fails on this message (e.g. on a revert),
        // not on the 30 s test timeout.
        const waitFor = async (n: number) => {
          for (let i = 0; i < 400; i++) {
            // SA-492: T2 polls inside its own open tx, where pg_stat_activity is a cached snapshot —
            // clear it each poll or a stale "not blocked" is read (F2's #2506 diagnosis, as #2519 does).
            await t2.query("SELECT pg_stat_clear_snapshot()");
            waiters = await blockedCount();
            if (waiters >= n) return;
            await new Promise((x) => setTimeout(x, 25));
          }
          throw new Error(
            `R2 barrier: ${waiters} of ${n} expected waiters blocked behind T2 after 10 s`,
          );
        };
        const pPay = settle(
          tenantCtx.run(s.tenantId, () =>
            invoicesService.recordStandalonePayment({
              customerId: s.customerId,
              totalAmount: 20,
              method: "CHECK",
              status: "DRAFT",
              allocations: [{ invoiceId: s.invoiceId, amount: 20 }],
            } as any),
          ),
        );
        await waitFor(1);
        const pVoid = settle(
          tenantCtx.run(s.tenantId, () => invoicesService.voidInvoice(s.invoiceId)),
        );
        await waitFor(2);
        await t2.query("COMMIT");
        [voidR, payR] = await Promise.all([pVoid, pPay]);
      } finally {
        await t2.end();
      }
      const inv = await prisma.invoice.findUniqueOrThrow({
        where: { id: s.invoiceId },
        include: { payments: true },
      });
      const observed = {
        waiters: waiters >= 2,
        voidOk: voidR.ok,
        payOk: payR.ok,
        refusedIs400: status400(voidR.ok ? payR : voidR),
        invoiceStatus: inv.status,
        payments: inv.payments.map((p: any) => `${p.method} ${Number(p.amount)} ${p.status}`),
      };
      const voidWon = {
        waiters: true,
        voidOk: true,
        payOk: false,
        refusedIs400: true,
        invoiceStatus: "VOID",
        payments: [],
      };
      const paymentWon = {
        waiters: true,
        voidOk: false,
        payOk: true,
        refusedIs400: true,
        invoiceStatus: "SENT",
        payments: ["CHECK 20 DRAFT"],
      };
      // SA-470c (ii): report which consistent branch Postgres produced.
      console.info(
        `R2 branch: ${observed.payOk && !observed.voidOk ? "payment-wins" : observed.voidOk && !observed.payOk ? "void-wins" : "neither"}`,
      );
      expect([voidWon, paymentWon]).toContainEqual(observed);
    });

    // ─── SA-404f / SA-404g (#2466, SA-470 condition 2): the VOID-FIRST half, two real connections ───
    // ENTRY (every F1/N1 case): T2 holds the Invoice row lock and flips it to VOID (uncommitted); the
    // payment writer (T1) has started and is BLOCKED on T2 (pg_blocking_pids — interleave's barrier,
    // asserted as `blocked`), and only then does T2 commit. Pre-fix, T1 read the status UNLOCKED
    // (still SENT) and wrote a payment over the VOID; fixed, T1's first statement is the
    // (Order →) Invoice lock, so it re-reads VOID under it. F2 runs this: RED on a revert of the fix
    // commit, GREEN at the head.
    const { BookkeepingService } = require("../bookkeeping/bookkeeping.service");
    /** A real BookkeepingService.recordPayment over the real prisma (its only other dependency is stubbed). */
    const bookkeeping = () =>
      Object.assign(Object.create(BookkeepingService.prototype), {
        prisma,
        commissionEngine: mockCommissionEngine,
      });
    const voidUnderLock = (invoiceId: string) => async (c: any) => {
      await c.query(`UPDATE "Invoice" SET status = 'VOID', "updatedAt" = now() WHERE id = $1`, [
        invoiceId,
      ]);
    };
    const invoiceState = async (invoiceId: string) => {
      const inv = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: { payments: true },
      });
      return {
        status: inv.status,
        payments: inv.payments.map((p: any) => `${p.method} ${Number(p.amount)} ${p.status}`),
      };
    };
    const standalone = (s: { tenantId: string; invoiceId: string }, customerId: string) =>
      tenantCtx.run(s.tenantId, () =>
        invoicesService.recordStandalonePayment({
          customerId,
          totalAmount: 20,
          method: "CASH",
          status: "PAID",
          allocations: [{ invoiceId: s.invoiceId, amount: 20 }],
        } as any),
      );
    const customerOf = async (invoiceId: string) =>
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).customerId;

    it("(SA-404f F1-standalone) VOID committed while recordStandalonePayment waits on the Invoice lock ⇒ 400, no payment, stays VOID", async () => {
      const s = await seed("f1sa", "SENT");
      const customerId = await customerOf(s.invoiceId);
      const r = await interleave(
        s.invoiceId,
        () => standalone(s, customerId),
        voidUnderLock(s.invoiceId),
      );
      expect({
        blocked: !r.notBlocked,
        is400: status400(r),
        ...(await invoiceState(s.invoiceId)),
      }).toEqual({
        blocked: true,
        is400: true,
        status: "VOID",
        payments: [],
      });
    });

    it("(SA-404f F1-standalone control) nothing interleaves ⇒ one CASH payment, invoice PARTIAL", async () => {
      const s = await seed("f1sac", "SENT");
      const customerId = await customerOf(s.invoiceId);
      await standalone(s, customerId);
      expect(await invoiceState(s.invoiceId)).toEqual({
        status: "PARTIAL",
        payments: ["CASH 20 PAID"],
      });
    });

    it("(SA-404f F1-bookkeeping) VOID committed while BookkeepingService.recordPayment waits on the Invoice lock ⇒ 400, no payment, stays VOID", async () => {
      const s = await seed("f1bk", "SENT");
      const r = await interleave(
        s.invoiceId,
        () =>
          tenantCtx.run(s.tenantId, () =>
            bookkeeping().recordPayment(s.invoiceId, { amount: 20, method: "CASH" }),
          ),
        voidUnderLock(s.invoiceId),
      );
      expect({
        blocked: !r.notBlocked,
        is400: status400(r),
        ...(await invoiceState(s.invoiceId)),
      }).toEqual({
        blocked: true,
        is400: true,
        status: "VOID",
        payments: [],
      });
    });

    it("(SA-404f F1-bookkeeping control) nothing interleaves ⇒ one CASH payment", async () => {
      const s = await seed("f1bkc", "SENT");
      await tenantCtx.run(s.tenantId, () =>
        bookkeeping().recordPayment(s.invoiceId, { amount: 20, method: "CASH" }),
      );
      expect((await invoiceState(s.invoiceId)).payments).toEqual(["CASH 20 PAID"]);
    });

    // SA-404g N1: the delivery writer re-derives PAYABLE under each invoice's lock and SKIPS one voided
    // meanwhile — the driver's cash moves to the next invoice (or the advance), and money is conserved.
    it("(SA-404g N1-delivery) the oldest invoice VOIDED while the delivery payment waits on its lock ⇒ skipped; the cash lands on the next invoice; conserved", async () => {
      const s = await seedOrder("n1dl");
      const second = await prisma.invoice.create({
        data: {
          tenantId: s.tenantId,
          customerId: s.customerId,
          orderId: s.orderId,
          invoiceNumber: `INV-F2-2466-${RUN_SUFFIX}-n1dl-2`,
          status: "SENT",
          subtotal: 50,
          total: 50,
          items: {
            create: [
              {
                tenantId: s.tenantId,
                description: "f2 line 2",
                qty: 1,
                unitPrice: 50,
                subtotal: 50,
              },
            ],
          },
        } as any,
      });
      const r = await interleave(
        s.invoiceId,
        () =>
          tenantCtx.run(s.tenantId, () =>
            prisma.tenantTransaction((tx: any) =>
              invoicesService.recordDeliveryPaymentInTx(
                tx,
                new AfterCommit(),
                [s.orderId],
                50,
                "CASH",
              ),
            ),
          ),
        voidUnderLock(s.invoiceId),
      );
      const out: any = r.ok ? r.v : null;
      expect({
        blocked: !r.notBlocked,
        ok: r.ok,
        conserved: out ? Number(out.applied) + Number(out.excess) : null,
        voided: await invoiceState(s.invoiceId),
        next: await invoiceState(second.id),
      }).toEqual({
        blocked: true,
        ok: true,
        conserved: 50,
        voided: { status: "VOID", payments: [] },
        next: { status: "PAID", payments: ["CASH 50 PAID"] },
      });
    });

    // SA-404f F2: the cancel's status write is a compare-and-set on the cancellable set. ENTRY: T2 holds
    // the ORDER row; changeStatus(CANCELLED) has passed its pre-check (CONFIRMED) and is BLOCKED in
    // lockOrderForCancel; T2 sets the order DELIVERED and commits. The cancel must refuse (409
    // ORDER_CHANGED_DURING_EDIT) — directly, or after one 40001 retry (the retried tx sees DELIVERED) —
    // and leave the order DELIVERED with its invoice NOT voided.
    it("(SA-404f F2 + 40001 retry) DELIVERED committed while the cancel waits on the Order lock ⇒ 409, stays DELIVERED, invoice not voided", async () => {
      const warn = jest.spyOn(NestLogger.prototype, "warn");
      try {
        const s = await seedOrder("f2dl");
        const t2 = new Client({ connectionString: url() });
        await t2.connect();
        let r: any;
        let blocked = false;
        try {
          await t2.query("BEGIN");
          await t2.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [s.orderId]);
          const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          const p1 = tenantCtx
            .run(s.tenantId, () =>
              ordersSvc().changeStatus(s.orderId, { status: "CANCELLED" }, opUser(s.tenantId)),
            )
            .then(
              (v: unknown) => ({ ok: true as const, v }),
              (e: any) => ({ ok: false as const, e }),
            );
          for (let i = 0; i < 800 && !blocked; i++) {
            const q = await t2.query(
              `SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
              [pid],
            );
            blocked = q.rows[0].n > 0;
            if (!blocked) await new Promise((x) => setTimeout(x, 25));
          }
          await t2.query(
            `UPDATE "Order" SET status = 'DELIVERED', "updatedAt" = now() WHERE id = $1`,
            [s.orderId],
          );
          await t2.query("COMMIT");
          r = await p1;
        } finally {
          await t2.end();
        }
        const order = await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } });
        const retries = warnsFor(warn, `order cancel void order=${s.orderId}`);
        expect({
          blocked,
          ok: r.ok,
          status: r.e?.getStatus?.(),
          code: r.e?.getResponse?.()?.code,
          orderStatus: order.status,
          invoice: (await invoiceState(s.invoiceId)).status,
        }).toEqual({
          blocked: true,
          ok: false,
          status: 409,
          code: "ORDER_CHANGED_DURING_EDIT",
          orderStatus: "DELIVERED",
          invoice: "SENT",
        });
        // Observe, don't predict: the refusal comes on the first attempt or after exactly one 40001
        // retry (Serializable snapshot vs T2's commit). Never more, and never a delivered order cancelled.
        expect(retries).toBeLessThanOrEqual(1);
      } finally {
        warn.mockRestore();
      }
    });
  },
);
