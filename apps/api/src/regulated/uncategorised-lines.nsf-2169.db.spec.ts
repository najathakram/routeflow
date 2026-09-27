/**
 * #2169 (SA-395) — NEED-DB, NOT executed here (project rule: "Builders post NEED-DB first — never
 * run DB specs on the compose stack; the prover owns it"). Proves the shared `notNsfLineWhere`
 * Prisma fragment (invoices/nsf-line.ts) against REAL Postgres, one branch at a time, since the
 * unit spec (uncategorised-lines.spec.ts) only pins the generated `where` OBJECT — it cannot
 * prove Postgres actually evaluates the Prisma null trap the way nsf-line.ts's header claims
 * (`NOT { systemKind: "NSF_FEE" }` also excludes NULL rows). Follows the tenant-setup/cleanup
 * pattern of `uncategorised-lines.db.spec.ts` / `import-commercial-columns.db.spec.ts`: a bare
 * throwaway `qa-2169-<run>` tenant, `assertTestTenant` first, child-first cleanup guarded behind
 * a `tenantId` we actually set.
 *
 * One CA customer, one issued invoice per branch, each with exactly one productless line:
 *   - stamped:          systemKind NSF_FEE, WITH the prefix description (the writer's REAL
 *     shape — InvoicesService.setCheckStatus's BOUNCED branch stamps systemKind AND keeps the
 *     description prefix, it never drops one for the other) -> EXCLUDED
 *   - stampedNonPrefix: systemKind NSF_FEE, non-prefix description (the stamp wins over the
 *     description text; a hypothetical/defensive shape, not what the writer produces) -> EXCLUDED
 *   - nullPrefix:       systemKind NULL, prefix description (pre-backfill shape) -> EXCLUDED
 *   - nullNoPrefix:     systemKind NULL, ordinary description       -> INCLUDED
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { NSF_FEE_DESCRIPTION_PREFIX } from "../sales-agents/commission-math";
import { uncategorisedLineWarnings } from "./uncategorised-lines";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("#2169 uncategorised-lines — real-Postgres NSF dual-read filter (SA-395)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let tenantId = "";
  const RUN = randomUUID().slice(0, 8);
  const range = {
    from: new Date("2026-09-01T00:00:00Z"),
    toExclusive: new Date("2026-10-01T00:00:00Z"),
  };
  const ids: {
    stamped?: string;
    stampedNonPrefix?: string;
    nullPrefix?: string;
    nullNoPrefix?: string;
  } = {};

  async function customerCA(tag: string) {
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
        state: "CA",
        stateCode: "CA",
        zip: "00000",
        isDefault: true,
        addressType: "BILLING",
      },
    });
    return customer.id;
  }

  async function invoiceWithLine(
    customerId: string,
    tag: string,
    description: string,
    systemKind: "NSF_FEE" | null,
  ) {
    const inv = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-2169-${RUN}-${tag}`,
        status: "SENT" as never,
        issueDate: new Date("2026-09-15T12:00:00Z"),
        dueDate: new Date("2026-10-15T12:00:00Z"),
        subtotal: 10,
        total: 10,
        items: {
          create: [
            {
              tenantId,
              description,
              qty: 1,
              unitPrice: 10,
              subtotal: 10,
              productId: null,
              systemKind: systemKind as never,
            },
          ],
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
    const slug = assertTestTenant(`qa-2169-${RUN}`, "uncategorised-lines.nsf-2169.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `2169 ${slug}` } })).id;
    const category = await prisma.productCategory.create({
      data: { tenantId, name: "Restricted" },
    });
    await prisma.sellingRestriction.create({
      data: {
        tenantId,
        categoryId: category.id,
        jurisdiction: "STATE",
        states: ["CA"],
        reason: "#2169 pin",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const ca = await customerCA("ca");

    // stamped + PREFIX ⇒ excluded — the writer's real shape (setCheckStatus stamps systemKind
    // AND keeps the description prefix; the two legs are never mutually exclusive in practice).
    ids.stamped = await invoiceWithLine(
      ca,
      "stamped",
      `${NSF_FEE_DESCRIPTION_PREFIX} PAY-1`,
      "NSF_FEE",
    );
    // stamped + non-prefix description ⇒ excluded (the stamp alone is sufficient).
    ids.stampedNonPrefix = await invoiceWithLine(
      ca,
      "stampednonprefix",
      "Bounce handling",
      "NSF_FEE",
    );
    // NULL + prefix (pre-backfill shape) ⇒ excluded.
    ids.nullPrefix = await invoiceWithLine(
      ca,
      "nullprefix",
      `${NSF_FEE_DESCRIPTION_PREFIX} PAY-2`,
      null,
    );
    // NULL + no prefix ⇒ included (a genuine custom line).
    ids.nullNoPrefix = await invoiceWithLine(ca, "nullnoprefix", "Custom freight", null);
  });

  afterAll(async () => {
    if (tenantId) {
      for (const del of [
        () => prisma.sellingRestriction.deleteMany({ where: { tenantId } }),
        () => prisma.invoiceItem.deleteMany({ where: { tenantId } }),
        () => prisma.invoice.deleteMany({ where: { tenantId } }),
        () => prisma.customerAddress.deleteMany({ where: { tenantId } }),
        () => prisma.customer.deleteMany({ where: { tenantId } }),
        () => prisma.productCategory.deleteMany({ where: { tenantId } }),
        () => prisma.user.deleteMany({ where: { tenantId } }),
        () => prisma.tenant.delete({ where: { id: tenantId } }),
      ])
        await del().catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  const on = { enabled: true, addressPrecedence: "BILLING_FIRST" as const };

  it("real Postgres: stamped+prefix, stamped+non-prefix, and NULL+prefix lines are all excluded; only the NULL+no-prefix custom line is listed", async () => {
    const warnings = await tenantCtx.run(tenantId, () =>
      uncategorisedLineWarnings(prisma.forTenant() as never, on, range),
    );
    expect(warnings.map((w) => w.invoiceId)).toEqual([ids.nullNoPrefix]);
  });
});
