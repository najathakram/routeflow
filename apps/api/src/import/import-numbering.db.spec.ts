/**
 * TP-DB / T3 — DB-lane repro for REG-B268 (import fallback numbering). Design of record:
 * `.claude/pipeline/2026-09-08-numbering-siblings/cause-ruling.md` §2 (D4). Binding facts:
 * `cause-refutation.md` §2.2 ("REFUTED as filed, CONFIRMED worse" — no P2002 is ever thrown; the
 * colliding number resolves to the tenant's real LIVE invoice and the importer overwrites its
 * status/dueDate/paidAt), §4 (Invoice's out-of-band writer), §8 (test-oracle feasibility).
 *
 * WHY THE DB LANE (L-061): the "the importer silently mutates a live invoice instead of erroring"
 * defect can only be proven against a REAL Postgres — a mocked `prisma.invoice.findFirst` can't
 * reproduce the real collision between the importer's local `seq` counter and a genuine
 * `@@unique([tenantId, invoiceNumber])` row already sitting in the tenant.
 *
 * This spec drives the REAL, public `ImportService.importInvoices()` through a NestJS
 * TestingModule wired with a REAL `PrismaService` and a REAL `TenantContextService`, matching
 * `import-robustness.spec.ts`'s provider shape for `VendorBillsService`/`CustomersService` (mocked
 * at the module boundary) plus a REAL `NumberingService` (unused by `importInvoices` today — the
 * fallback branch is still the local `INV-${year}-${seq++}` counter — required once D4 lands:
 * `reserveNext("INVOICE", { year, tenantId })` per source-numberless row).
 *
 * SAFETY: every tenant this file creates is a throwaway `qa-b268-<run>-<n>-<label>` slug, approved
 * by `assertTestTenant`. `afterAll` deletes exactly the tenants THIS run created (FK order:
 * ImportExternalRef → InvoicePayment → Invoice → NumberingSequence → Customer → User →
 * Tenant).
 *
 * SELF-CONTAINED ORACLES: every test seeds every row its own expectation depends on (its own
 * fresh tenant, its own live invoice, its own CSV rows).
 *
 * RED-GATE FILE: every test here must FAIL on today's code on its own predicted wrong value. The
 * plan's GREEN pin for this area (T3b PIN-B268-B, source-numbered rows keeping their number) lives
 * in the sibling `import-numbering-pins.db.spec.ts`, not in this file.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
/** A fresh, policy-approved throwaway tenant slug — never reused across tests in this file. */
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b268-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "import-numbering.db.spec.ts",
  );
}

// Year the real generator derives from `new Date().getFullYear()` (LOCAL time, matching
// import.service.ts:540 exactly).
const YEAR = new Date().getFullYear();

