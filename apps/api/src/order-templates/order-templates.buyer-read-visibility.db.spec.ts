/**
 * Row 479 — real-Postgres proof that a BUYER's template read never returns a line for a product the buyer catalog
 * hides from them. The rule is the catalog's own (`isBuyerVisibleProduct` over `buyerVisibilityFor`), here driven through
 * the REAL SellingRestrictionsService, so a hiding rule, a portal-hidden product, an inactive one, a FAMILY and a
 * variant under a hidden parent are all judged against real rows. The hidden line is DROPPED: its name appears nowhere in
 * the JSON of the list or the single read, nor in the buyer-portal list. Staff reads still show every line.
 *
 * Real: PrismaService, OrderTemplatesService reads, SellingRestrictionsService + ProductLabelsService. Stubbed (never
 * reached by a read): the OrdersService collaborator and the notification/auth/config providers.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). One throwaway `qa-r479-<run>` tenant approved by
 * `assertTestTenant`; afterAll deletes exactly the rows this run created.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient, UserRole } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { RegulatedVisibilityService } from "../buyer/regulated-visibility.service";
import { NotFoundException } from "@nestjs/common";
import { OrderTemplatesService } from "./order-templates.service";
import type { OrdersService } from "../orders/orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("buyer template reads drop lines the catalog hides (row 479)", () => {
  let pool: Pool;
  let raw: PrismaClient; // superuser fixture client, deliberately unscoped
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let templates: OrderTemplatesService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-r479-${run}`, "order-templates.buyer-visibility.db.spec.ts");
  let tenantId = "";
  let customerId = "";
  let buyer: JwtPayload;
  let operator: JwtPayload;
  let templateId = "";
  let categoryId = "";
  /** name -> product id, for every product on the template */
  const ids: Record<string, string> = {};
  const nameOf = (key: string) => `${key}-${run}`;
  const HIDDEN = ["portal", "restricted", "inactive", "family", "variantOfHidden", "regulated"];
  const VISIBLE = ["visibleA", "visibleB"];

  const asTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn) as Promise<T>;
  const user = (sub: string, role: UserRole): JwtPayload =>
    ({
      sub,
      username: sub,
      role,
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    tenantId = (await raw.tenant.create({ data: { slug, name: `R479 ${slug}` } })).id;
    const opUser = await raw.user.create({
      data: { email: `op-${run}@example.test`, username: `op-${run}`, role: "OPERATOR", tenantId },
    });
    const buyerUser = await raw.user.create({
      data: {
        email: `buyer-${run}@example.test`,
        username: `buyer-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    customerId = (
      await raw.customer.create({
        data: {
          userId: buyerUser.id,
          businessName: `Cust ${run}`,
          contactName: "R479",
          tenantId,
        },
      })
    ).id;
    operator = user(opUser.id, UserRole.OPERATOR);
    buyer = user(buyerUser.id, UserRole.CUSTOMER);

    const mk = async (key: string, over: Record<string, unknown> = {}) => {
      ids[key] = (
        await raw.product.create({
          data: { tenantId, name: nameOf(key), unit: "each", pricePerUnit: 10, ...over },
        })
      ).id;
    };
    await mk("visibleA");
    await mk("visibleB");
    await mk("portal", { portalVisible: false });
    await mk("restricted");
    await mk("inactive", { isActive: false });
    await mk("family", { kind: "FAMILY" });
    // A licence-required category the buyer has NO verified authorization for: the catalog hides its products.
    categoryId = (
      await raw.trackedCategory.create({
        data: { tenantId, name: `Regulated ${run}`, requiresLicense: true },
      })
    ).id;
    await mk("regulated", { trackedCategoryId: categoryId });
    await mk("hiddenParent", { kind: "FAMILY", portalVisible: false }); // the parent itself is not on the template
    await mk("variantOfHidden", { parentProductId: ids.hiddenParent });
    // A hiding rule the buyer's own request context resolves (federal, every surface: no address needed).
    await raw.sellingRestriction.create({
      data: {
        tenantId,
        productId: ids.restricted,
        jurisdiction: "FEDERAL",
        states: [],
        surface: "ALL",
        reason: "R479 test rule",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });

    templateId = (
      await raw.orderTemplate.create({
        data: {
          tenantId,
          customerId,
          name: `Weekly ${run}`,
          daysOfWeek: [1, 2, 3, 4, 5],
          createdByRole: UserRole.CUSTOMER,
          itemsEditedByRole: UserRole.CUSTOMER,
          items: {
            create: [...VISIBLE, ...HIDDEN].map((k) => ({
              tenantId,
              productId: ids[k],
              qty: 2,
            })),
          },
        },
      })
    ).id;

    templates = new OrderTemplatesService(
      prisma,
      tenantCtx,
      {} as OrdersService,
      {} as never,
      {} as never,
      {} as never,
      new SellingRestrictionsService(prisma, new ProductLabelsService(prisma)),
      { read: async () => "off" } as never,
      new RegulatedVisibilityService(prisma),
    );
  });

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    const where = { where: { tenantId } };
    await raw.orderTemplateItem.deleteMany(where).catch(swallow);
    await raw.orderTemplate.deleteMany(where).catch(swallow);
    await raw.sellingRestriction.deleteMany(where).catch(swallow);
    await raw.customerAuthorization.deleteMany(where).catch(swallow);
    await raw.product
      .deleteMany({ where: { tenantId, parentProductId: { not: null } } })
      .catch(swallow);
    await raw.product.deleteMany(where).catch(swallow);
    await raw.trackedCategory.deleteMany(where).catch(swallow);
    await raw.customer.deleteMany(where).catch(swallow);
    await raw.user.deleteMany(where).catch(swallow);
    await raw.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  });

  const expectNoHiddenName = (json: string) => {
    for (const k of HIDDEN) expect(json).not.toContain(nameOf(k));
  };

  it("GET /order-templates as the CUSTOMER: only the visible lines, no hidden product name anywhere in the JSON", async () => {
    const res = await asTenant(() => templates.findAllForUser(buyer));
    expect(res.data).toHaveLength(1);
    expect(res.data[0].items.map((i) => i.productId).sort()).toEqual(
      VISIBLE.map((k) => ids[k]).sort(),
    );
    const json = JSON.stringify(res);
    expectNoHiddenName(json);
    for (const k of VISIBLE) expect(json).toContain(nameOf(k));
  });

  it("GET /order-templates/:id as the CUSTOMER: the same, for the single read", async () => {
    const res = await asTenant(() => templates.findOneForUser(templateId, buyer));
    expect(res.items.map((i) => i.productId).sort()).toEqual(VISIBLE.map((k) => ids[k]).sort());
    expectNoHiddenName(JSON.stringify(res));
  });

  it("the buyer-portal list (findAllForBuyer, by customerId) filters identically", async () => {
    const res = await asTenant(() => templates.findAllForBuyer(customerId));
    expect(res.data[0].items).toHaveLength(VISIBLE.length);
    expectNoHiddenName(JSON.stringify(res));
  });

  it("STAFF reads are unchanged: the OPERATOR sees every line, hidden names included", async () => {
    const list = await asTenant(() => templates.findAllForUser(operator, customerId));
    expect(list.data[0].items).toHaveLength(VISIBLE.length + HIDDEN.length);
    const one = await asTenant(() => templates.findOneForUser(templateId, operator));
    expect(one.items).toHaveLength(VISIBLE.length + HIDDEN.length);
    const json = JSON.stringify(one);
    for (const k of HIDDEN) expect(json).toContain(nameOf(k));
  });

  it("a product that becomes hidden AFTER the template was built drops out on the next read; unhiding brings it back", async () => {
    await raw.product.update({ where: { id: ids.visibleB }, data: { portalVisible: false } });
    try {
      const hidden = await asTenant(() => templates.findOneForUser(templateId, buyer));
      expect(JSON.stringify(hidden)).not.toContain(nameOf("visibleB"));
      expect(hidden.items).toHaveLength(VISIBLE.length - 1);
    } finally {
      await raw.product.update({ where: { id: ids.visibleB }, data: { portalVisible: true } });
    }
    const back = await asTenant(() => templates.findOneForUser(templateId, buyer));
    expect(JSON.stringify(back)).toContain(nameOf("visibleB"));
  });

  it("MUST 2: a VERIFIED authorization for the category brings the regulated line back; expiry drops it again", async () => {
    const auth = await raw.customerAuthorization.create({
      data: {
        tenantId,
        customerId,
        trackedCategoryId: categoryId,
        status: "VERIFIED",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    try {
      const licensed = await asTenant(() => templates.findOneForUser(templateId, buyer));
      expect(JSON.stringify(licensed)).toContain(nameOf("regulated"));
      await raw.customerAuthorization.update({
        where: { id: auth.id },
        data: { expiresAt: new Date(Date.now() - 86_400_000) },
      });
      const expired = await asTenant(() => templates.findOneForUser(templateId, buyer));
      expect(JSON.stringify(expired)).not.toContain(nameOf("regulated"));
    } finally {
      await raw.customerAuthorization.delete({ where: { id: auth.id } });
    }
  });

  describe("buyer WRITES: a hidden product is the same 404 as an unknown id", () => {
    const wire = async (p: Promise<unknown>) => {
      const err: any = await p.then(
        () => {
          throw new Error("expected a rejection");
        },
        (e) => e,
      );
      expect(err).toBeInstanceOf(NotFoundException);
      return JSON.stringify({ status: err.getStatus(), body: err.getResponse() });
    };
    const itemCount = () => raw.orderTemplateItem.count({ where: { templateId } });
    const items = (productId: string) => [{ productId, qty: 1 }];

    it("create / update / addItem refuse every hiding cause byte-identically to an unknown id, and store nothing", async () => {
      const before = await itemCount();
      const templatesBefore = await raw.orderTemplate.count({ where: { tenantId } });
      const unknownId = randomUUID();
      const attempts = (productId: string) => [
        asTenant(() =>
          templates.createForUser(
            { name: "New", daysOfWeek: [1], items: items(productId) } as never,
            buyer,
          ),
        ),
        asTenant(() =>
          templates.updateForUser(templateId, { items: items(productId) } as never, buyer),
        ),
        asTenant(() => templates.addItemForUser(templateId, { productId, qty: 1 } as never, buyer)),
      ];
      const expected = await Promise.all(attempts(unknownId).map(wire));
      expect(new Set(expected).size).toBe(1);
      for (const k of HIDDEN) {
        const got = await Promise.all(attempts(ids[k]).map(wire));
        expect(got).toEqual(expected); // same status and body, whichever cause hides the product
        expect(got.join()).not.toContain(nameOf(k));
      }
      expect(await itemCount()).toBe(before);
      expect(await raw.orderTemplate.count({ where: { tenantId } })).toBe(templatesBefore);
    });

    it("a visible product is still accepted (control), and staff may list a hidden one", async () => {
      const created = await asTenant(() =>
        templates.createForUser(
          { name: "Ok", daysOfWeek: [1], items: items(ids.visibleA) } as never,
          buyer,
        ),
      );
      expect(JSON.stringify(created)).toContain(nameOf("visibleA"));
      const staffCreated = await asTenant(() =>
        templates.createForUser(
          { name: "Staff", customerId, daysOfWeek: [1], items: items(ids.portal) } as never,
          operator,
        ),
      );
      expect(staffCreated.items).toHaveLength(1);
      await raw.orderTemplateItem.deleteMany({
        where: { templateId: { in: [(created as any).id, staffCreated.id] } },
      });
      await raw.orderTemplate.deleteMany({
        where: { id: { in: [(created as any).id, staffCreated.id] } },
      });
    });
  });
});
