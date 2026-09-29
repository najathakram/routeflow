/**
 * DB-lane repro for B861 (the numbering settings card never reaches the live invoice/estimate/
 * credit-note number). Design of record: SA-274,
 * `.claude/pipeline/2026-09-25-B861-numbering-continuity/cause-ruling.md` §2 (verdict) and §3 (fix
 * design). Read set: `bug-test-plan.md`'s "Red set — DB lane" table (REG-B861-N…Y) and Pins P-1/P-6
 * in the same directory.
 *
 * WHY THE DB LANE (same rationale as `invoices/invoice-numbering.db.spec.ts`, L-061): the collision
 * guard's regex-escaping bug (V), the -R-aware / literal-prefix / empty-prefix scans (P/Q/S), the
 * max-first jump over an imported block (O), and the concurrent-mint race (Y) are only provable
 * against a REAL Postgres — a mocked Prisma client can't reproduce a genuine `regexp_match` throwing
 * an invalid-regular-expression error, or ten transactions actually racing on one connection pool.
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`
 * (`node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api"`), which points
 * DATABASE_URL at the compose Postgres and sets RUN_DB_SPECS. `requireLocalDatabaseUrl()` refuses
 * any non-local host.
 *
 * Run alone: `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api --
 * src/import/numbering-continuity.db.spec.ts"`.
 *
 * THE CODE UNDER TEST DOES NOT HAVE THE FIX YET. `NumberingService.reserveNext` still routes every
 * year-scoped mint straight to `mintForYear`, ignoring any saved `year: 0` card row; `updateSettings`
 * does not know `expectedNextNumber` (the Q3 compare-and-set field) or refuse a same-or-below save
 * (Q2). Every REG test below is written to fail on its own ASSERTED VALUE at this sha, never on a
 * compile or import error — a field the fix design adds but the DTO does not have yet is passed
 * through an `as any` cast with a one-line comment, exactly as the B100 unit spec did for its own
 * pre-fix fields.
 *
 * SAFETY: every tenant this file creates is a throwaway `qa-b861-<run>-<n>-<label>` slug, approved by
 * `assertTestTenant` (`scripts/lib/test-tenants.cjs`); `afterAll` deletes exactly the tenants THIS run
 * created, in FK order, never anyone else's rows. Pin P-6 shells out to
 * `apps/api/scripts/report-b861-numbering-config.mjs` against the SAME local DATABASE_URL this file
 * already validated (never `railway run`); it deletes the Railway proxy env vars first so the
 * script's proxy-wins-over-DATABASE_URL resolution can't be redirected at a live tenant by an
 * ambient `RAILWAY_TCP_PROXY_*` in the shell.
 */

// Prevent Jest from traversing ESM-only dependencies (same guard as invoices.service.spec.ts /
// invoice-numbering.db.spec.ts — InvoicesService.create() is exercised for real in REG-B861-N).
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { BadRequestException, ConflictException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { DocumentNumberType } from "@prisma/client";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { NumberingService } from "./numbering.service";
import { UpdateNumberingDto } from "./dto/update-numbering.dto";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
/** A fresh, policy-approved throwaway tenant slug — never reused across tests in this file. */
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b861-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "numbering-continuity.db.spec.ts",
  );
}

// Year the real generator derives from `new Date().getFullYear()` (LOCAL time, matching
// invoice-numbering.db.spec.ts's YEAR exactly — a UTC-based YEAR here could disagree with the
// host clock the code under test actually reads).
const YEAR = new Date().getFullYear();

