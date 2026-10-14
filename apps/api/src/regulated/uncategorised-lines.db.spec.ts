/**
 * F-05 (#2093) — executed proof for the "uncategorised lines" report row: the nested Prisma select
 * (invoiceItem -> invoice -> customer -> addresses) and the rule read run against REAL Postgres, since a mocked
 * client accepts a relation that does not exist. A CA customer with a productless line on an issued invoice is
 * listed under an active CA rule; an NY customer, a DRAFT invoice and a catalog line are not. Collected only by
 * `jest.db.config.js`; every tenant is a throwaway `qa-*` slug and afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { NSF_FEE_DESCRIPTION_PREFIX } from "../sales-agents/commission-math";
import { uncategorisedLineWarnings } from "./uncategorised-lines";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("F05 uncategorised-lines report row — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let tenantId = "";
  const RUN = randomUUID().slice(0, 8);
  const range = {
    from: new Date("2026-09-01T00:00:00Z"),
    toExclusive: new Date("2026-10-01T00:00:00Z"),
  };
  const ids: {
    ca?: string;
    ny?: string;
    caDraft?: string;
    caCatalog?: string;
    caNsf?: string;
    caMixed?: string;
  } = {};

  async function customerIn(state: string, tag: string) {
    const user = await prisma.user.create({
      data: {
        email: `${tenantId}-${tag}@example.invalid`,
        username: `${tenantId}-${tag}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `Cust ${tag}`, contactName: tag, tenantId },
    });
    await prisma.customerAddress.create({
      data: {
        tenantId,
        customerId: customer.id,
        line1: "1 Test St",
        city: "Testville",
        state,
        stateCode: state,
        zip: "00000",
        isDefault: true,
        addressType: "BILLING",
      },
    });
    return customer.id;
  }

  async function invoice(
    customerId: string,
    tag: string,
    status: string,
    productId: string | null,
    description = "line",
  ) {
    const inv = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-F05-${RUN}-${tag}`,
        status: status as never,
        issueDate: new Date("2026-09-15T12:00:00Z"),
        dueDate: new Date("2026-10-15T12:00:00Z"),
        subtotal: 10,
        total: 10,
        items: {
          create: [{ tenantId, description, qty: 1, unitPrice: 10, subtotal: 10, productId }],
        },
      },
    });
    return inv.id;
  }

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const slug = assertTestTenant(`qa-f05uncat-${RUN}`, "uncategorised-lines.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `F05 ${slug}` } })).id;
    const category = await prisma.productCategory.create({
      data: { tenantId, name: "Restricted" },
    });
    await prisma.sellingRestriction.create({
      data: {
        tenantId,
        categoryId: category.id,
        jurisdiction: "STATE",
        states: ["CA"],
        reason: "F05 pin",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const product = await prisma.product.create({
      data: { tenantId, name: "F05 catalog", unit: "each", pricePerUnit: 10 },
    });
    const ca = await customerIn("CA", "ca");
    const ny = await customerIn("NY", "ny");
    ids.ca = await invoice(ca, "ca", "SENT", null);
    ids.ny = await invoice(ny, "ny", "SENT", null);
    ids.caDraft = await invoice(ca, "cadraft", "DRAFT", null);
    ids.caCatalog = await invoice(ca, "cacat", "SENT", product.id);
    // the system NSF fee line (productless, prefix match) is NOT a custom line to review
    ids.caNsf = await invoice(ca, "cansf", "SENT", null, `${NSF_FEE_DESCRIPTION_PREFIX} PAY-1`);
    // a REAL product line carrying the NSF description is never excluded from anything: this invoice also has
    // a genuine custom line, so it is still listed
    ids.caMixed = await invoice(
      ca,
      "camixed",
      "SENT",
      product.id,
      `${NSF_FEE_DESCRIPTION_PREFIX} PAY-2`,
    );
    await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: ids.caMixed,
        description: "Custom freight",
        qty: 1,
        unitPrice: 5,
        subtotal: 5,
        productId: null,
      },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const del of [
        () => prisma.sellingRestriction.deleteMany({ where: { tenantId } }),
        () => prisma.invoiceItem.deleteMany({ where: { tenantId } }),
        () => prisma.invoice.deleteMany({ where: { tenantId } }),
        () => prisma.customerAddress.deleteMany({ where: { tenantId } }),
        () => prisma.customer.deleteMany({ where: { tenantId } }),
        () => prisma.product.deleteMany({ where: { tenantId } }),
        () => prisma.productCategory.deleteMany({ where: { tenantId } }),
        () => prisma.user.deleteMany({ where: { tenantId } }),
        () => prisma.tenant.delete({ where: { id: tenantId } }),
      ])
        await del().catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  const on = { addressPrecedence: "BILLING_FIRST" as const };

  it("lists only the CA customer's custom (productless, non-NSF) lines on ISSUED invoices", async () => {
    const warnings = await tenantCtx.run(tenantId, () =>
      uncategorisedLineWarnings(prisma.forTenant() as never, on, range),
    );
    expect(warnings.map((w) => w.invoiceId).sort()).toEqual([ids.ca, ids.caMixed].sort());
    expect(warnings[0]).toMatchObject({
      code: "UNCATEGORISED_LINE_IN_RULE_STATE",
      customerName: "Cust ca",
    });
  });

  it("needs no tenant switch (row 510): a stored selling_restrictions.enabled=false row changes nothing", async () => {
    await prisma.systemConfig.create({
      data: { tenantId, key: "selling_restrictions.enabled", value: "false" },
    });
    try {
      const warnings = await tenantCtx.run(tenantId, () =>
        uncategorisedLineWarnings(prisma.forTenant() as never, on, range),
      );
      expect(warnings.map((w) => w.invoiceId).sort()).toEqual([ids.ca, ids.caMixed].sort());
    } finally {
      await prisma.systemConfig.deleteMany({
        where: { tenantId, key: "selling_restrictions.enabled" },
      });
    }
  });

  it("judged as of the invoice's issue date: a rule lifted AFTER the invoice still flags it; lifted BEFORE does not", async () => {
    const rule = await prisma.sellingRestriction.findFirst({ where: { tenantId } });
    await prisma.sellingRestriction.update({
      where: { id: rule!.id },
      data: { liftedAt: new Date("2026-10-01T00:00:00Z") },
    });
    const after = await tenantCtx.run(tenantId, () =>
      uncategorisedLineWarnings(prisma.forTenant() as never, on, range),
    );
    expect(after.map((w) => w.invoiceId).sort()).toEqual([ids.ca, ids.caMixed].sort());
    await prisma.sellingRestriction.update({
      where: { id: rule!.id },
      data: { liftedAt: new Date("2026-09-10T00:00:00Z") },
    });
    const before = await tenantCtx.run(tenantId, () =>
      uncategorisedLineWarnings(prisma.forTenant() as never, on, range),
    );
    expect(before).toEqual([]); // the CA invoice was issued 2026-09-15, after the lift
  });
});
