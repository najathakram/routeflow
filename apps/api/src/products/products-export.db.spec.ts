/**
 * Products CSV export — real-Postgres pins (WHY THE DB LANE: the tenant scope on the batched
 * `invoiceItem` read goes through a parent-relation filter, and the id-cursor batching, the
 * accrual status filter and the audit row are only provable against a real Postgres).
 *
 * Run through `npm run local:test:db`; `requireLocalDatabaseUrl()` refuses a non-local host.
 * SAFETY: every tenant is a throwaway `qa-csv-<run>-<n>-<label>` slug approved by
 * `assertTestTenant`; `afterAll` deletes exactly what THIS run created. No live client names.
 */
import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SalesFactsService } from "../sales-facts/sales-facts.service";
import { ProductsExportService, PRODUCTS_EXPORT_BATCH } from "./products-export.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const stamp = (day: string) => new Date(`${day}T00:00:00.000Z`);

describeDb("products export.csv — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let exporter: ProductsExportService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module = await Test.createTestingModule({
      providers: [
        ProductsExportService,
        SalesFactsService,
        AuditService,
        { provide: PrismaService, useValue: prisma },
        { provide: PRODUCTS_EXPORT_BATCH, useValue: 2 }, // force several id-cursor batches
      ],
    }).compile();
    exporter = module.get(ProductsExportService);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup(tenantId).catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  async function cleanup(tenantId: string) {
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.invoiceItem.deleteMany({ where: { invoice: { tenantId } } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.tenantConfig.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string) {
    seq += 1;
    const slug = assertTestTenant(`qa-csv-${RUN}-${seq}-${label}`, "products-export.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `CSV QA ${slug}` } });
    tenantIds.push(tenant.id);
    await prisma.tenantConfig.create({ data: { tenantId: tenant.id, timezone: "UTC" } });
    const base = `${tenant.id.slice(0, 8)}-${randomUUID().slice(0, 6)}`;
    const user = await prisma.user.create({
      data: {
        email: `${base}@example.invalid`,
        username: base,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "Acme Retail",
        contactName: "Contact",
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, customerId: customer.id };
  }

  const seedProduct = (tenantId: string, name: string) =>
    prisma.product.create({
      data: {
        tenantId,
        name,
        sku: `SKU-${randomUUID().slice(0, 6)}`,
        unit: "each",
        pricePerUnit: 3,
      },
    });

  let invSeq = 0;
  async function seedSale(
    t: { tenantId: string; customerId: string },
    productId: string,
    o: { status: "SENT" | "PAID" | "DRAFT" | "VOID"; day: string; qty: number; subtotal: number },
  ) {
    invSeq += 1;
    const inv = await prisma.invoice.create({
      data: {
        tenantId: t.tenantId,
        customerId: t.customerId,
        invoiceNumber: `INV-CSV-${RUN}-${invSeq}`,
        status: o.status,
        issueDate: stamp(o.day),
        subtotal: o.subtotal,
        total: o.subtotal,
      },
    });
    await prisma.invoiceItem.create({
      data: {
        invoiceId: inv.id,
        tenantId: t.tenantId,
        productId,
        description: "line",
        qty: o.qty,
        unitPrice: o.subtotal / o.qty,
        subtotal: o.subtotal,
      },
    });
  }

  async function exportAs(tenantId: string, query: Record<string, unknown>) {
    return tenantCtx.run(tenantId, async () => {
      const { csv } = await exporter.prepare(query as any, { userId: null });
      let out = "";
      for await (const c of csv) out += c;
      return out;
    });
  }

  it("stats use accrual invoices only, in-window, tenant-scoped; batches page by id; one audit row", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    const pa = await seedProduct(a.tenantId, "Cola");
    await seedProduct(a.tenantId, "Chips");
    await seedProduct(a.tenantId, "Gum");
    const pb = await seedProduct(b.tenantId, "Other Tenant Item");
    await seedSale(a, pa.id, { status: "SENT", day: "2026-09-10", qty: 2, subtotal: 20 });
    await seedSale(a, pa.id, { status: "PAID", day: "2026-09-12", qty: 1, subtotal: 10 });
    await seedSale(a, pa.id, { status: "DRAFT", day: "2026-09-13", qty: 100, subtotal: 1000 });
    await seedSale(a, pa.id, { status: "VOID", day: "2026-09-14", qty: 50, subtotal: 500 });
    await seedSale(a, pa.id, { status: "SENT", day: "2026-08-01", qty: 9, subtotal: 90 });
    await seedSale(b, pb.id, { status: "SENT", day: "2026-09-10", qty: 7, subtotal: 70 });

    const out = await exportAs(a.tenantId, { from: "2026-09-01", to: "2026-09-29" });
    const rows = out.split("\r\n").filter(Boolean);
    expect(rows).toHaveLength(1 + 3);
    expect(out).not.toContain("Other Tenant Item");
    const cola = rows.find((r) => r.startsWith("Cola,"))!;
    expect(cola.endsWith(",3,30,2026-09-12")).toBe(true);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: a.tenantId, action: "PRODUCTS_EXPORT_CSV" },
    });
    expect(audits).toHaveLength(1);
    expect((audits[0].meta as any).rowCount).toBe(3);
  });
});
