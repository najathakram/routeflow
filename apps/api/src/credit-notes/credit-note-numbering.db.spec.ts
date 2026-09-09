/**
 * TP-DB / T1 — DB-lane repro for REG-B267 (credit-note numbering). Design of record:
 * `.claude/pipeline/2026-09-08-numbering-siblings/cause-ruling.md` §2 (D1/D2). Binding facts:
 * `cause-refutation.md` §1.3 (the literal `CreditNote` branch), §2.1 (the per-row repro and its
 * two SERIALIZABLE corrections), §4 (unique constraints / P2002 handling), §5 (callers/tx state),
 * §8 (test-oracle feasibility + the harness blocker).
 *
 * WHY THE DB LANE (L-061): the cross-tenant leak, the 9999 wall's P2002, and the concurrent-mint
 * race are only provable against a REAL Postgres — a mocked `prisma.creditNote.findFirst` can't
 * reproduce an unscoped global scan seeing another tenant's row, or two SERIALIZABLE transactions
 * actually racing on the same connection pool. Collected only by `jest.db.config.js`
 * (`.db.spec.ts$`), run via `npm run local:test:db` (`node scripts/local-env.mjs --db --db-specs
 * -- "npm run test:db -w apps/api"`), which points DATABASE_URL at the compose Postgres and sets
 * RUN_DB_SPECS. `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * This spec drives the REAL `CreditNotesService.create()` — the public mint path — through a
 * NestJS TestingModule wired with a REAL `PrismaService` (bound to the compose DB), a REAL
 * `TenantContextService` (so `forTenant()`/`tenantTransaction` see genuine per-call tenant
 * scoping) and a REAL `NumberingService` (unused by `create()` TODAY — `nextCnNumber` is its own
 * standalone TEXT scan — but required post-D1/D2 once CREDIT_NOTE joins the year-scoped path), and
 * every OTHER collaborator (`RouteFlowGateway`, `RegulatedLedgerService`, `CommissionEngineService`)
 * mocked at the module boundary, mirroring `invoice-numbering.db.spec.ts`.
 *
 * SAFETY: every tenant this file creates is a throwaway `qa-b267-<run>-<n>-<label>` slug, approved
 * by `assertTestTenant` (`scripts/lib/test-tenants.cjs`); `afterAll` deletes exactly the tenants
 * THIS run created (FK order: CreditNoteItem → CreditNote → Invoice → NumberingSequence → Customer
 * → User → Tenant), plus any orphan (`tenantId: null`) CreditNote rows T1a itself writes — never
 * anyone else's rows.
 *
 * SELF-CONTAINED ORACLES: every test seeds every row its own expectation depends on, so its colour
 * never depends on a sibling having run first or on what else lives in the compose DB.
 *
 * ON T1a's ORACLE (a real ambiguity worth recording): the compressed test-plan bullet phrases the
 * AFTER-fix value as "tenant A mints CN-<year>-0001", but `cause-ruling.md`'s own design (D2)
 * states "tenantId explicit from the caller's context; null → the service throws" and
 * `cause-refutation.md` §2.1's literal repro concludes "Expected: refuse" — and there is no route
 * or DTO field today (`credit-notes.controller.ts` / `TenantInterceptor`) through which a
 * SUPER_ADMIN token (ambient tenantId genuinely null) can supply an explicit target tenant to
 * `create()`. Given the direct conflict, this file follows the two BINDING sources
 * (cause-ruling.md D2 + cause-refutation.md §2.1) over the compressed bullet: the oracle is
 * "refuses, mints nothing" for a null-ambient call, not "mints CN-<year>-0001". Flagged for the
 * build/review agents to confirm against the real fix.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
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
    `qa-b267-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "credit-note-numbering.db.spec.ts",
  );
}

// Year the real generator derives from `new Date().getFullYear()` (LOCAL time, matching
// credit-notes.service.ts:35 exactly — a UTC-based YEAR here could disagree with the host clock
// the code under test actually reads).
const YEAR = new Date().getFullYear();

describeDb(
  "B267 credit-note numbering — real Postgres (T1: tenancy, wall, seed, concurrency)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let creditNotesService: CreditNotesService;
    const createdTenantIds: string[] = [];
    // T1a's null-ambient repro can write an orphan (tenantId: null) CreditNote today — tracked
    // separately since cleanupTenant's `where: { tenantId }` deleteMany can never match it.
    const createdOrphanCreditNoteIds: string[] = [];

    const mockGateway = { emitCreditNoteCreated: jest.fn() };
    const mockLedger = {
      reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
      unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
    };
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
          CreditNotesService,
          // REAL NumberingService over the REAL PrismaService above — unused by create() today,
          // required once D1/D2 land (CREDIT_NOTE joins the year-scoped reserveNext path).
          NumberingService,
          { provide: PrismaService, useValue: prisma },
          { provide: RouteFlowGateway, useValue: mockGateway },
          { provide: RegulatedLedgerService, useValue: mockLedger },
          { provide: CommissionEngineService, useValue: mockCommissionEngine },
        ],
      }).compile();

      creditNotesService = module.get(CreditNotesService);
    });

    afterAll(async () => {
      for (const id of createdOrphanCreditNoteIds) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.creditNote.delete({ where: { id } }).catch(() => {
          // Best-effort: a failed cleanup must never mask the test's own pass/fail result.
        });
      }
      for (const tenantId of createdTenantIds) {
        // eslint-disable-next-line no-await-in-loop
        await cleanupTenant(tenantId).catch(() => {
          // Best-effort: a failed cleanup must never mask the test's own pass/fail result.
        });
      }
      await prisma?.$disconnect();
    });

    async function cleanupTenant(tenantId: string): Promise<void> {
      await prisma.creditNoteItem.deleteMany({ where: { tenantId } });
      await prisma.creditNote.deleteMany({ where: { tenantId } });
      await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
      await prisma.invoice.deleteMany({ where: { tenantId } });
      await prisma.numberingSequence.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }

    async function seedTenant(label: string): Promise<{ id: string; slug: string }> {
      const slug = freshTenantSlug(label);
      const tenant = await prisma.tenant.create({ data: { slug, name: `B267 ${slug}` } });
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
          businessName: `B267 customer ${label}`,
          contactName: `B267 contact ${label}`,
          tenantId,
        },
      });
      return { id: customer.id };
    }

    /** Direct write (bypasses the service) so a wall/lazy-seed test can plant an exact number. */
    async function seedCreditNote(tenantId: string, customerId: string, creditNoteNumber: string) {
      return prisma.creditNote.create({
        data: { tenantId, customerId, creditNoteNumber, amount: 5, status: "ISSUED" },
      });
    }

    /** Direct write so a test can plant the counter at an exact value (mirrors the invoice spec). */
    async function seedCreditNoteNumberingSequence(
      tenantId: string,
      year: number,
      nextNumber: number,
    ) {
      return prisma.numberingSequence.create({
        data: { tenantId, docType: "CREDIT_NOTE", year, nextNumber, prefix: "CN-", padding: 4 },
      });
    }

    async function creditNoteNumberingSequenceRow(tenantId: string, year: number) {
      return prisma.numberingSequence.findUnique({
        where: { tenantId_docType_year: { tenantId, docType: "CREDIT_NOTE", year } },
      });
    }

    it("T1a REG-B267-A cross-tenant on a null tenant: with NO request tenant (the SUPER_ADMIN path) create() must refuse rather than leak into another tenant's series and write an orphan row — tenant B holds CN-<year>-0037. TODAY: the null-ambient call mints CN-<year>-0038 off an unscoped scan (and writes it on a tenantId:null row)", async () => {
      const tenantB = await seedTenant("t1a-b");
      const custB = await seedCustomer(tenantB.id, "b");
      await seedCreditNote(tenantB.id, custB.id, `CN-${YEAR}-0037`);

      const tenantA = await seedTenant("t1a-a");
      const custA = await seedCustomer(tenantA.id, "a");

      // No tenantCtx.run() wrapper anywhere below — genuinely null ambient tenant context, the
      // path a SUPER_ADMIN token takes (TenantInterceptor sets ambient tenantId to `user.tenantId
      // ?? null`, and SUPER_ADMIN users carry no tenantId).
      let outcome: string;
      let orphanId: string | undefined;
      let thrownMessage: string | undefined;
      try {
        const cn = await creditNotesService.create({ customerId: custA.id, amount: 5 } as any);
        outcome = cn.creditNoteNumber;
        orphanId = cn.id;
      } catch (err: any) {
        outcome = `<threw ${err?.constructor?.name}>`;
        thrownMessage = err?.message;
      }
      if (orphanId) createdOrphanCreditNoteIds.push(orphanId);

      expect(outcome).toBe("<threw BadRequestException>");
      // The refusal must be the TENANT refusal, not an amount/invoice rejection
      // reached after cross-tenant reads on the unscoped client.
      expect(thrownMessage).toBe("A tenant context is required.");
    }, 30_000);

    it("T1b REG-B267-B the 9999 wall: minting past CN-<year>-9999/…-10000 in one tenant yields CN-<year>-10001 (today: an unhandled error since the TEXT sort re-derives the already-taken …-10000 candidate)", async () => {
      const tenantA = await seedTenant("t1b-a");
      const custA = await seedCustomer(tenantA.id, "a");
      await seedCreditNote(tenantA.id, custA.id, `CN-${YEAR}-9999`);
      await seedCreditNote(tenantA.id, custA.id, `CN-${YEAR}-10000`);

      let outcome: string;
      try {
        const cn = await tenantCtx.run(tenantA.id, () =>
          creditNotesService.create({ customerId: custA.id, amount: 5 } as any),
        );
        outcome = cn.creditNoteNumber;
      } catch (err: any) {
        outcome = `<threw ${err?.constructor?.name}: ${err?.message}>`;
      }

      expect(outcome).toBe(`CN-${YEAR}-10001`);
    }, 30_000);

    it("T1c REG-B267-C lazy seed: tenant A holds CN-<year>-0412 with no NumberingSequence row at all → the next create mints CN-<year>-0413 and seeds NumberingSequence(tenant, CREDIT_NOTE, <year>).nextNumber to 414 (today: no such row is ever written)", async () => {
      // ON THIS TEST'S TWO HALVES: the `CN-<YEAR>-0413` value assertion is
      // ALREADY GREEN today — the TEXT scan reaches the same next value from a
      // single seeded row. The RED half is the seeded NumberingSequence row
      // below (today `nextCnNumber` never touches that table at all), which is
      // what proves the mint moved onto the year-scoped counter.
      const tenantA = await seedTenant("t1c-a");
      const custA = await seedCustomer(tenantA.id, "a");
      await seedCreditNote(tenantA.id, custA.id, `CN-${YEAR}-0412`);

      expect(await creditNoteNumberingSequenceRow(tenantA.id, YEAR)).toBeNull();

      const cn = await tenantCtx.run(tenantA.id, () =>
        creditNotesService.create({ customerId: custA.id, amount: 5 } as any),
      );
      expect(cn.creditNoteNumber).toBe(`CN-${YEAR}-0413`);

      const seqRow = await creditNoteNumberingSequenceRow(tenantA.id, YEAR);
      expect(seqRow).not.toBeNull();
      expect(seqRow?.nextNumber).toBe(414);
    }, 30_000);

    it("T1d REG-B267-D validate before reserve: a create rejected for a validation reason (against a VOID invoice) must burn no number — the sequence a PRIOR successful create established stays untouched. TODAY (structural half): no NumberingSequence(CREDIT_NOTE) row is ever written by either create, successful or rejected", async () => {
      const tenantA = await seedTenant("t1d-a");
      const custA = await seedCustomer(tenantA.id, "a");
      const voidInvoice = await prisma.invoice.create({
        data: {
          tenantId: tenantA.id,
          customerId: custA.id,
          invoiceNumber: `INV-${YEAR}-0001`,
          status: "VOID",
          subtotal: 100,
          total: 100,
        },
      });

      // A successful create first, to establish the sequence at nextNumber 2.
      await tenantCtx.run(tenantA.id, () =>
        creditNotesService.create({ customerId: custA.id, amount: 5 } as any),
      );

      // STRUCTURAL half: today nextCnNumber never touches NumberingSequence at all, so this row
      // is null regardless of anything the rejected attempt below does.
      const afterFirst = await creditNoteNumberingSequenceRow(tenantA.id, YEAR);
      expect(afterFirst?.nextNumber).toBe(2);

      // Now a create that MUST be rejected on validation: against a VOID invoice
      // (CREDIT_SOURCE_EXCLUDED, invoice-status-sets.ts).
      let rejectError: any;
      try {
        await tenantCtx.run(tenantA.id, () =>
          creditNotesService.create({
            customerId: custA.id,
            invoiceId: voidInvoice.id,
            amount: 5,
          } as any),
        );
      } catch (err) {
        rejectError = err;
      }
      expect(rejectError).toBeInstanceOf(BadRequestException);

      // BEHAVIOURAL half: the rejected attempt burned no number — the sequence is still at 2.
      const afterRejected = await creditNoteNumberingSequenceRow(tenantA.id, YEAR);
      expect(afterRejected?.nextNumber).toBe(2);

      // The same property proved on the MINTED VALUE, independently of the
      // sequence row: the next successful create takes CN-<YEAR>-0002, i.e. the
      // rejected attempt consumed nothing. A fix that reserved BEFORE validating
      // would satisfy neither this nor the row assertion above, but this half
      // survives even if the counter is stored somewhere else entirely.
      const afterReject = await tenantCtx.run(tenantA.id, () =>
        creditNotesService.create({ customerId: custA.id, amount: 5 } as any),
      );
      expect(afterReject.creditNoteNumber).toBe(`CN-${YEAR}-0002`);
    }, 30_000);

    it("T1e REG-B267-E concurrency: 5 parallel creates in one fresh tenant yield exactly {CN-<year>-0001 … CN-<year>-0005} with zero rejections (today: at least one rejection — every racer re-derives the same scanned candidate inside the SERIALIZABLE tx, so the losers die on a write-conflict/deadlock serialization failure, or on @@unique([tenantId, creditNoteNumber]) when they commit far enough apart; neither is caught)", async () => {
      const tenantA = await seedTenant("t1e-a");
      const custA = await seedCustomer(tenantA.id, "a");

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          tenantCtx.run(tenantA.id, () =>
            creditNotesService.create({ customerId: custA.id, amount: 5 } as any),
          ),
        ),
      );

      const rejected = results.filter((r) => r.status === "rejected");
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<any> => r.status === "fulfilled",
      );

      expect(rejected).toHaveLength(0);
      const numbers = fulfilled.map((r) => r.value.creditNoteNumber).sort();
      const expected = Array.from(
        { length: 5 },
        (_, i) => `CN-${YEAR}-${String(i + 1).padStart(4, "0")}`,
      );
      expect(numbers).toEqual(expected);
    }, 30_000);

    // F1 (cause-ruling.md §2 D2 follow-up): T1e above deliberately omits
    // `invoiceId`, so the concurrency oracle never exercises the shape the
    // fix (a bounded P2034 retry, credit-notes.service.ts ~:301-338) actually
    // targets — five parallel creates against the SAME invoice, where
    // `validateAndBuildCnItems`'s `creditNote.aggregate` read inside the
    // SERIALIZABLE tx is a real rw-antidependency against every racer's
    // insert. Proves the retry closes it: every racer either commits with a
    // distinct number, or is refused with a 409 — never a raw 500, and never
    // two racers sharing a number.
    it("T1h REG-B267-H concurrent credit notes against the SAME invoice: 5 parallel creates with invoiceId set all succeed with distinct numbers, or at most 409s — zero 500s", async () => {
      const tenantA = await seedTenant("t1h-a");
      const custA = await seedCustomer(tenantA.id, "a");
      const invoiceA = await prisma.invoice.create({
        data: {
          tenantId: tenantA.id,
          customerId: custA.id,
          invoiceNumber: `INV-${YEAR}-9001`,
          status: "SENT",
          subtotal: 1000,
          total: 1000,
        },
      });

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          tenantCtx.run(tenantA.id, () =>
            creditNotesService.create({
              customerId: custA.id,
              invoiceId: invoiceA.id,
              amount: 5,
            } as any),
          ),
        ),
      );

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<any> => r.status === "fulfilled",
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

      // Every rejection, if any, must be the 409 the exhausted-retry path
      // throws — never a raw 500 (a P2034/40001 that escaped uncaught) and
      // never anything else (e.g. a validation exception, which nothing here
      // should trigger).
      for (const r of rejected) {
        expect(typeof r.reason?.getStatus).toBe("function");
        expect(r.reason.getStatus()).toBe(409);
      }

      // Distinct numbers: no two fulfilled racers share the reserved number
      // the retry is required to reuse across its own attempts, but never
      // across DIFFERENT requests.
      const numbers = fulfilled.map((r) => r.value.creditNoteNumber);
      expect(new Set(numbers).size).toBe(numbers.length);

      // At least one racer must get through — the retry exists so contention
      // resolves, not so every racer can legitimately lose.
      expect(fulfilled.length).toBeGreaterThan(0);
    }, 30_000);

    it("T1f REG-B267-F collision guard: a counter at 7 with CN-<year>-0007 already written in the tenant must SKIP the taken number — mint CN-<year>-0008 with no throw and the row reads 9 (a wrong table in findTaken's CREDIT_NOTE branch proves the taken candidate free, hands it out, and the create dies on @@unique([tenantId, creditNoteNumber]) → a permanent 409)", async () => {
      // The CREDIT_NOTE mirror of the INVOICE guard case (`invoice-numbering.db.spec.ts` T1h).
      // Nothing writes credit notes out of band TODAY, but the guard is the whole justification
      // for routing CREDIT_NOTE through the year-scoped path (`numbering.service.ts`'s
      // `YearScopedDocType` comment), and it must be pinned against a table mix-up: the guard
      // never firing means the sequence is never jumped past the taken number, so every retry of
      // the resulting 409 returns the same 409 — a permanent stall for that tenant.
      // A restored/merged row, or a manual insert, is how the tenant reaches this state.
      const tenantA = await seedTenant("t1f-a");
      const custA = await seedCustomer(tenantA.id, "a");
      await seedCreditNoteNumberingSequence(tenantA.id, YEAR, 7);
      await seedCreditNote(tenantA.id, custA.id, `CN-${YEAR}-0007`);

      let outcome: string;
      try {
        const cn = await tenantCtx.run(tenantA.id, () =>
          creditNotesService.create({ customerId: custA.id, amount: 5 } as any),
        );
        outcome = cn.creditNoteNumber;
      } catch (err: any) {
        outcome = `<threw ${err?.constructor?.name}: ${err?.message}>`;
      }

      expect(outcome).toBe(`CN-${YEAR}-0008`);
      // 9, not 8: the guard consumed the taken 7 and then reserved 8, so the counter has moved
      // twice. This half is what separates a real skip from a lucky mint.
      expect((await creditNoteNumberingSequenceRow(tenantA.id, YEAR))?.nextNumber).toBe(9);
    }, 30_000);

    it("T1g REG-B267-G foreign customer: tenant A creating against tenant B's customer (no invoiceId) must 404 — no CreditNote row in A and no number burned", async () => {
      const tenantB = await seedTenant("t1g-b");
      const custB = await seedCustomer(tenantB.id, "b");

      const tenantA = await seedTenant("t1g-a");
      const custA = await seedCustomer(tenantA.id, "a");

      // A successful in-tenant create first, so A's sequence exists at a known value.
      await tenantCtx.run(tenantA.id, () =>
        creditNotesService.create({ customerId: custA.id, amount: 5 } as any),
      );
      const before = await creditNoteNumberingSequenceRow(tenantA.id, YEAR);
      expect(before?.nextNumber).toBe(2);

      let rejectError: any;
      try {
        await tenantCtx.run(tenantA.id, () =>
          creditNotesService.create({ customerId: custB.id, amount: 5 } as any),
        );
      } catch (err) {
        rejectError = err;
      }
      expect(rejectError).toBeInstanceOf(NotFoundException);

      // No credit note bound to B's customer anywhere, and A's series untouched.
      const bound = await prisma.creditNote.findMany({ where: { customerId: custB.id } });
      expect(bound).toHaveLength(0);
      const after = await creditNoteNumberingSequenceRow(tenantA.id, YEAR);
      expect(after?.nextNumber).toBe(2);
    }, 30_000);
  },
);
