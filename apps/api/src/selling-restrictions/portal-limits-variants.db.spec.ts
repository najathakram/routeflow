/**
 * Portal limits (lane A), the variant opt-out on REAL Postgres: a category rule reaches a variant through its
 * parent's label (`restrictedProductIdsFor` expands the labelled parent to its variants), and an EXCLUDE row
 * pinned to that parent keeps the variant visible — while an EXCLUDE pinned to a DIFFERENT parent (a reparented
 * variant) is inert, so the variant is hidden again (fail closed). Read through the ONE buyer visibility builder
 * (`buyerVisibilityFor` + `buyerVisibleProductWhere`) against the real product table.
 *
 * Collected only by `jest.db.config.js` (`npm run local:test:db`). The tenant is a throwaway `qa-sr-variants-<run>`
 * slug approved by `assertTestTenant`; afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { buyerVisibilityFor, buyerVisibleProductWhere } from "../buyer/buyer-product-visibility";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SellingRestrictionsService } from "./selling-restrictions.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("portal limits: variant opt-out through the parent's label — real Postgres", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let service: SellingRestrictionsService;
  let tenantId: string;
  let customerId: string;
  let categoryId: string;
  const p: Record<string, string> = {};

  const as = <T>(fn: () => Promise<T>) => ctx.run(tenantId, fn);
  const visibleIds = () =>
    as(async () => {
      const where = buyerVisibleProductWhere(
        await buyerVisibilityFor(service, tenantId, customerId),
      );
      const rows = await prisma.forTenant().product.findMany({ where, select: { id: true } });
      return new Set(rows.map((r: { id: string }) => r.id));
    });
  const mkProduct = async (key: string, extra: Record<string, unknown> = {}) => {
    p[key] = (
      await prisma.product.create({
        data: {
          tenantId,
          name: `SR ${key} ${RUN}`,
          unit: "each",
          pricePerUnit: 10,
          ...extra,
        } as never,
      })
    ).id;
  };

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    service = new SellingRestrictionsService(prisma, new ProductLabelsService(prisma));

    const slug = assertTestTenant(`qa-sr-variants-${RUN}`, "portal-limits-variants.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `SR variants ${slug}` } })).id;
    const user = await prisma.user.create({
      data: {
        email: `sr-${RUN}@example.invalid`,
        username: `sr-${RUN}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    customerId = (
      await prisma.customer.create({
        data: { userId: user.id, businessName: "SR Buyer", contactName: "SR", tenantId },
      })
    ).id;
    await prisma.customerAddress.create({
      data: {
        tenantId,
        customerId,
        line1: "1 Test St",
        city: "Testville",
        state: "TX",
        stateCode: "TX",
        zip: "00000",
        isDefault: true,
        addressType: "BILLING",
      },
    });
    categoryId = (await prisma.productCategory.create({ data: { tenantId, name: "Limited" } })).id;
    await mkProduct("parent", { kind: "FAMILY" });
    await mkProduct("otherParent", { kind: "FAMILY" });
    await mkProduct("v1", { kind: "VARIANT", parentProductId: p.parent });
    await mkProduct("v2", { kind: "VARIANT", parentProductId: p.parent });
    await mkProduct("solo");
    await prisma.productCategoryLabel.create({
      data: { tenantId, productId: p.parent, categoryId, mode: "INCLUDE" },
    });
    await prisma.sellingRestriction.create({
      data: {
        tenantId,
        categoryId,
        jurisdiction: "STATE",
        states: ["TX"],
        surface: "BUYER_PORTAL",
        reason: "Portal limit",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      await prisma.sellingRestriction.deleteMany({ where: { tenantId } });
      await prisma.productCategoryLabel.deleteMany({ where: { tenantId } });
      await prisma.customerAddress.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
      await prisma.product.deleteMany({ where: { tenantId } });
      await prisma.productCategory.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
  }, 120_000);

  it("a labelled parent's variants are hidden, the unlabelled standalone product stays", async () => {
    const visible = await visibleIds();
    expect(visible.has(p.v1)).toBe(false);
    expect(visible.has(p.v2)).toBe(false);
    expect(visible.has(p.solo)).toBe(true);
  });

  it("an EXCLUDE pinned to the variant's current parent opts that variant out of the label", async () => {
    await prisma.productCategoryLabel.create({
      data: {
        tenantId,
        productId: p.v2,
        categoryId,
        mode: "EXCLUDE",
        parentProductIdAtWrite: p.parent,
      },
    });
    const visible = await visibleIds();
    expect(visible.has(p.v2)).toBe(true);
    expect(visible.has(p.v1)).toBe(false);
  });

  it("an EXCLUDE pinned to a DIFFERENT parent is inert: the variant is hidden again", async () => {
    await prisma.productCategoryLabel.update({
      where: { productId_categoryId: { productId: p.v2, categoryId } },
      data: { parentProductIdAtWrite: p.otherParent },
    });
    expect((await visibleIds()).has(p.v2)).toBe(false);
  });
});
