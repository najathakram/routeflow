/**
 * TP-DB / T3 (green half) — the PIN-B268 regression guard for import numbering.
 *
 * WHY A SEPARATE FILE: `import-numbering.db.spec.ts` is the RED-GATE file for
 * REG-B268 — every test in it must fail on today's code on its own predicted
 * wrong value. T3b is the opposite: the bug-test-plan declares it GREEN today
 * AND after the fix (a row carrying an explicit source `Invoice Number` keeps it
 * verbatim and re-imports through the upsert-by-number branch; D4 only changes
 * the source-NUMBERLESS fallback). Keeping a passing test in the repro file made
 * the red gate report "not all red" for a test that was never supposed to be
 * red, so the plan-sanctioned green pin lives here instead. Design of record:
 * `.claude/pipeline/2026-09-08-numbering-siblings/cause-ruling.md` §2 (D4);
 * plan `bug-test-plan.md` T3b.
 *
 * WHY THE DB LANE (L-061): the pin asserts that a REAL `@@unique([tenantId,
 * invoiceNumber])` row is found and repaired rather than duplicated, which a
 * mocked `prisma.invoice.findFirst` cannot establish. Collected only by
 * `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`;
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * SAFETY: every tenant this file creates is a throwaway `qa-b268p-<run>-<n>-<label>`
 * slug, approved by `assertTestTenant`. `afterAll` deletes exactly the tenants
 * THIS run created (FK order: ImportExternalRef → InvoicePayment → Invoice →
 * NumberingSequence → Customer → User → Tenant).
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
    `qa-b268p-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "import-numbering-pins.db.spec.ts",
  );
}

describeDb("B268 import-fallback numbering — green regression pins (T3b)", () => {
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
        // REAL ExternalRefService: the re-import path this pin exercises is the
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

  it("T3b PIN-B268-B (GREEN today and after): a row carrying an explicit 'Invoice Number' keeps it verbatim, and re-importing the SAME number with a status drift still runs the upsert-by-number branch (repairs status, never mints a new number)", async () => {
    const tenantA = await seedTenant("t3b-a");
    await seedCustomer(tenantA.id, "B268 Sourced Co");

    const csvFirst =
      "Invoice ID,Invoice Number,Customer Name,Total,Invoice Status,Balance Due\n" +
      "Z-200,INV-08841,B268 Sourced Co,25,Open,25\n";
    const first = await tenantCtx.run(tenantA.id, () =>
      importService.importInvoices(Buffer.from(csvFirst), "user-1"),
    );
    expect(first.imported).toBe(1);

    const stored = await prisma.invoice.findFirst({
      where: { tenantId: tenantA.id, invoiceNumber: "INV-08841" },
    });
    expect(stored?.status).toBe("SENT");

    // Re-import the SAME source number with the status drifted to Paid — the upsert-by-number
    // branch must find the row by its ORIGINAL, verbatim number and repair the drift, never mint
    // a fresh reserveNext() number for it.
    const csvRepaired =
      "Invoice ID,Invoice Number,Customer Name,Total,Invoice Status,Balance Due\n" +
      "Z-200,INV-08841,B268 Sourced Co,25,Paid,0\n";
    const second = await tenantCtx.run(tenantA.id, () =>
      importService.importInvoices(Buffer.from(csvRepaired), "user-1"),
    );
    expect(second.updated).toBe(1);
    expect(second.imported).toBe(0);

    const total = await prisma.invoice.count({
      where: { tenantId: tenantA.id, invoiceNumber: "INV-08841" },
    });
    expect(total).toBe(1);
  }, 30_000);
});
