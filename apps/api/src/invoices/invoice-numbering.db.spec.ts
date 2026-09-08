/**
 * T1 — DB-lane repro for B100 (F16b invoice-number counter). Design of record:
 * `.claude/pipeline/2026-09-08-F16b-invoice-counter/cause-ruling.md` §2. Binding facts:
 * `cause-refutation.md` §7.
 *
 * WHY THE DB LANE (L-061): the cross-tenant leak and the concurrent-mint race are only
 * provable against a REAL Postgres — a mocked `prisma.invoice.findFirst` can't reproduce a
 * global unscoped scan seeing another tenant's row, or two transactions actually racing on
 * the same connection pool. Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via
 * `npm run local:test:db` (`node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w
 * apps/api"`), which points DATABASE_URL at the compose Postgres and sets RUN_DB_SPECS.
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * This spec drives the REAL `InvoicesService.create()` and `EstimatesService.convertToInvoice()`
 * — the public mint paths — through a NestJS TestingModule wired with a REAL `PrismaService`
 * (bound to the compose DB) and a REAL `TenantContextService` (so `forTenant()`/`tenantTransaction`
 * see genuine per-call tenant scoping), and every OTHER collaborator mocked at the module
 * boundary exactly as `invoices.service.spec.ts` does (same jest.mock shims for
 * `InvoicePdfService`/`compressDocument` — ESM traversal guard).
 *
 * SAFETY: every tenant this file creates is a throwaway `qa-b100-<run>-<n>-<label>` slug,
 * approved by `assertTestTenant` (`scripts/lib/test-tenants.cjs`); `afterAll` deletes exactly
 * the tenants THIS run created, in FK order (Estimate → Invoice → NumberingSequence → Customer
 * → User → Tenant), never anyone else's rows.
 *
 * SELF-CONTAINED ORACLES (the failure the RED-gate audit caught): every test seeds every row its
 * own expectation depends on, so its colour never depends on a sibling having run first. T1a,
 * T1d and T1e each seed a SECOND tenant whose `INV-<year>-*` volume is what today's global
 * unscoped scan mints from — so their tenant-scoped expectations (`…-0001`, `…-0413`, `…-0001`)
 * are unreachable today whether this file runs whole, alone, or against a dirty compose DB.
 *
 * T1a2 deliberately does NOT carry a cross-tenant seed: cause-refutation.md §c ("Also
 * unguarded: the estimates copy") establishes — and this file's first draft empirically
 * confirmed — that `EstimatesService.convertToInvoice`'s inline scan already runs inside
 * `tenantTransaction`, whose tx proxy auto-injects `tenantId` into every `SCOPED_METHODS` call
 * (`prisma.service.ts` `_wrapTxWithTenant`, `findFirst` included), so that path structurally
 * cannot reproduce a cross-tenant leak — a `…-0001` oracle there PASSES today. What D3 actually
 * requires — and what IS false today — is that the convert path mint from the SAME
 * `NumberingSequence` primitive `create()` will use (L-081, "all five mint sites move
 * together"), so T1a2 seeds that tenant-year counter at 700 and asserts both the minted number
 * and the counter it consumed.
 */

// Prevent Jest from traversing ESM-only dependencies (same guard as invoices.service.spec.ts).
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
import { performance } from "node:perf_hooks";
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
/** A fresh, policy-approved throwaway tenant slug — never reused across tests in this file. */
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b100-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "invoice-numbering.db.spec.ts",
  );
}

// Year the real generator derives from `new Date().getFullYear()` (LOCAL time, matching
// invoices.service.ts:2773 / estimates.service.ts:245 exactly — a UTC-based YEAR here could
// disagree with the host clock the code under test actually reads).
const YEAR = new Date().getFullYear();

