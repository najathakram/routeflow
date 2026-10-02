/**
 * B949 (HIGH money; real Postgres): a restore that hands a CREDIT_NOTE payment's amount back to a note whose source invoice
 * was DELETED (the SOURCE_DELETED marker, #2848) would turn a provenance-less credit into spendable wallet money. The single
 * restore primitive refuses (409 CREDIT_NOTE_SOURCE_GONE), atomically, on every path; only the marked note's OWN void is exempt.
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-b949-<run>-<n>` slug approved by `assertTestTenant`.
 */
import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "./credit-notes.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "B949: a SOURCE_DELETED credit note is never restored to spendable: real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let creditNotes: CreditNotesService;
    const tenantIds: string[] = [];
    let seq = 0;
    let cnSeq = 0;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const anyMethod = new Proxy(
        {},
        {
          get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()),
        },
      );
      const mod = await Test.createTestingModule({
        providers: [
          CreditNotesService,
          RegulatedLedgerService,
          CommissionEngineService,
          AuditService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          { provide: RouteFlowGateway, useValue: anyMethod },
          {
            provide: NumberingService,
            useValue: {
              reserveNext: jest.fn().mockImplementation(async () => `CN-B949-${RUN}-${++cnSeq}`),
            },
          },
        ],
      }).compile();
      creditNotes = mod.get(CreditNotesService);
    });

    afterAll(async () => {
      const swallow = () => undefined;
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        await prisma.invoicePayment.deleteMany(where).catch(swallow);
        await prisma.creditNoteApplyBlock.deleteMany(where).catch(swallow);
        await prisma.creditNote.deleteMany(where).catch(swallow);
        await prisma.invoiceItem.deleteMany(where).catch(swallow);
        await prisma.invoice.deleteMany(where).catch(swallow);
        await prisma.customer.deleteMany(where).catch(swallow);
        await prisma.user.deleteMany(where).catch(swallow);
        await prisma.auditLog.deleteMany(where).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
    });

    /** An invoice X ($100, PAID by two credit-note payments: a MARKED note ($40) and an ORDINARY note ($60)). */
    async function seed(label: string) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-b949-${RUN}-${seq}-${label}`,
        "restore-source-gone.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `b949 ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const user = await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          invoiceNumber: `INV-B949-${RUN}-${seq}`,
          status: "PAID",
          subtotal: 100,
          taxAmount: 0,
          total: 100,
        },
      });
      const note = (n: string, amount: number) =>
        prisma.creditNote.create({
          data: {
            tenantId,
            customerId: customer.id,
            creditNoteNumber: `CN-B949-${RUN}-${seq}-${n}`,
            amount,
            amountUsed: amount,
            status: "APPLIED",
            appliedToInvoiceId: invoice.id,
          },
        });
      const [marked, ordinary] = [await note("m", 40), await note("o", 60)];
      // the marker a deleted source invoice leaves (#2848): the note's invoiceId is already null
      await prisma.auditLog.create({
        data: { tenantId, action: "SOURCE_DELETED", entityType: "CreditNote", entityId: marked.id },
      });
      const payment = (creditNoteId: string, amount: number) =>
        prisma.invoicePayment.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            amount,
            method: "CREDIT_NOTE",
            status: "PAID",
            creditNoteId,
            paymentNumber: `PAY-B949-${RUN}-${seq}-${creditNoteId.slice(0, 4)}`,
          } as any,
        });
      await payment(marked.id, 40);
      await payment(ordinary.id, 60);
      return { tenantId, invoice, marked, ordinary };
    }
    type Seed = Awaited<ReturnType<typeof seed>>;
    const inTx = <T>(s: Seed, fn: (tx: any) => Promise<T>) =>
      tenantCtx.run(s.tenantId, () => prisma.tenantTransaction(fn));
    const state = async (s: Seed) => ({
      payments: await prisma.invoicePayment.count({
        where: { invoiceId: s.invoice.id, method: "CREDIT_NOTE" },
      }),
      marked: await prisma.creditNote.findUnique({ where: { id: s.marked.id } }),
      ordinary: await prisma.creditNote.findUnique({ where: { id: s.ordinary.id } }),
      invoice: await prisma.invoice.findUnique({ where: { id: s.invoice.id } }),
    });

    it("1. releasing the invoice's credits (the voidInvoice path) is REFUSED 409 CREDIT_NOTE_SOURCE_GONE, atomically: BOTH payments stay, NEITHER note is restored, the invoice stays PAID", async () => {
      const s = await seed("release");
      await expect(
        inTx(s, (tx) => creditNotes.releaseInvoiceCreditsInTx(tx, s.invoice.id)),
      ).rejects.toMatchObject({ response: { code: "CREDIT_NOTE_SOURCE_GONE" } });
      const after = await state(s);
      expect(after.payments).toBe(2);
      expect(Number(after.marked!.amountUsed)).toBe(40);
      expect(after.marked!.status).toBe("APPLIED");
      expect(Number(after.ordinary!.amountUsed)).toBe(60); // the ordinary note was NOT restored first
      expect(after.invoice!.status).toBe("PAID");
    }, 60_000);

    it("2. the explicit unapply of the marked note is refused too, and writes nothing", async () => {
      const s = await seed("unapply");
      const err = await tenantCtx
        .run(s.tenantId, () => creditNotes.unapplyFromInvoice(s.marked.id, s.invoice.id))
        .catch((e) => e);
      expect(err.getResponse?.()).toMatchObject({ code: "CREDIT_NOTE_SOURCE_GONE" });
      expect((await state(s)).payments).toBe(2);
    }, 60_000);

    it("3. an ORDINARY note alone restores exactly as before (the control)", async () => {
      const s = await seed("ordinary");
      await tenantCtx.run(s.tenantId, () =>
        creditNotes.unapplyFromInvoice(s.ordinary.id, s.invoice.id),
      );
      const after = await state(s);
      expect(after.payments).toBe(1);
      expect(Number(after.ordinary!.amountUsed)).toBe(0);
    }, 60_000);

    it("4. THE WAY OUT: void the marked note first (its own void is exempt); the release then succeeds and restores NOTHING to it (it stays VOID)", async () => {
      const s = await seed("way-out");
      await tenantCtx.run(s.tenantId, () => creditNotes.voidWithReversal(s.marked.id, null as any));
      const mid = await state(s);
      expect(mid.marked!.status).toBe("VOID");
      await inTx(s, (tx) => creditNotes.releaseInvoiceCreditsInTx(tx, s.invoice.id));
      const after = await state(s);
      expect(after.marked!.status).toBe("VOID"); // never revived to ISSUED
      expect(after.payments).toBe(0);
    }, 60_000);
  },
);