describeDb("B268 import-fallback numbering — real Postgres (T3: live-invoice safety)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let importService: ImportService;
  const createdTenantIds: string[] = [];

  const mockVendorBills = { create: jest.fn(), receive: jest.fn() };
  const mockCustomers = {
    assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
    maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
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
        ImportService,
        NumberingService,
        // REAL ExternalRefService: T3c's re-import idempotency is exactly the
        // (source, externalId) → invoice mapping it writes, so it must hit Postgres.
        ExternalRefService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: mockVendorBills },
        { provide: CustomersService, useValue: mockCustomers },
      ],
    }).compile();

    importService = module.get(ImportService);
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
    await prisma.importExternalRef.deleteMany({ where: { tenantId } });
    await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.numberingSequence.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<{ id: string; slug: string }> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `B268 ${slug}` } });
    createdTenantIds.push(tenant.id);
    return { id: tenant.id, slug };
  }

  /** businessName is returned verbatim so the CSV's "Customer Name" can match it exactly. */
  async function seedCustomer(tenantId: string, businessName: string): Promise<{ id: string }> {
    const idBase = `${tenantId}-${businessName}`.replace(/[^a-z0-9]+/gi, "_");
    const user = await prisma.user.create({
      data: {
        email: `${idBase}@example.invalid`,
        username: idBase,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName, contactName: businessName, tenantId },
    });
    return { id: customer.id };
  }

  it("T3a REG-B268-A fallback rows reserve: importing two source-numberless rows into a tenant already holding a LIVE INV-<year>-0001 (SENT, no paidAt) must mint fresh numbers (…-0002, …-0003), report imported:2/updated:0, and leave the live invoice's status/paidAt untouched. TODAY: the first synthesized number collides with INV-<year>-0001, the importer UPDATES that live invoice's status/paidAt to the imported row's values instead of erroring, and reports updated:1/imported:1", async () => {
    const tenantA = await seedTenant("t3a-a");
    const custA = await seedCustomer(tenantA.id, "B268 Fallback Co");
    const liveInvoice = await prisma.invoice.create({
      data: {
        tenantId: tenantA.id,
        customerId: custA.id,
        invoiceNumber: `INV-${YEAR}-0001`,
        status: "SENT",
        subtotal: 10,
        total: 10,
      },
    });

    // Two groups (distinct "Invoice ID"), neither carries an "Invoice Number" column, so both
    // fall onto the synthesized-fallback branch (import.service.ts:631-632).
    const csv =
      "Invoice ID,Customer Name,Total,Invoice Status,Balance Due\n" +
      "Z-100,B268 Fallback Co,50,Paid,0\n" +
      "Z-101,B268 Fallback Co,60,Paid,0\n";

    const result = await tenantCtx.run(tenantA.id, () =>
      importService.importInvoices(Buffer.from(csv), "user-1"),
    );

    expect(result.updated).toBe(0);
    expect(result.imported).toBe(2);

    const untouchedLive = await prisma.invoice.findUnique({ where: { id: liveInvoice.id } });
    expect(untouchedLive?.status).toBe("SENT");
    expect(untouchedLive?.paidAt).toBeNull();

    const newInvoiceNumbers = await prisma.invoice.findMany({
      where: { tenantId: tenantA.id, invoiceNumber: { not: `INV-${YEAR}-0001` } },
      select: { invoiceNumber: true },
    });
    expect(newInvoiceNumbers.map((i) => i.invoiceNumber).sort()).toEqual([
      `INV-${YEAR}-0002`,
      `INV-${YEAR}-0003`,
    ]);
  }, 30_000);

  it("T3c REG-B268-C re-import idempotency: importing the SAME source-numberless PAID row (Invoice ID=A1) twice into a fresh tenant must leave exactly ONE invoice and ONE synthetic payment; the second run reports imported:0 and accounts for the row as updated-or-skipped. TODAY: the second run reserves a fresh number and creates a SECOND invoice (plus a second payment), doubling AR", async () => {
    const tenantA = await seedTenant("t3c-a");
    await seedCustomer(tenantA.id, "B268 Reimport Co");

    // One group, keyed on "Invoice ID" — no "Invoice Number" column anywhere, so it
    // is the fallback-mint branch on BOTH runs.
    const csv =
      "Invoice ID,Customer Name,Total,Invoice Status,Balance Due\n" +
      "A1,B268 Reimport Co,50,Paid,0\n";

    const first = await tenantCtx.run(tenantA.id, () =>
      importService.importInvoices(Buffer.from(csv), "user-1"),
    );
    expect(first.imported).toBe(1);

    const second = await tenantCtx.run(tenantA.id, () =>
      importService.importInvoices(Buffer.from(csv), "user-1"),
    );
    expect(second.imported).toBe(0);
    expect(second.updated + second.skipped).toBe(1);

    const invoices = await prisma.invoice.findMany({ where: { tenantId: tenantA.id } });
    expect(invoices).toHaveLength(1);
    const payments = await prisma.invoicePayment.count({
      where: { invoice: { tenantId: tenantA.id } },
    });
    expect(payments).toBe(1);
  }, 30_000);

  it("T3d REG-B268-D same-file ordering: a numberless group listed FIRST and a group whose source 'Invoice Number' is literally INV-<year>-0001 listed SECOND must both import — the source-numbered row keeps INV-<year>-0001 verbatim, the fallback row gets a DIFFERENT number, and nothing is updated. TODAY: the fallback mint takes INV-<year>-0001 first and the source-numbered row silently UPDATES it instead of creating its own invoice", async () => {
    const tenantA = await seedTenant("t3d-a");
    await seedCustomer(tenantA.id, "B268 Order Co");

    const csv =
      "Invoice ID,Invoice Number,Customer Name,Total,Invoice Status,Balance Due\n" +
      `Z-300,,B268 Order Co,40,Open,40\n` +
      `Z-301,INV-${YEAR}-0001,B268 Order Co,70,Open,70\n`;

    const result = await tenantCtx.run(tenantA.id, () =>
      importService.importInvoices(Buffer.from(csv), "user-1"),
    );

    expect(result.updated).toBe(0);
    expect(result.imported).toBe(2);

    const invoices = await prisma.invoice.findMany({
      where: { tenantId: tenantA.id },
      select: { invoiceNumber: true, total: true },
    });
    expect(invoices).toHaveLength(2);

    const sourced = invoices.find((i) => i.invoiceNumber === `INV-${YEAR}-0001`);
    expect(sourced).toBeDefined();
    expect(Number(sourced!.total)).toBe(70);

    const fallback = invoices.find((i) => i.invoiceNumber !== `INV-${YEAR}-0001`);
    expect(fallback).toBeDefined();
    expect(Number(fallback!.total)).toBe(40);
  }, 30_000);

  // F2 (REG-B268-C, cause-ruling.md §2 D2 follow-up / findings #1 on run 54): the
  // fallback re-import branch copied the numbered branch's payment-blind status
  // sync, so a row whose source status drifted OPEN→PAID flipped the prior
  // invoice to PAID while creating no InvoicePayment. Proves the fix — the SAME
  // synthetic-payment logic the create path runs — closes it on the UPDATE path,
  // and a second PAID re-import does not double the payment.
  it("T3e REG-B268-C re-import PAID creates the synthetic payment: run 1 open, run 2 paid, run 3 paid again — exactly one InvoicePayment for the invoice total, never zero and never two", async () => {
    const tenantA = await seedTenant("t3e-a");
    await seedCustomer(tenantA.id, "B268 Synthetic Pay Co");

    const openCsv =
      "Invoice ID,Customer Name,Total,Invoice Status,Balance Due\n" +
      "P1,B268 Synthetic Pay Co,80,Open,80\n";
    const paidCsv =
      "Invoice ID,Customer Name,Total,Invoice Status,Balance Due\n" +
      "P1,B268 Synthetic Pay Co,80,Paid,0\n";

    const run1 = await tenantCtx.run(tenantA.id, () =>
      importService.importInvoices(Buffer.from(openCsv), "user-1"),
    );
    expect(run1.imported).toBe(1);

    const invoicesAfterRun1 = await prisma.invoice.findMany({ where: { tenantId: tenantA.id } });
    expect(invoicesAfterRun1).toHaveLength(1);
    const invoiceId = invoicesAfterRun1[0].id;

    const run2 = await tenantCtx.run(tenantA.id, () =>
      importService.importInvoices(Buffer.from(paidCsv), "user-1"),
    );
    expect(run2.updated).toBe(1);

    const afterRun2 = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(afterRun2?.status).toBe("PAID");

    const paymentsAfterRun2 = await prisma.invoicePayment.findMany({
      where: { invoiceId },
    });
    expect(paymentsAfterRun2).toHaveLength(1);
    expect(Number(paymentsAfterRun2[0].amount)).toBe(80);

    // Re-importing the same already-PAID row a third time must not duplicate
    // the synthetic payment (the "no payment already exists" guard).
    const run3 = await tenantCtx.run(tenantA.id, () =>
      importService.importInvoices(Buffer.from(paidCsv), "user-1"),
    );
    expect(run3.imported).toBe(0);

    const paymentsAfterRun3 = await prisma.invoicePayment.findMany({ where: { invoiceId } });
    expect(paymentsAfterRun3).toHaveLength(1);
  }, 30_000);

  // F3 (REG-B268-D, cause-ruling.md §2 D2 follow-up / findings #1 on run 56): the
  // fallback idempotency key ("import", CSV "Invoice ID") has no file/job scope,
  // so a genuinely unrelated document from a SECOND file whose "Invoice ID" cell
  // collides with a prior import used to silently overwrite that prior invoice's
  // customer-owned data. Proves the customer/total mismatch guard: a colliding
  // but DIFFERENT row is imported as its OWN new invoice, with a warning row,
  // never merged into the unrelated prior one.
  it("T3f REG-B268-D overlapping Invoice IDs from a different file do not overwrite: a second file's row sharing the first file's 'Invoice ID' but a different customer/total imports as a SEPARATE invoice with a warning, and the first invoice is left untouched", async () => {
    const tenantA = await seedTenant("t3f-a");
    await seedCustomer(tenantA.id, "B268 Overlap Co One");
    await seedCustomer(tenantA.id, "B268 Overlap Co Two");

    // File 1: numberless row "Invoice ID" = X1, customer One, total 40.
    const fileOneCsv =
      "Invoice ID,Customer Name,Total,Invoice Status,Balance Due\n" +
      "X1,B268 Overlap Co One,40,Open,40\n";
    const run1 = await tenantCtx.run(tenantA.id, () =>
      importService.importInvoices(Buffer.from(fileOneCsv), "user-1"),
    );
    expect(run1.imported).toBe(1);

    const invoicesAfterRun1 = await prisma.invoice.findMany({ where: { tenantId: tenantA.id } });
    expect(invoicesAfterRun1).toHaveLength(1);
    const firstInvoiceId = invoicesAfterRun1[0].id;

    // File 2 (a different source system / hand-edited export): the SAME literal
    // "Invoice ID" text X1, but a different customer AND a different total —
    // genuinely a different document, not a re-upload of file 1's row.
    const fileTwoCsv =
      "Invoice ID,Customer Name,Total,Invoice Status,Balance Due\n" +
      "X1,B268 Overlap Co Two,90,Open,90\n";
    const run2 = await tenantCtx.run(tenantA.id, () =>
      importService.importInvoices(Buffer.from(fileTwoCsv), "user-1"),
    );

    // A NEW invoice, never an update of the first one.
    expect(run2.updated).toBe(0);
    expect(run2.imported).toBe(1);
    expect(run2.errors.some((e) => e.includes("X1"))).toBe(true);

    const allInvoices = await prisma.invoice.findMany({
      where: { tenantId: tenantA.id },
      select: { id: true, customerId: true, total: true },
    });
    expect(allInvoices).toHaveLength(2);

    // The first invoice's customer/total are exactly what file 1 wrote — never
    // touched by file 2's colliding row.
    const first = allInvoices.find((i) => i.id === firstInvoiceId);
    expect(first).toBeDefined();
    expect(Number(first!.total)).toBe(40);

    const second = allInvoices.find((i) => i.id !== firstInvoiceId);
    expect(second).toBeDefined();
    expect(Number(second!.total)).toBe(90);
    expect(second!.customerId).not.toBe(first!.customerId);
  }, 30_000);

  // Opus re-check fix (REG-B268-F): T3f proved a mismatched second file creates
  // its OWN invoice instead of overwriting the first. This proves the other
  // half — that the mismatch's fix (recording the new invoice under a
  // customer+total-scoped COMPOSITE external-ref key instead of repointing the
  // plain "Invoice ID" key) makes BOTH files independently idempotent when
  // alternated: re-importing file A always finds file A's own invoice (via the
  // plain key, untouched by B), and re-importing file B always finds file B's
  // own invoice (via the composite key recorded on its first import) — never a
  // third invoice, and never a swap between the two.
  it("T3g REG-B268-F alternating files are idempotent: A, B, A, B produces exactly two invoices, stable updated counts, and no new numbers after the second run", async () => {
    const tenant = await seedTenant("t3g-alt");
    await seedCustomer(tenant.id, "B268 Alt Co One");
    await seedCustomer(tenant.id, "B268 Alt Co Two");

    const fileA =
      "Invoice ID,Customer Name,Total,Invoice Status,Balance Due\n" +
      "X1,B268 Alt Co One,40,Open,40\n";
    const fileB =
      "Invoice ID,Customer Name,Total,Invoice Status,Balance Due\n" +
      "X1,B268 Alt Co Two,90,Open,90\n";

    // Run 1: A — mints a brand-new invoice under the plain "X1" key.
    const run1 = await tenantCtx.run(tenant.id, () =>
      importService.importInvoices(Buffer.from(fileA), "user-1"),
    );
    expect(run1.imported).toBe(1);
    expect(run1.updated).toBe(0);

    // Run 2: B — customer/total mismatch against A's "X1" record, so it mints
    // its OWN new invoice (recorded under the composite key), never touching A.
    const run2 = await tenantCtx.run(tenant.id, () =>
      importService.importInvoices(Buffer.from(fileB), "user-1"),
    );
    expect(run2.imported).toBe(1);
    expect(run2.updated).toBe(0);

    const afterRun2 = await prisma.invoice.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, invoiceNumber: true, customerId: true, total: true },
    });
    expect(afterRun2).toHaveLength(2);
    const invoiceA = afterRun2.find((i) => Number(i.total) === 40)!;
    const invoiceB = afterRun2.find((i) => Number(i.total) === 90)!;
    expect(invoiceA).toBeDefined();
    expect(invoiceB).toBeDefined();
    expect(invoiceA.customerId).not.toBe(invoiceB.customerId);

    // Run 3: A again — must resolve back to invoice A (plain key), never mint a
    // third invoice and never touch invoice B.
    const run3 = await tenantCtx.run(tenant.id, () =>
      importService.importInvoices(Buffer.from(fileA), "user-1"),
    );
    expect(run3.imported).toBe(0);
    expect(run3.updated + run3.skipped).toBe(1);

    // Run 4: B again — must resolve back to invoice B (composite key), never
    // mint a third invoice and never touch invoice A.
    const run4 = await tenantCtx.run(tenant.id, () =>
      importService.importInvoices(Buffer.from(fileB), "user-1"),
    );
    expect(run4.imported).toBe(0);
    expect(run4.updated + run4.skipped).toBe(1);

    const finalInvoices = await prisma.invoice.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, invoiceNumber: true, customerId: true, total: true },
    });
    // Still exactly two invoices — no new numbers minted after run 2.
    expect(finalInvoices).toHaveLength(2);
    const finalNumbers = finalInvoices.map((i) => i.invoiceNumber).sort();
    const afterRun2Numbers = afterRun2.map((i) => i.invoiceNumber).sort();
    expect(finalNumbers).toEqual(afterRun2Numbers);

    // Each original invoice's own customer/total is still exactly what its own
    // file wrote — the two never swapped or merged across the four runs.
    const finalA = finalInvoices.find((i) => i.id === invoiceA.id)!;
    const finalB = finalInvoices.find((i) => i.id === invoiceB.id)!;
    expect(finalA).toBeDefined();
    expect(Number(finalA.total)).toBe(40);
    expect(finalA.customerId).toBe(invoiceA.customerId);
    expect(finalB).toBeDefined();
    expect(Number(finalB.total)).toBe(90);
    expect(finalB.customerId).toBe(invoiceB.customerId);
  }, 30_000);
});
