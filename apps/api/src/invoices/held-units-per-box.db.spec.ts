/**
 * SA-1044 (B11a) rule 3 — DB-lane proof that the LOCKED row read behind an invoice line edit
 * (`loadLockedInvoiceForEdit` → `storedRows`) really returns each line's `unitsPerBox`. The invoice
 * `decideUnit` branch judges a held line's level (gone / resized / live) from that column; a
 * mock accepts any field, so only a real query proves the column comes back.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`; the real
 * connection is built in `beforeAll` and `requireLocalDatabaseUrl()` refuses any non-local host.
 * SAFETY: the tenant is a throwaway `qa-sa1044-<run>` slug approved by `assertTestTenant`;
 * `afterAll` deletes exactly what this run created, in FK order.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { loadLockedInvoiceForEdit } from "./locked-invoice-edit";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("loadLockedInvoiceForEdit — held unitsPerBox (SA-1044), real Postgres", () => {
  let prisma: PrismaService;
  let tenantId: string | null = null;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
  });

  afterAll(async () => {
    if (tenantId) {
      const where = { tenantId };
      await Promise.resolve()
        .then(() => prisma.invoiceItem.deleteMany({ where }))
        .then(() => prisma.invoice.deleteMany({ where }))
        .then(() => prisma.customer.deleteMany({ where }))
        .then(() => prisma.user.deleteMany({ where }))
        .then(() => prisma.tenant.delete({ where: { id: tenantId as string } }))
        .catch((e) => console.warn(`held-units-per-box.db.spec: cleanup failed: ${e}`));
    }
    await prisma?.$disconnect();
  });

  it("returns each stored line's unitsPerBox (and unitLabel) from the locked read", async () => {
    const slug = assertTestTenant(`qa-sa1044-${RUN}`, "held-units-per-box.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA1044 ${slug}` } });
    tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: "SA1044 buyer", contactName: "qa", tenantId },
    });
    const inv = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        invoiceNumber: `INV-SA1044-${RUN}`,
        status: "DRAFT",
        subtotal: 135,
        total: 135,
      },
    });
    await prisma.invoiceItem.createMany({
      data: [
        {
          tenantId,
          invoiceId: inv.id,
          description: "held case",
          qty: 1,
          unitPrice: 45,
          subtotal: 45,
          boxes: 1,
          unitsPerBox: 100,
          unitLabel: "Case",
        },
        {
          tenantId,
          invoiceId: inv.id,
          description: "held pack",
          qty: 2,
          unitPrice: 45,
          subtotal: 90,
          boxes: 2,
          unitsPerBox: 12,
          unitLabel: "Box",
        },
      ],
    });

    const locked = await prisma.$transaction((tx) => loadLockedInvoiceForEdit(tx, inv.id));

    const byLabel = Object.fromEntries(
      locked.storedRows.map((r: any) => [r.unitLabel, Number(r.unitsPerBox)]),
    );
    expect(locked.storedRows).toHaveLength(2);
    expect(byLabel).toEqual({ Case: 100, Box: 12 });
  });
});
