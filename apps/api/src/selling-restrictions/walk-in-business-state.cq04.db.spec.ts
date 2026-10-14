/**
 * CQ-04 — real-Postgres proof for the system walk-in in the selling-restrictions engine. What a mocked prisma
 * cannot prove: the `isWalkIn` select/branch in `evaluate()` and `businessStateMissing`'s rule read really run against
 * the schema. (Row 510 removed the enable-readiness sweep and the tenant switch; the walk-in exclusion of the
 * unknown-state sweep is pinned in restrictions-settings/unknown-state-customers.spec.ts.)
 *
 *   (b) a counter sale to the walk-in is judged by the TENANT's business state: an allowed state sells, a
 *       prohibited one is BLOCKed (409 SELLING_RESTRICTED with the rule's reason), no state is INDETERMINATE and the
 *       business state is reported missing; a named customer keeps their own address; a lookalike gets no tenant state.
 *
 * Collected only by `jest.db.config.js`; run via `npm run local:test:db`. The tenant is a throwaway `qa-cq04-<run>`
 * slug approved by `assertTestTenant`; afterAll deletes exactly what it made.
 */
import { ConflictException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SellingRestrictionsService } from "./selling-restrictions.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const RULE_REASON = "CQ04 state ban";

describeDb(
  "CQ-04 system walk-in: state resolution and the business-state requirement — real Postgres",
  () => {
    let prisma: PrismaService;
    let ctx: TenantContextService;
    let service: SellingRestrictionsService;
    let tenantId: string;
    let productId: string;
    let ruleId: string;
    let categoryId: string;
    const ids: Record<string, string> = {};

    const as = <T>(fn: () => Promise<T>) => ctx.run(tenantId, fn);
    const setBusinessState = async (state: string | null) => {
      await prisma.tenantConfig.deleteMany({ where: { tenantId } });
      if (state !== null) await prisma.tenantConfig.create({ data: { tenantId, state } });
    };
    const lines = () => [{ productId, qtyDelta: 1 }];
    const check = (customerId: string) =>
      as(() =>
        service.checkLinesSellable({ tenantId, customerId, lines: lines(), channel: "STAFF" }),
      );

    async function mkCustomer(
      key: string,
      over: { businessName: string; isWalkIn?: boolean | null; state?: string },
    ) {
      const handle = `cq04-${RUN}-${key}`;
      const user = await prisma.user.create({
        data: { email: `${handle}@example.invalid`, username: handle, role: "CUSTOMER", tenantId },
      });
      const customer = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: over.businessName,
          contactName: "CQ04",
          tenantId,
          ...(over.isWalkIn === undefined ? {} : { isWalkIn: over.isWalkIn }),
        },
      });
      if (over.state) {
        await prisma.customerAddress.create({
          data: {
            tenantId,
            customerId: customer.id,
            line1: "1 Test St",
            city: "Testville",
            state: over.state,
            stateCode: over.state,
            zip: "00000",
            isDefault: true,
            addressType: "BILLING",
          },
        });
      }
      ids[key] = customer.id;
      return customer.id;
    }

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      ctx = new TenantContextService();
      prisma = new PrismaService(ctx);
      await prisma.$connect();
      service = new SellingRestrictionsService(prisma, new ProductLabelsService(prisma));

      const slug = assertTestTenant(`qa-cq04-${RUN}`, "walk-in-business-state.cq04.db.spec.ts");
      tenantId = (await prisma.tenant.create({ data: { slug, name: `CQ04 ${slug}` } })).id;
      const category = await prisma.productCategory.create({
        data: { tenantId, name: "Restricted" },
      });
      productId = (
        await prisma.product.create({
          data: { tenantId, name: "CQ04 item", unit: "each", pricePerUnit: 10 },
        })
      ).id;
      await prisma.productCategoryLabel.create({
        data: { tenantId, productId, categoryId: category.id, mode: "INCLUDE" },
      });
      categoryId = category.id;
      ruleId = (
        await prisma.sellingRestriction.create({
          data: {
            tenantId,
            categoryId: category.id,
            jurisdiction: "STATE",
            states: ["TX"],
            reason: RULE_REASON,
            effectiveFrom: new Date("2026-01-01T00:00:00Z"),
          },
        })
      ).id;
      await mkCustomer("walkin", { businessName: "Counter walk-in", isWalkIn: true });
      await mkCustomer("real-noaddr", { businessName: "Acme Real", isWalkIn: null });
      await mkCustomer("lookalike-false", { businessName: "Walk-in", isWalkIn: false });
      await mkCustomer("lookalike-null", { businessName: "Walk-in" });
      await mkCustomer("named-fl", { businessName: "Acme Florida", isWalkIn: null, state: "FL" });
    }, 120_000);

    afterAll(async () => {
      if (tenantId) {
        await prisma.sellingRestriction.deleteMany({ where: { tenantId } });
        await prisma.productCategoryLabel.deleteMany({ where: { tenantId } });
        await prisma.systemConfig.deleteMany({ where: { tenantId } });
        await prisma.tenantConfig.deleteMany({ where: { tenantId } });
        await prisma.customerAddress.deleteMany({ where: { tenantId } });
        await prisma.customer.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.productCategory.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      }
      await prisma?.$disconnect();
    }, 120_000);

    it("(b) walk-in, tenant state NOT named by the rule (FL): sold", async () => {
      await setBusinessState("FL");
      expect((await check(ids["walkin"])).outcome).toBe("ALLOW");
    });

    it("(b) walk-in, tenant state PROHIBITED (TX): BLOCK, and assertLinesSellable is a 409 SELLING_RESTRICTED with the rule's reason", async () => {
      await setBusinessState("TX");
      const res = await check(ids["walkin"]);
      expect(res.outcome).toBe("BLOCK");
      expect(res.reasons[0]).toMatchObject({ reason: "STATE_BAN", state: "TX" });
      expect(res.reasons[0].message).toContain(RULE_REASON);

      const err = await as(() =>
        service.assertLinesSellable({
          tenantId,
          customerId: ids["walkin"],
          lines: lines(),
          channel: "STAFF",
        }),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        code: "SELLING_RESTRICTED",
        blockedLines: [{ reason: "STATE_BAN", state: "TX" }],
      });
      expect(err.getResponse().blockedLines[0].message).toContain(RULE_REASON);
    });

    it("(b) walk-in, tenant with NO state: INDETERMINATE (unchanged), and the business state is reported missing", async () => {
      await setBusinessState(null);
      expect((await check(ids["walkin"])).outcome).toBe("INDETERMINATE");
      expect(await as(() => service.businessStateMissing(tenantId))).toBe(true);
    });

    it("(b) a named customer keeps their own address; one without an address stays INDETERMINATE", async () => {
      await setBusinessState("TX");
      expect((await check(ids["named-fl"])).outcome).toBe("ALLOW"); // own FL address, not the tenant's TX
      expect((await check(ids["real-noaddr"])).outcome).toBe("INDETERMINATE");
    });

    it("(b) a customer NAMED 'Walk-in' that is not the system customer gets no tenant state", async () => {
      await setBusinessState("FL"); // would be ALLOW if the tenant state applied
      expect((await check(ids["lookalike-false"])).outcome).toBe("INDETERMINATE");
    });

    describe("a business state is required ONLY when an active STATE rule exists (no state set)", () => {
      const PAST = new Date("2026-02-01T00:00:00Z");
      const missing = () => as(() => service.businessStateMissing(tenantId));
      const resetRule = () =>
        prisma.sellingRestriction.update({
          where: { id: ruleId },
          data: { liftedAt: null, effectiveTo: null },
        });

      beforeEach(async () => {
        await setBusinessState(null);
        await resetRule();
      });
      afterAll(async () => {
        await resetRule();
      });

      it("an active STATE rule + no business state: businessStateMissing", async () => {
        expect(await missing()).toBe(true);
      });

      it("the only STATE rule is LIFTED: not required, nothing needs a state", async () => {
        await prisma.sellingRestriction.update({ where: { id: ruleId }, data: { liftedAt: PAST } });
        expect(await missing()).toBe(false);
      });

      it("the only STATE rule has EXPIRED: not required", async () => {
        await prisma.sellingRestriction.update({
          where: { id: ruleId },
          data: { effectiveTo: PAST },
        });
        expect(await missing()).toBe(false);
      });

      it("only a FEDERAL rule (and a lifted STATE one): not required", async () => {
        await prisma.sellingRestriction.update({ where: { id: ruleId }, data: { liftedAt: PAST } });
        const federal = await prisma.sellingRestriction.create({
          data: {
            tenantId,
            categoryId,
            jurisdiction: "FEDERAL",
            states: [],
            reason: "CQ04 federal",
            effectiveFrom: new Date("2026-01-01T00:00:00Z"),
          },
        });
        try {
          expect(await missing()).toBe(false);
        } finally {
          await prisma.sellingRestriction.delete({ where: { id: federal.id } });
        }
      });

      it("no rules at all: not required", async () => {
        const saved = await prisma.sellingRestriction.findUniqueOrThrow({ where: { id: ruleId } });
        await prisma.sellingRestriction.delete({ where: { id: ruleId } });
        try {
          expect(await missing()).toBe(false);
        } finally {
          const { id: _drop, ...data } = saved;
          void _drop;
          ruleId = (await prisma.sellingRestriction.create({ data: data as never })).id;
        }
      });

      it("an active STATE rule + a business state: required and present, the walk-in sale decides", async () => {
        await setBusinessState("TX");
        expect(await missing()).toBe(false);
        expect((await check(ids["walkin"])).outcome).toBe("BLOCK");
      });
    });
  },
);