describeDb(
  "B861 numbering card → live series — real Postgres (SA-274 continuity + collision guard)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoicesService: InvoicesService;
    let numberingService: NumberingService;
    let localDatabaseUrl: string;
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
    // flag.msrp OFF: applyMsrpSnapshots no-ops — irrelevant to numbering.
    const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
    const mockCommissionEngine = {
      syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
      syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
      removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
    };
    const mockSellingRestrictions = {
      assertLinesSellable: jest.fn().mockResolvedValue(undefined),
    };

    beforeAll(async () => {
      // Nothing env-dependent may run at collection time (db-lane.db.spec.ts's rule): the real
      // connection is built here, inside a hook, never at module top level.
      localDatabaseUrl = requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          InvoicesService,
          { provide: SellingRestrictionsService, useValue: mockSellingRestrictions },
          // REAL NumberingService over the REAL PrismaService above — the whole point of this
          // lane is the genuine NumberingSequence store and Postgres regex behaviour.
          NumberingService,
          { provide: PrismaService, useValue: prisma },
          { provide: RouteFlowGateway, useValue: mockGateway },
          { provide: EmailService, useValue: mockEmailService },
          { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
          { provide: SystemConfigService, useValue: mockSystemConfig },
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
          { provide: CreditNotesService, useValue: mockCreditNotes },
          { provide: MessagingService, useValue: mockMessaging },
          { provide: StorageService, useValue: mockStorage },
          {
            provide: EntitlementAuthority,
            inject: [EntitlementsService],
            useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
              can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
            }),
          },
          { provide: EntitlementsService, useValue: mockEntitlements },
          { provide: CommissionEngineService, useValue: mockCommissionEngine },
        ],
      }).compile();

      invoicesService = module.get(InvoicesService);
      numberingService = module.get(NumberingService);
    });

    afterAll(async () => {
      for (const tenantId of createdTenantIds) {
        // eslint-disable-next-line no-await-in-loop
        await cleanupTenant(tenantId).catch(() => {
          // Best-effort: a failed cleanup must never mask the test's own pass/fail result.
        });
      }
      await prisma?.$disconnect();
    });

    async function cleanupTenant(tenantId: string): Promise<void> {
      // FK order: CreditNote/Estimate before Invoice (nullable FKs onto it), NumberingSequence
      // deleteMany-by-tenantId covers every year (0 and per-year) this run wrote in one call.
      await prisma.creditNote.deleteMany({ where: { tenantId } });
      await prisma.estimate.deleteMany({ where: { tenantId } });
      await prisma.invoice.deleteMany({ where: { tenantId } });
      await prisma.orderItem.deleteMany({ where: { tenantId } });
      await prisma.order.deleteMany({ where: { tenantId } });
      await prisma.numberingSequence.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }

    async function seedTenant(label: string): Promise<{ id: string; slug: string }> {
      const slug = freshTenantSlug(label);
      const tenant = await prisma.tenant.create({ data: { slug, name: `B861 ${slug}` } });
      createdTenantIds.push(tenant.id);
      return { id: tenant.id, slug };
    }

    async function seedCustomer(tenantId: string, label: string): Promise<{ id: string }> {
      const idBase = `${tenantId}-${label}`;
      const user = await prisma.user.create({
        data: {
          email: `${idBase}@example.invalid`,
          username: idBase,
          role: "CUSTOMER",
          tenantId,
        },
      });
      const customer = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: `B861 customer ${label}`,
          contactName: `B861 contact ${label}`,
          tenantId,
        },
      });
      return { id: customer.id };
    }

    async function seedInvoice(tenantId: string, customerId: string, invoiceNumber: string) {
      return prisma.invoice.create({
        data: { tenantId, customerId, invoiceNumber, status: "DRAFT", subtotal: 10, total: 10 },
      });
    }

    /** Seed a NumberingSequence row directly (bypassing updateSettings), for V's per-year setup. */
    async function seedNumberingSequenceRow(
      tenantId: string,
      docType: DocumentNumberType,
      year: number,
      fields: { prefix: string; nextNumber: number; padding: number },
    ) {
      return prisma.numberingSequence.create({
        data: {
          tenantId,
          docType,
          year,
          prefix: fields.prefix,
          nextNumber: fields.nextNumber,
          padding: fields.padding,
        },
      });
    }

    async function numberingSequenceRow(
      tenantId: string,
      docType: DocumentNumberType,
      year: number,
    ) {
      return prisma.numberingSequence.findUnique({
        where: { tenantId_docType_year: { tenantId, docType, year } },
      });
    }

    /** Drives the real, public mint path: InvoicesService.create() under a tenant context (N only). */
    async function mintInvoice(tenantId: string, customerId: string): Promise<any> {
      return tenantCtx.run(tenantId, () =>
        invoicesService.create({
          customerId,
          items: [{ description: "widget", qty: 1, unitPrice: 10 }],
        } as any),
      );
    }

    /**
     * Saves the card row for INVOICE, under tenant context, through the real service method.
     * Typed to the real `UpdateNumberingDto` so ordinary calls keep normal type-checking; a
     * not-yet-existing field (e.g. Q3's `expectedNextNumber`) is cast `as any` at the CALL SITE,
     * not here, so this helper itself never silently swallows a real type error.
     */
    async function saveInvoiceNumbering(tenantId: string, dto: UpdateNumberingDto) {
      // SA-287b: every save carries the version token the card loaded. A test that does not
      // pass one explicitly gets the CURRENT stored next (1 for an unsaved row), exactly what
      // a freshly loaded card would send; U/U2 pass a stale one on purpose.
      const token =
        (dto as any).expectedNextNumber ??
        (await numberingSequenceRow(tenantId, "INVOICE", 0))?.nextNumber ??
        1;
      return tenantCtx.run(tenantId, () =>
        numberingService.updateSettings("INVOICE", { ...dto, expectedNextNumber: token } as any),
      );
    }

    /** Mints via the real reserveNext contract every live INVOICE caller uses: year + tenantId. */
    async function reserveInvoiceNext(tenantId: string): Promise<string> {
      return tenantCtx.run(tenantId, () =>
        numberingService.reserveNext("INVOICE", { year: YEAR, tenantId }),
      );
    }

    async function getInvoiceSettingsRow(tenantId: string) {
      const settings = await tenantCtx.run(tenantId, () => numberingService.getSettings());
      return settings.find((r) => r.docType === "INVOICE");
    }

    it("REG-B861-N configure next 10543 → the first live invoice is INV-10543", async () => {
      const tenant = await seedTenant("n");
      const cust = await seedCustomer(tenant.id, "n");
      await saveInvoiceNumbering(tenant.id, { prefix: "INV-", nextNumber: 10543, padding: 5 });

      const first = await mintInvoice(tenant.id, cust.id);
      const second = await mintInvoice(tenant.id, cust.id);

      // ONE value oracle covering the continuity claim end to end: today InvoicesService.create()
      // routes through mintForYear regardless of the saved card row, so both mints land on the
      // per-year series (`INV-<Y>-0001`, `INV-<Y>-0002`) instead of continuing the saved series.
      expect([first.invoiceNumber, second.invoiceNumber]).toEqual(["INV-10543", "INV-10544"]);
    }, 30_000);

    it("REG-B861-O imported padded block after the save → INV-8851", async () => {
      const tenant = await seedTenant("o");
      const cust = await seedCustomer(tenant.id, "o");
      await saveInvoiceNumbering(tenant.id, { prefix: "INV-", nextNumber: 8842, padding: 4 });
      // An import landing AFTER the save: a padded block the max-first scan must see.
      for (let n = 8842; n <= 8850; n++) {
        // eslint-disable-next-line no-await-in-loop
        await seedInvoice(tenant.id, cust.id, `INV-0${n}`);
      }

      const minted = await reserveInvoiceNext(tenant.id);

      expect(minted).toBe("INV-8851");
    }, 30_000);

    it("REG-B861-P a -R sibling takes its base number", async () => {
      const tenant = await seedTenant("p");
      const cust = await seedCustomer(tenant.id, "p");
      await saveInvoiceNumbering(tenant.id, { prefix: "INV-", nextNumber: 500, padding: 4 });
      await seedInvoice(tenant.id, cust.id, "INV-0500-R1");

      const minted = await reserveInvoiceNext(tenant.id);

      expect(minted).toBe("INV-0501");
    }, 30_000);

    it('REG-B861-Q prefix "INV." is literal', async () => {
      const tenant = await seedTenant("q");
      const cust = await seedCustomer(tenant.id, "q");
      await saveInvoiceNumbering(tenant.id, { prefix: "INV.", nextNumber: 1, padding: 4 });
      // Decoy: if "." were left unescaped (regex "any character") this would match the max scan
      // as "INV" + "X" + "0007" and jump the mint past 1. A literal "." must ignore it entirely.
      await seedInvoice(tenant.id, cust.id, "INVX0007");

      const minted = await reserveInvoiceNext(tenant.id);

      expect(minted).toBe("INV.0001");
    }, 30_000);

    it('REG-B861-R prefix "INV(" mints without a regex error', async () => {
      const tenant = await seedTenant("r");
      await saveInvoiceNumbering(tenant.id, { prefix: "INV(", nextNumber: 1, padding: 4 });

      const minted = await reserveInvoiceNext(tenant.id);

      expect(minted).toBe("INV(0001");
    }, 30_000);

    it("REG-B861-S empty prefix mints bare numerics only above bare numerics", async () => {
      const tenant = await seedTenant("s");
      const cust = await seedCustomer(tenant.id, "s");
      await saveInvoiceNumbering(tenant.id, { prefix: "", nextNumber: 10543, padding: 0 });
      // "10540" is a bare numeric the empty-prefix scan must see; the per-year decoy
      // "INV-<Y>-0005" carries the DEFAULT prefix and a year segment — the bare-numeric pattern
      // must never match it (it would wrongly jump the mint to 6, the per-year answer).
      await seedInvoice(tenant.id, cust.id, "10540");
      await seedInvoice(tenant.id, cust.id, `INV-${YEAR}-0005`);

      const minted = await reserveInvoiceNext(tenant.id);

      expect(minted).toBe("10543");
    }, 30_000);

    it("REG-B861-T a save at or below an existing number is a 400 naming it", async () => {
      const tenant = await seedTenant("t");
      const cust = await seedCustomer(tenant.id, "t");
      // No card row saved yet: the effective prefix for the guard is the INVOICE default "INV-".
      await seedInvoice(tenant.id, cust.id, "INV-10550");

      await expect(saveInvoiceNumbering(tenant.id, { nextNumber: 10549 })).rejects.toThrow(
        /INV-10550/,
      );
    }, 30_000);

    // Pre-merge review of #2170: the year-0 max scan captured `(\d{1,9})` with no leading `0*`,
    // so a zero-padded number longer than 9 characters (padding goes to 12; empty prefix is
    // allowed for bare migrated numbers) was invisible to both the save guard and max-first.
    it("REG-B861-Z a zero-padded 10-character bare number is seen by the save guard", async () => {
      const tenant = await seedTenant("z");
      const cust = await seedCustomer(tenant.id, "z");
      await seedInvoice(tenant.id, cust.id, "0090000123");

      await expect(
        saveInvoiceNumbering(tenant.id, { prefix: "", nextNumber: 1000, padding: 10 }),
      ).rejects.toThrow(/0090000123/);
    }, 30_000);

    it("REG-B861-Z2 a pad-10 imported block after the save is jumped, not wedged", async () => {
      const tenant = await seedTenant("z2");
      const cust = await seedCustomer(tenant.id, "z2");
      await saveInvoiceNumbering(tenant.id, { prefix: "", nextNumber: 1, padding: 10 });
      // Six consecutive padded numbers land after the save (an import): more than the mint's
      // attempt cap, so only a max scan that SEES them can jump past.
      for (let i = 1; i <= 6; i++) {
        await seedInvoice(tenant.id, cust.id, String(i).padStart(10, "0"));
      }

      await expect(reserveInvoiceNext(tenant.id)).resolves.toBe("0000000007");
    }, 30_000);

    it("REG-B861-AB a save without expectedNextNumber is refused (400, reload the settings)", async () => {
      const tenant = await seedTenant("ab");
      await saveInvoiceNumbering(tenant.id, { prefix: "INV-", nextNumber: 10543, padding: 5 });

      // Straight to the service (the helper would add the token): a token-less client.
      await expect(
        tenantCtx.run(tenant.id, () =>
          numberingService.updateSettings("INVOICE", { prefix: "ACME-" }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }, 30_000);

    // SA-287b fold 1, the race itself on two connections: a prefix save holds the saved row
    // (UPDATE, uncommitted) while a mint starts. The mint must not issue a number at or below
    // an existing document under the NEW prefix. Before the fix the mint scans the old prefix
    // (INV-, max 0), its UPDATE then waits on the save and returns the new prefix, and it
    // issues ACME-0006 although ACME-0900 exists.
    it("REG-B861-AC a prefix save racing a mint never yields a number at or below an existing one", async () => {
      const tenant = await seedTenant("ac");
      const cust = await seedCustomer(tenant.id, "ac");
      await saveInvoiceNumbering(tenant.id, { prefix: "INV-", nextNumber: 6, padding: 4 });
      await seedInvoice(tenant.id, cust.id, "ACME-0900");

      // SA-306: a deterministic barrier, not a sleep. The save's connection records its backend
      // pid and holds the row; the mint is released only after Postgres itself reports a backend
      // blocked BY that pid (pg_blocking_pids). If the mint never blocks, the test fails loudly
      // instead of letting the save commit first (which would make the pre-fix code pass too).
      let releaseSave!: () => void;
      const saveMayCommit = new Promise<void>((r) => (releaseSave = r));
      let saveHoldsRow!: (pid: number) => void;
      const rowHeld = new Promise<number>((r) => (saveHoldsRow = r));
      const save = prisma.$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          await tx.$executeRaw`
            UPDATE "NumberingSequence" SET "prefix" = 'ACME-'
            WHERE "tenantId" = ${tenant.id} AND "docType" = 'INVOICE'::"DocumentNumberType" AND "year" = 0
          `;
          saveHoldsRow(pid);
          await saveMayCommit;
        },
        { timeout: 20_000 },
      );
      let mint: Promise<string> | undefined;
      try {
        const savePid = await rowHeld;
        mint = reserveInvoiceNext(tenant.id);
        mint.catch(() => undefined); // surfaced below; never an unhandled rejection meanwhile
        let blocked = false;
        for (let i = 0; i < 100 && !blocked; i++) {
          const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE ${savePid}::int = ANY(pg_blocking_pids(pid))
          `;
          blocked = n > 0;
          if (!blocked) await new Promise((r) => setTimeout(r, 100));
        }
        if (!blocked) {
          throw new Error(
            "the mint never blocked on the save's row lock — the race was not reproduced",
          );
        }
      } finally {
        releaseSave();
        await save;
      }

      const issued = await mint!;
      expect(issued).toBe("ACME-0901");
    }, 30_000);

    // Pin (no REG token — green before and after SA-287b): two cards holding the same token
    // save different next numbers at once; the compare-and-set lets exactly one through.
    it("two concurrent saves with the same token: exactly one succeeds, the other is a 409", async () => {
      const tenant = await seedTenant("cas2");
      await saveInvoiceNumbering(tenant.id, { prefix: "INV-", nextNumber: 10543, padding: 5 });

      const results = await Promise.allSettled([
        saveInvoiceNumbering(tenant.id, { nextNumber: 20000, expectedNextNumber: 10543 } as any),
        saveInvoiceNumbering(tenant.id, { nextNumber: 30000, expectedNextNumber: 10543 } as any),
      ]);

      const outcome = results
        .map((r) =>
          r.status === "fulfilled"
            ? "ok"
            : r.reason instanceof ConflictException
              ? "409"
              : `other:${r.reason}`,
        )
        .sort();
      expect(outcome).toEqual(["409", "ok"]);
    }, 30_000);

    // Pin (no REG token): two first saves race to create the row; P2002 maps to 409.
    it("two concurrent first saves: one creates the row, the other is a 409", async () => {
      const tenant = await seedTenant("first2");

      const results = await Promise.allSettled([
        saveInvoiceNumbering(tenant.id, {
          prefix: "INV-",
          nextNumber: 500,
          padding: 4,
          expectedNextNumber: 1,
        } as any),
        saveInvoiceNumbering(tenant.id, {
          prefix: "ACME-",
          nextNumber: 700,
          padding: 4,
          expectedNextNumber: 1,
        } as any),
      ]);

      const outcome = results
        .map((r) =>
          r.status === "fulfilled"
            ? "ok"
            : r.reason instanceof ConflictException
              ? "409"
              : `other:${r.reason}`,
        )
        .sort();
      expect(outcome).toEqual(["409", "ok"]);
    }, 30_000);

    it("REG-B861-U a stale save is a 409 and changes nothing", async () => {
      const tenant = await seedTenant("u");
      await saveInvoiceNumbering(tenant.id, { prefix: "INV-", nextNumber: 10543, padding: 5 });
      // Scene-setting mint, matching the real flow SA-274 describes (a live mint between the load
      // and the stale save) — not itself asserted on here.
      await reserveInvoiceNext(tenant.id);

      // `expectedNextNumber` (Q3's compare-and-set token) does not exist on UpdateNumberingDto yet
      // — passed via `as any` so this compiles at this sha and fails on the ASSERTION below.
      await expect(
        saveInvoiceNumbering(tenant.id, {
          prefix: "ACME-",
          expectedNextNumber: 10543,
        } as any),
      ).rejects.toThrow(ConflictException);
    }, 30_000);

    // Second red-set `it` for Q3: the stale save must change NOTHING (today it rewrites the prefix),
    // proved separately so each `it` keeps exactly one behavioural expect.
    it("REG-B861-U2 a stale save leaves the stored prefix untouched", async () => {
      const tenant = await seedTenant("u-precond");
      await saveInvoiceNumbering(tenant.id, { prefix: "INV-", nextNumber: 10543, padding: 5 });
      await reserveInvoiceNext(tenant.id);

      await saveInvoiceNumbering(tenant.id, {
        prefix: "ACME-",
        expectedNextNumber: 10543,
      } as any).catch(() => {
        // The rejection itself is REG-B861-U's concern; this test only checks the stored row.
      });

      const row = await numberingSequenceRow(tenant.id, "INVOICE", 0);
      expect(row?.prefix).toBe("INV-");
    }, 30_000);

    // Pin (no REG token — green today and after): the success half of Q3's compare-and-set. A card
    // holding the CURRENT token must still be able to edit a saved row. Only a real Prisma client can
    // prove it: a WhereInput carrying the compound-unique key is accepted by mocks and rejected here
    // ("Unknown argument"), which would 500 every second save of a configured row.
    it("a save carrying the current expectedNextNumber updates the saved row", async () => {
      const tenant = await seedTenant("u-ok");
      await saveInvoiceNumbering(tenant.id, { prefix: "INV-", nextNumber: 10543, padding: 5 });

      await saveInvoiceNumbering(tenant.id, {
        prefix: "ACME-",
        expectedNextNumber: 10543,
      } as any);

      const row = await numberingSequenceRow(tenant.id, "INVOICE", 0);
      expect(row?.prefix).toBe("ACME-");
    }, 30_000);

    it("REG-B861-V the per-year collision re-scan escapes its prefix", async () => {
      const tenant = await seedTenant("v");
      const cust = await seedCustomer(tenant.id, "v");
      // No year-0 card row saved: this exercises the EXISTING per-year path (mintForYear), whose
      // scanMaxForYear builds its regex from an un-escaped prefix today.
      await seedNumberingSequenceRow(tenant.id, "INVOICE", YEAR, {
        prefix: "INV(",
        nextNumber: 1,
        padding: 4,
      });
      await seedInvoice(tenant.id, cust.id, `INV(${YEAR}-0001`);

      const minted = await reserveInvoiceNext(tenant.id);

      expect(minted).toBe(`INV(${YEAR}-0002`);
    }, 30_000);

    it("REG-B861-W the unconfigured preview is the per-year next", async () => {
      const tenant = await seedTenant("w");
      const cust = await seedCustomer(tenant.id, "w");
      await seedInvoice(tenant.id, cust.id, `INV-${YEAR}-0412`);
      await reserveInvoiceNext(tenant.id);

      const row = await getInvoiceSettingsRow(tenant.id);

      expect(row?.preview).toBe(`INV-${YEAR}-0414`);
    }, 30_000);

    it("REG-B861-Y 10 concurrent configured mints are INV-10543..INV-10552, none rejected", async () => {
      const tenant = await seedTenant("y");
      await saveInvoiceNumbering(tenant.id, { prefix: "INV-", nextNumber: 10543, padding: 5 });

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => reserveInvoiceNext(tenant.id)),
      );

      const rejected = results.filter((r) => r.status === "rejected");
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<string> => r.status === "fulfilled",
      );
      const expected = Array.from({ length: 10 }, (_, i) => `INV-${10543 + i}`);

      expect({
        rejectedCount: rejected.length,
        minted: fulfilled.map((r) => r.value).sort(),
      }).toEqual({ rejectedCount: 0, minted: [...expected].sort() });
    }, 30_000);

    it("unconfigured mint byte-identical: seed INV-<Y>-0412 → INV-<Y>-0413; zero NumberingSequence year-0 rows afterwards", async () => {
      const tenant = await seedTenant("p1");
      const cust = await seedCustomer(tenant.id, "p1");
      await seedInvoice(tenant.id, cust.id, `INV-${YEAR}-0412`);

      const minted = await reserveInvoiceNext(tenant.id);

      expect(minted).toBe(`INV-${YEAR}-0413`);

      const year0Count = await prisma.numberingSequence.count({
        where: { tenantId: tenant.id, year: 0 },
      });
      expect(year0Count).toBe(0);
    }, 30_000);

    it("P-6 report script: a qa tenant's saved rows land in the test bucket with the right counts, live count 0", async () => {
      const tenant = await seedTenant("p6");
      const cust = await seedCustomer(tenant.id, "p6");
      await saveInvoiceNumbering(tenant.id, { prefix: "INV-", nextNumber: 10543, padding: 5 });
      await tenantCtx.run(tenant.id, () =>
        // An unsaved row's token is the card's loaded default, 1 (SA-287b makes it required).
        numberingService.updateSettings("ESTIMATE", {
          prefix: "EST-",
          nextNumber: 1,
          padding: 4,
          expectedNextNumber: 1,
        }),
      );
      // Landed AFTER the saves, like an import or prior live volume.
      await seedInvoice(tenant.id, cust.id, `INV-${YEAR}-0001`);
      await seedInvoice(tenant.id, cust.id, "INV-10600");

      const apiDir = path.resolve(__dirname, "../..");
      const scriptPath = path.resolve(apiDir, "scripts/report-b861-numbering-config.mjs");
      const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: localDatabaseUrl };
      delete env.RAILWAY_TCP_PROXY_DOMAIN;
      delete env.RAILWAY_TCP_PROXY_PORT;
      delete env.POSTGRES_USER;
      delete env.POSTGRES_PASSWORD;
      delete env.POSTGRES_DB;

      const res = spawnSync(process.execPath, [scriptPath, "--json", "--tenant", tenant.id], {
        cwd: apiDir,
        encoding: "utf8",
        env,
        timeout: 60_000,
      });

      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.count).toBe(0);
      expect(parsed.test.INVOICE).toEqual({
        rows: 1,
        nonDefault: 1,
        perYearDocs: 1,
        nextAtOrBelow: 1,
      });
      expect(parsed.test.ESTIMATE).toEqual({
        rows: 1,
        nonDefault: 0,
        perYearDocs: 0,
        nextAtOrBelow: 0,
      });
    }, 30_000);
  },
);
