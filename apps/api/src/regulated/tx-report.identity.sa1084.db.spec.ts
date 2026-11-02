/**
 * SA-1084 SI-4 on REAL Postgres: the TX filing keeps reading the stored identity values in full, through the real
 * read (`RegulatedReportService.buildReport` and `buildReportCsv`), not a hand-fed builder. The customer, tobacco
 * license and authorization license columns are left out of a plain read by the global omit, so a filing read that
 * stops naming one would quietly file blanks. This spec goes red on that.
 *
 *   X  taxpayer ID + tobacco license + a category authorization license  -> filed with the AUTHORIZATION license
 *   Y  taxpayer ID + tobacco license only                                 -> filed with the TOBACCO license
 *
 * The warnings carry no full value (SI-5), and the wholesaler permit is the category's own.
 *
 * SAFETY: one throwaway `qa-sa1084-filing-<run>` tenant (`assertTestTenant`), deleted in FK order in afterAll.
 * Collected only by `jest.db.config.js`; run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { RegulatedReportService } from "./regulated-report.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const WHOLESALER = "32012345";
const X = { taxId: "12-345678901", tobacco: "11112222", auth: "55556666" };
const Y = { taxId: "98-765432109", tobacco: "33334444" };
const digits = (v: string) => v.replace(/\D/g, "");

describeDb("SA-1084 SI-4: the TX filing reads the stored identity values in full", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: RegulatedReportService;
  let tenantId = "";
  let categoryId = "";

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    service = new RegulatedReportService(prisma, {} as never, {} as never);
    const slug = assertTestTenant(
      `qa-sa1084-filing-${RUN}`,
      "tx-report.identity.sa1084.db.spec.ts",
    );
    tenantId = (await prisma.tenant.create({ data: { slug, name: `SA1084 filing ${slug}` } })).id;
    const category = await prisma.trackedCategory.create({
      data: {
        tenantId,
        name: `SA1084 Filing ${RUN}`,
        reportTemplate: "TX_COMPTROLLER",
        wholesalerLicenseNo: WHOLESALER,
      },
    });
    categoryId = category.id;
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `P ${RUN}`,
        unit: "each",
        pricePerUnit: 10,
        unitsPerBox: 1,
        regItemType: "CIG",
        regUomUnit: "PK",
      } as never,
    });
    const soldAt = new Date("2026-10-15T15:00:00.000Z");
    for (const [tag, ids] of [
      ["x", X],
      ["y", Y],
    ] as const) {
      const user = await prisma.user.create({
        data: {
          email: `${tag}-${RUN}@example.test`,
          username: `sa1084f-${tag}-${RUN}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      const customer = await prisma.customer.create({
        data: {
          userId: user.id,
          tenantId,
          businessName: `SA1084 Retail ${tag.toUpperCase()} ${RUN}`,
          contactName: "Retail Buyer",
          taxId: ids.taxId,
          tobaccoLicenseNo: ids.tobacco,
          addresses: {
            create: {
              tenantId,
              line1: "1 Main St",
              city: "Austin",
              state: "TX",
              zip: "78701",
              isDefault: true,
            },
          },
        } as never,
      });
      if ("auth" in ids) {
        await prisma.customerAuthorization.create({
          data: {
            tenantId,
            customerId: customer.id,
            trackedCategoryId: categoryId,
            status: "VERIFIED",
            licenseNumber: ids.auth,
            expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          },
        });
      }
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderNumber: `ORD-${tag}-${RUN}`,
          subtotal: 100,
          tax: 0,
          total: 100,
          status: "DELIVERED",
        } as never,
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-${tag}-${RUN}`,
          status: "SENT",
          issueDate: soldAt,
          subtotal: 100,
          taxAmount: 0,
          discount: 0,
          total: 100,
        },
      });
      const shape = { qty: 10, unitPrice: 10, subtotal: 100, boxes: 10, pieces: 0, unitsPerBox: 1 };
      const orderItem = await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          name: product.name,
          position: 0,
          ...shape,
        } as never,
      });
      const invoiceItem = await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          orderItemId: orderItem.id,
          productId: product.id,
          description: "P",
          trackedCategoryId: categoryId,
          categoryTaxAmount: 0,
          ...shape,
        } as never,
      });
      await prisma.regulatedSalesLedger.create({
        data: {
          tenantId,
          trackedCategoryId: categoryId,
          entryType: "SALE",
          orderId: order.id,
          orderItemId: orderItem.id,
          invoiceId: invoice.id,
          invoiceItemId: invoiceItem.id,
          qty: 10,
          unitBasisQty: 10,
          netSales: 100,
          categoryTax: 0,
          soldAt,
          periodBucket: "2026-10",
          createdAt: soldAt,
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    const where = { tenantId };
    await prisma.regulatedSalesLedger.deleteMany({ where });
    await prisma.invoiceItem.deleteMany({ where });
    await prisma.invoice.deleteMany({ where });
    await prisma.orderItem.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.customerAuthorization.deleteMany({ where });
    await prisma.customerAddress.deleteMany({ where });
    await prisma.customer.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.trackedCategory.deleteMany({ where });
    await prisma.user.deleteMany({ where });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  }, 120_000);

  const params = () => ({ category: categoryId, from: "2026-10-01", to: "2026-10-31" });

  it("the CSV carries each retailer's full taxpayer ID and the license the filing prefers", async () => {
    const { csv } = await tenantCtx.run(tenantId, () => service.buildReportCsv(params()));
    const lines = csv
      .split(/\r?\n/)
      .filter((l) => l.includes(digits(X.taxId)) || l.includes(digits(Y.taxId)));
    expect(lines).toHaveLength(2);
    const xLine = lines.find((l) => l.includes(digits(X.taxId)))!;
    const yLine = lines.find((l) => l.includes(digits(Y.taxId)))!;
    // X holds an authorization license for the category: it wins over the tobacco license.
    expect(xLine).toContain(X.auth);
    expect(xLine).not.toContain(X.tobacco);
    // Y has none: the tobacco license is filed.
    expect(yLine).toContain(Y.tobacco);
    expect(csv).toContain(WHOLESALER);
    expect(csv).not.toMatch(/ending \d{4}/);
  }, 60_000);

  it("the preview rows carry the same full values and no warning is a missing-value one", async () => {
    const report = await tenantCtx.run(tenantId, () =>
      service.buildReport(params(), { reviewRows: false }),
    );
    const text = JSON.stringify(report.rows);
    for (const v of [digits(X.taxId), digits(Y.taxId), X.auth, Y.tobacco, WHOLESALER]) {
      expect(text).toContain(v);
    }
    expect(JSON.stringify(report.warnings)).not.toMatch(/not \d+ digits|missing|no taxpayer/i);
  }, 60_000);
});