describeDb(
  "B100 invoice numbering — real Postgres (T1: tenancy, wall, concurrency, lazy seed)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoicesService: InvoicesService;
    let estimatesService: EstimatesService;
    let numberingService: NumberingService;
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
    // flag.msrp OFF: applyMsrpSnapshots (invoices) / the estimate-convert MSRP branch both no-op.
    const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
    const mockCommissionEngine = {
      syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
      syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
      removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
    };

    beforeAll(async () => {
      // Nothing env-dependent may run at collection time (db-lane.db.spec.ts's rule): the real
      // connection is built here, inside a hook, never at module top level.
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          InvoicesService,
          EstimatesService,
          // REAL NumberingService over the REAL PrismaService above — the whole point
          // of this lane is the genuine per-tenant-year NumberingSequence store.
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
          { provide: EntitlementsService, useValue: mockEntitlements },
          { provide: CommissionEngineService, useValue: mockCommissionEngine },
        ],
      }).compile();

      invoicesService = module.get(InvoicesService);
      estimatesService = module.get(EstimatesService);
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
      const tenant = await prisma.tenant.create({ data: { slug, name: `B100 ${slug}` } });
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
          businessName: `B100 customer ${label}`,
          contactName: `B100 contact ${label}`,
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

    async function seedNumberingSequence(tenantId: string, year: number, nextNumber: number) {
      return prisma.numberingSequence.create({
        data: { tenantId, docType: "INVOICE", year, nextNumber, prefix: "INV-", padding: 4 },
      });
    }

    /** Drives the real, public mint path: InvoicesService.create() under a tenant context. */
    async function mintInvoice(tenantId: string, customerId: string): Promise<any> {
      return tenantCtx.run(tenantId, () =>
        invoicesService.create({
          customerId,
          items: [{ description: "widget", qty: 1, unitPrice: 10 }],
        } as any),
      );
    }

    async function numberingSequenceRow(tenantId: string, year: number) {
      return prisma.numberingSequence.findUnique({
        where: { tenantId_docType_year: { tenantId, docType: "INVOICE", year } },
      });
    }

    // — B100/F16b fix-round-2 (D6): estimate-numbering helpers, mirroring the
    // invoice ones above exactly but for docType "ESTIMATE" / the EST- prefix.
    async function seedEstimate(tenantId: string, customerId: string, estimateNumber: string) {
      return prisma.estimate.create({
        data: { tenantId, customerId, estimateNumber, status: "DRAFT", subtotal: 10, total: 10 },
      });
    }

    async function seedEstimateNumberingSequence(
      tenantId: string,
      year: number,
      nextNumber: number,
    ) {
      return prisma.numberingSequence.create({
        data: { tenantId, docType: "ESTIMATE", year, nextNumber, prefix: "EST-", padding: 4 },
      });
    }

    async function estimateNumberingSequenceRow(tenantId: string, year: number) {
      return prisma.numberingSequence.findUnique({
        where: { tenantId_docType_year: { tenantId, docType: "ESTIMATE", year } },
      });
    }

    /** Drives the real, public mint path: EstimatesService.create() under a tenant context. */
    async function mintEstimate(tenantId: string, customerId: string): Promise<any> {
      return tenantCtx.run(tenantId, () =>
        estimatesService.create({
          customerId,
          items: [{ description: "widget", qty: 1, unitPrice: 10 }],
        } as any),
      );
    }

    it("T1a REG-B100-A cross-tenant candidate: tenant A mints INV-<year>-0001 though tenant B already holds …-0037 (today: …-0038)", async () => {
      const tenantB = await seedTenant("t1a-b");
      const custB = await seedCustomer(tenantB.id, "b");
      await seedInvoice(tenantB.id, custB.id, `INV-${YEAR}-0037`);

      const tenantA = await seedTenant("t1a-a");
      const custA = await seedCustomer(tenantA.id, "a");

      const invoice = await mintInvoice(tenantA.id, custA.id);

      // Tenant A must never see tenant B's volume: as long as ANY INV-<year>-* row exists
      // anywhere (guaranteed by tenant B's own seed above), a leaked candidate can never equal
      // the tenant-scoped answer "…-0001" — so this fails today regardless of what else lives
      // in the compose DB.
      expect(invoice.invoiceNumber).toBe(`INV-${YEAR}-0001`);
    }, 30_000);

    it("T1a2 REG-B100-A convert path: tenant A's EstimatesService.convertToInvoice mints from the SAME per-tenant-year NumberingSequence create() uses — seeded at 700 it yields INV-<year>-0700 and leaves the row at 701 (today: INV-<year>-0001 off the inline scan, row untouched at 700)", async () => {
      // NOTE ON THE ORACLE vs the sibling T1a: cause-refutation.md §c ("Also unguarded: the
      // estimates copy") establishes that convertToInvoice's inline scan already runs inside
      // `tenantTransaction`, whose tx proxy auto-injects `tenantId` into every SCOPED_METHOD
      // (prisma.service.ts `_wrapTxWithTenant`, `findFirst` included) — so a T1a-style tenant-B
      // seed can never leak into this path, and a `…-0001` expectation would PASS today (the
      // wrong colour for a red-gate REG test; empirically confirmed against this DB, which is
      // why the test plan's stated TODAY value for T1a2 was corrected in place).
      // What D3 actually requires, and what IS false today, is that convertToInvoice mints from
      // the SAME `NumberingSequence` primitive `create()` will use (L-081 "all five mint sites
      // move together"). Seeding this tenant-year's counter at 700 makes that a self-contained
      // VALUE oracle no sibling test can influence: post-fix the mint consumes 700 →
      // `INV-<year>-0700` and leaves `nextNumber` at 701; today the inline scan ignores
      // `NumberingSequence` entirely and mints `INV-<year>-0001` off an empty Invoice table.
      const tenantA = await seedTenant("t1a2-a");
      const custA = await seedCustomer(tenantA.id, "a");
      await seedNumberingSequence(tenantA.id, YEAR, 700);
      const estimate = await prisma.estimate.create({
        data: {
          tenantId: tenantA.id,
          customerId: custA.id,
          estimateNumber: `EST-${YEAR}-0001`,
          status: "ACCEPTED",
          subtotal: 10,
          total: 10,
        },
      });

      const invoice = await tenantCtx.run(tenantA.id, () =>
        estimatesService.convertToInvoice(estimate.id),
      );

      expect((invoice as any).invoiceNumber).toBe(`INV-${YEAR}-0700`);

      // …and the counter it minted from actually moved: today convertToInvoice never reads or
      // writes NumberingSequence, so the seeded row is still sitting at 700.
      const seqRow = await numberingSequenceRow(tenantA.id, YEAR);
      expect(seqRow?.nextNumber).toBe(701);
    }, 30_000);

    it("T1b REG-B100-B the 9999 wall: minting past …-9999/…-10000 in one tenant yields INV-<year>-10001 (today: ConflictException)", async () => {
      const tenantA = await seedTenant("t1b-a");
      const custA = await seedCustomer(tenantA.id, "a");
      await seedInvoice(tenantA.id, custA.id, `INV-${YEAR}-9999`);
      await seedInvoice(tenantA.id, custA.id, `INV-${YEAR}-10000`);

      let invoice: any;
      let mintError: any;
      try {
        invoice = await mintInvoice(tenantA.id, custA.id);
      } catch (err) {
        mintError = err;
      }

      // ONE value oracle, so a red run reports the wrong VALUE rather than only "it threw":
      // today the mint dies with a P2002-backed ConflictException because the lexicographic
      // scan hands back the already-taken candidate …-10000 a second time.
      const minted = mintError
        ? `<threw ${mintError?.constructor?.name}: ${mintError?.message}>`
        : invoice?.invoiceNumber;
      expect(minted).toBe(`INV-${YEAR}-10001`);
    }, 30_000);

    it("T1c REG-B100-C ten concurrent mints: 10 parallel create() calls in one fresh tenant yield exactly {…-0001 … …-0010} with zero rejections (today: >= 1 rejection)", async () => {
      const tenantA = await seedTenant("t1c-a");
      const custA = await seedCustomer(tenantA.id, "a");

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => mintInvoice(tenantA.id, custA.id)),
      );

      const rejected = results.filter((r) => r.status === "rejected");
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<any> => r.status === "fulfilled",
      );

      expect(rejected).toHaveLength(0);
      const numbers = fulfilled.map((r) => r.value.invoiceNumber).sort();
      const expected = Array.from(
        { length: 10 },
        (_, i) => `INV-${YEAR}-${String(i + 1).padStart(4, "0")}`,
      );
      expect(numbers).toEqual(expected);
    }, 30_000);

    it("T1d REG-B100-D lazy seed from the true max: first mint after …-0412(+R1) and an imported INV-08841 is …-0413 and seeds NumberingSequence.nextNumber to 414 (today: no row is ever written)", async () => {
      // Seeded by THIS test: another tenant's much larger volume is what today's global
      // unscoped scan mints from, so the value oracle below is red whether this file runs
      // whole, alone, or against a dirty DB — the platform-wide lexicographic max is forced
      // to at least `INV-<year>-9000`, never tenant A's own 412 + 1.
      const tenantB = await seedTenant("t1d-b");
      const custB = await seedCustomer(tenantB.id, "b");
      await seedInvoice(tenantB.id, custB.id, `INV-${YEAR}-9000`);

      const tenantA = await seedTenant("t1d-a");
      const custA = await seedCustomer(tenantA.id, "a");
      await seedInvoice(tenantA.id, custA.id, `INV-${YEAR}-0412`);
      await seedInvoice(tenantA.id, custA.id, `INV-${YEAR}-0412-R1`);
      // Imported: a foreign shape with no year segment — must not be walked onto by the seed.
      await seedInvoice(tenantA.id, custA.id, "INV-08841");

      expect(await numberingSequenceRow(tenantA.id, YEAR)).toBeNull();

      const invoice = await mintInvoice(tenantA.id, custA.id);

      expect(invoice.invoiceNumber).toBe(`INV-${YEAR}-0413`);

      // The row now existing at all is the part today's generator can never satisfy — it never
      // touches NumberingSequence, so this is red today independent of any Invoice-table pollution.
      const seqRow = await numberingSequenceRow(tenantA.id, YEAR);
      expect(seqRow).not.toBeNull();
      expect(seqRow?.nextNumber).toBe(414);
    }, 30_000);

    it("T1e REG-B100-D2 year boundary: minting in <year> with a (tenant, INVOICE, <year-1>) row at nextNumber 500 yields …-0001 and leaves the prior-year row untouched (today: no per-year row exists at all)", async () => {
      // Seeded by THIS test so the …-0001 oracle is red today on its own: any `INV-<year>-*`
      // row anywhere makes the unscoped scan mint at least …-0043 for the (invoice-less) tenant A.
      const tenantB = await seedTenant("t1e-b");
      const custB = await seedCustomer(tenantB.id, "b");
      await seedInvoice(tenantB.id, custB.id, `INV-${YEAR}-0042`);

      const tenantA = await seedTenant("t1e-a");
      const custA = await seedCustomer(tenantA.id, "a");
      await seedNumberingSequence(tenantA.id, YEAR - 1, 500);

      const invoice = await mintInvoice(tenantA.id, custA.id);

      expect(invoice.invoiceNumber).toBe(`INV-${YEAR}-0001`);

      // Red today: nothing writes a per-year NumberingSequence row at all, so the current-year
      // row can never exist — regardless of what invoiceNumber the unscoped scan happened to mint.
      const currentYearRow = await numberingSequenceRow(tenantA.id, YEAR);
      expect(currentYearRow).not.toBeNull();

      const priorYearRow = await numberingSequenceRow(tenantA.id, YEAR - 1);
      expect(priorYearRow).not.toBeNull();
      expect(priorYearRow?.nextNumber).toBe(500);
    }, 30_000);

    it("T1g REG-B100-F2 oversize imported number ignored: with …-0412 and an 11-digit INV-<year>-99999999999 in the same tenant, the mint is …-0413 and the seeded counter reads 414 (today: INV-<year>-100000000000 off the lexicographic scan)", async () => {
      // The `INV-<year>-` namespace is shared with arbitrary imported text
      // (cause-refutation.md §7.9). `scanMaxForYear` bounds its capture to 9 digits ON
      // PURPOSE: a wider segment would overflow the `::int` cast and abort the whole
      // statement (SQLSTATE 22003) inside the caller's transaction. This pins BOTH halves
      // of that: the oversize row is ignored (value oracle …-0413, not …-100000000000 the
      // old `orderBy: invoiceNumber desc` scan mints from it) AND the seed statement
      // survives it at all rather than throwing.
      const tenantA = await seedTenant("t1g-a");
      const custA = await seedCustomer(tenantA.id, "a");
      await seedInvoice(tenantA.id, custA.id, `INV-${YEAR}-0412`);
      await seedInvoice(tenantA.id, custA.id, `INV-${YEAR}-99999999999`);

      const invoice = await mintInvoice(tenantA.id, custA.id);

      expect(invoice.invoiceNumber).toBe(`INV-${YEAR}-0413`);
      expect((await numberingSequenceRow(tenantA.id, YEAR))?.nextNumber).toBe(414);
    }, 30_000);

    it("T1h REG-B100-H out-of-band import block: a counter at 51 behind ten already-written INV-<year>-0051…0060 rows jumps the sequence straight past the block — mint …-0061 and the row reads 62 (today: nothing reads or writes the counter, so it stays at 51)", async () => {
      // The block is written in the exact shape `import.service.ts:632` emits
      // (`INV-${year}-${String(seq++).padStart(4, "0")}`), i.e. an import landed on
      // numbers the sequence has not reached yet. The collision guard must not walk the
      // block one round trip at a time (that scales the caller's OPEN transaction with the
      // import's width): one clash re-scans the tenant's true max and sets the counter
      // past it, so 51 → 61 in a single jump and the mint costs two increments, not ten.
      const tenantA = await seedTenant("t1h-a");
      const custA = await seedCustomer(tenantA.id, "a");
      await seedNumberingSequence(tenantA.id, YEAR, 51);
      for (let n = 51; n <= 60; n++) {
        // eslint-disable-next-line no-await-in-loop
        await seedInvoice(tenantA.id, custA.id, `INV-${YEAR}-${String(n).padStart(4, "0")}`);
      }

      const invoice = await mintInvoice(tenantA.id, custA.id);

      expect(invoice.invoiceNumber).toBe(`INV-${YEAR}-0061`);
      // The counter oracle is the half that is unreachable pre-fix: the old generator never
      // touched NumberingSequence, so the seeded row would still read 51. 62 (not 52) is
      // also what separates the single jump from a number-by-number walk.
      expect((await numberingSequenceRow(tenantA.id, YEAR))?.nextNumber).toBe(62);
    }, 30_000);

    it("T1i REG-B100-D2b the per-year row must not shadow the numbering settings card: after a mint seeds (tenant, INVOICE, <year>) at 414, getSettings() still reports INVOICE configured:false / nextNumber:1 / preview 'INV-0001'", async () => {
      // cause-ruling.md §2 D1: the per-year `INV-<year>-####` series and the year-0 series
      // the import numbering card reads (`getSettings`/`updateSettings`) are DIFFERENT
      // series in one table. Without the `year: 0` scope on getSettings, the row this mint
      // creates leaks into the card and it reports nextNumber 414 / configured true /
      // preview 'INV-0414' for a tenant that has never configured numbering at all — and
      // `seedFromSource` continuity would then be computed off a live invoice counter.
      const tenantA = await seedTenant("t1i-a");
      const custA = await seedCustomer(tenantA.id, "a");
      await seedInvoice(tenantA.id, custA.id, `INV-${YEAR}-0412`);

      const invoice = await mintInvoice(tenantA.id, custA.id);
      expect(invoice.invoiceNumber).toBe(`INV-${YEAR}-0413`);
      // Precondition for the oracle below: the per-year row genuinely exists, at a value
      // no default could be confused with.
      expect((await numberingSequenceRow(tenantA.id, YEAR))?.nextNumber).toBe(414);

      const settings = await tenantCtx.run(tenantA.id, () => numberingService.getSettings());
      const invoiceRow = settings.find((r) => r.docType === "INVOICE");
      expect(invoiceRow).toMatchObject({
        configured: false,
        nextNumber: 1,
        preview: "INV-0001",
      });
    }, 30_000);

    // fix-round-2.md D6: REG-B100-G ("no rollback burns a number") is RETIRED — D1
    // moves the reservation into its own short standalone transaction, so a rollback
    // AFTER reservation now leaves a gap on purpose (documented, accepted). This pin
    // replaces it with the invariant D1 actually buys: the reservation must never hold
    // the NumberingSequence row lock across the length of a caller's own transaction.
    it("T1j B100 reservation does not block a concurrent mint: tx A reserves and then holds its own transaction open for 1500ms before committing; a concurrent reserveNext for the SAME tenant-year must resolve in under 500ms (today: the in-tx row lock forces it to wait for tx A's commit, so this FAILS on the current in-tx-lock design; it PASSES once the reservation commits in its own short standalone transaction before caller work starts, cause-ruling.md fix-round-2.md D1)", async () => {
      const tenantA = await seedTenant("lock-a");
      await seedNumberingSequence(tenantA.id, YEAR, 700);

      // Tx A: reserve, then hold the transaction open for 1500ms before committing —
      // modelling the caller work (e.g. an order-completion tx) a reservation must
      // never be exposed to holding a row lock across (fix-round-2.md Rulings: "lock
      // -order inversion with the driver stop-completion tx (40P01, no retry) and
      // full-body serialization under the 5s interactive-tx budget").
      // NOTE: `reserveNext` takes no `tx` option at all (D1 — "no caller transaction
      // ever holds a NumberingSequence row lock"), so tx A models a caller transaction
      // that calls reserveNext as part of its own work, then keeps doing OTHER work
      // (the sleep) before committing — exactly the shape createInvoiceFromOrder/
      // convertToInvoice have today.
      const txAPromise = tenantCtx.run(tenantA.id, () =>
        prisma.tenantTransaction(async () => {
          const num = await numberingService.reserveNext("INVOICE", { year: YEAR });
          await new Promise((resolve) => setTimeout(resolve, 1500));
          return num;
        }),
      );

      // Give tx A a moment to acquire its row lock before racing tx B against it.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const start = performance.now();
      const secondNumber = await tenantCtx.run(tenantA.id, () =>
        numberingService.reserveNext("INVOICE", { year: YEAR }),
      );
      const elapsed = performance.now() - start;

      const firstNumber = await txAPromise;

      // Sanity: still exactly two distinct numbers minted, never a double-mint.
      expect(new Set([firstNumber, secondNumber]).size).toBe(2);

      // THE pin. Today's in-tx-lock design holds the NumberingSequence row lock for
      // the full 1500ms of tx A's simulated caller work — tx B's own increment blocks
      // on that row lock and only proceeds after tx A commits, so elapsed lands near
      // ~1500ms+ here, RED against the < 500 budget. After D1, the reservation commits
      // in its own short standalone transaction before tx A's sleep even begins, so
      // tx B never contends for the row and resolves in a handful of milliseconds.
      expect(elapsed).toBeLessThan(500);
    }, 30_000);

    // B100/F16b fix-round-2 D2 (E1, concurrent with this file): nextEstNumber()
    // routes through numbering.reserveNext("ESTIMATE", { year, tenantId }), same
    // visible format (EST-<year>-####) preserved exactly. These two DB-lane tests
    // pin that against the estimates' REAL public mint path, EstimatesService.create().
    it("T1k REG-B100-EST-A estimate numbering shares the per-tenant-year primitive: tenant A's own (ESTIMATE, <year>) counter is seeded at 700 while tenant B holds a much larger EST-<year>-* volume — the first create() consumes tenant A's OWN row as …-0700 and leaves it at 701 (today: nextEstNumber() never reads NumberingSequence at all, so it mints …-0001 off the empty tenant-scoped Estimate scan and the seeded row stays at 700)", async () => {
      // NOTE ON THE ORACLE (same RED-gate remediation class as T1a2 above): a
      // literal cross-tenant seed — tenant B holds a volume, tenant A mints and we
      // expect "…-0001" — would be GREEN today and prove nothing. nextEstNumber()
      // already reads through this.prisma.forTenant(), whose extension injects
      // tenantId into findFirst's `where` (prisma.service.ts `_tenantExtension`),
      // so tenant A's scan structurally never sees tenant B's rows even today. The
      // real B100/F16b gap for estimates is that nextEstNumber() mints off an
      // Estimate-table TEXT scan instead of the SAME NumberingSequence primitive
      // invoices use — so the value oracle here is tenant A's OWN seeded counter,
      // with tenant B's larger, unrelated volume standing as a decoy proving the
      // fix stays tenant-scoped too (it must never derive from …-0900).
      const tenantB = await seedTenant("esta-b");
      const custB = await seedCustomer(tenantB.id, "b");
      await seedEstimate(tenantB.id, custB.id, `EST-${YEAR}-0900`);

      const tenantA = await seedTenant("esta-a");
      const custA = await seedCustomer(tenantA.id, "a");
      await seedEstimateNumberingSequence(tenantA.id, YEAR, 700);

      const estimate = await mintEstimate(tenantA.id, custA.id);

      expect(estimate.estimateNumber).toBe(`EST-${YEAR}-0700`);

      const seqRow = await estimateNumberingSequenceRow(tenantA.id, YEAR);
      expect(seqRow?.nextNumber).toBe(701);
    }, 30_000);

    it("T1l REG-B100-EST-B the 9999 wall for estimates: tenant A holds EST-<year>-9999 and EST-<year>-10000, the next create() must mint EST-<year>-10001 (today: nextEstNumber()'s TEXT orderBy re-derives the already-taken candidate …-10000 and create() has no P2002 catch, so a raw unique-constraint error propagates)", async () => {
      const tenantA = await seedTenant("estb-a");
      const custA = await seedCustomer(tenantA.id, "a");
      await seedEstimate(tenantA.id, custA.id, `EST-${YEAR}-9999`);
      await seedEstimate(tenantA.id, custA.id, `EST-${YEAR}-10000`);

      let estimate: any;
      let mintError: any;
      try {
        estimate = await mintEstimate(tenantA.id, custA.id);
      } catch (err) {
        mintError = err;
      }

      // ONE value oracle, same discipline as T1b: a red run reports the wrong VALUE
      // rather than only "it threw". Today nextEstNumber()'s `orderBy:
      // { estimateNumber: "desc" }` is a TEXT sort, under which "…-9999" sorts AFTER
      // "…-10000" (the digit "9" > "1"), so `last` is "…-9999", seq becomes 10000,
      // and create() tries to insert the ALREADY-TAKEN "…-10000" — colliding on the
      // tenant-scoped @@unique([tenantId, estimateNumber]). create() has no P2002
      // catch (unlike convertToInvoice's), so the raw Prisma error propagates.
      const minted = mintError
        ? `<threw ${mintError?.constructor?.name}: ${mintError?.message}>`
        : estimate?.estimateNumber;
      expect(minted).toBe(`EST-${YEAR}-10001`);
    }, 30_000);
  },
);
