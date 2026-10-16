/**
 * Owner multi-label ruling, proven on REAL Postgres: a product carries SEVERAL labels (INCLUDE rows), its free-text
 * `Product.category` is not a label, and a rule on ANY one of its labels binds it, on every channel and through
 * variant inheritance. Pins:
 *  1-2. a rule on label A, and separately a rule on label B, each blocks P (assertLinesSellable, BUYER_PORTAL → 409);
 *  3.   a rule on label C (P does not carry it) allows P;
 *  4.   the B rule blocks P's variant V by inheritance;
 *  5.   V's EXCLUDE of B pinned to P opts V out of B only: allowed under B, still blocked under A;
 *  6.   portal: restrictedProductIdsFor ⊇ {P, V} under B, and is empty under C;
 *  7.   staff channel (switch on): BLOCK under B, and flagRestrictedLines flags P;
 *  8.   1-2 hold for a TARGET-row rule (targets.categoryIds = [label]) as well as a legacy categoryId rule;
 *  9.   removing B from P: the B rule allows P, the A rule still blocks it.
 *
 * Each case creates its own rule and deletes it after, so exactly one rule is active at a time. Rules are FEDERAL
 * with surface ALL, so they bind both channels without depending on a governing state.
 *
 * Collected only by `jest.db.config.js` (`npm run local:test:db`). The tenant is a throwaway `qa-sr-multilabel-<run>`
 * slug approved by `assertTestTenant`; afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { flagRestrictedLines } from "./restricted-lines-flag";
import { SellingRestrictionsService, SYSTEM_CONFIG_ENABLED } from "./selling-restrictions.service";
import type { RestrictionChannel } from "@routeflow/types";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const FROM = new Date("2026-01-01T00:00:00Z");

type RuleKind = "legacy" | "target";

describeDb(
  "owner multi-label ruling: a rule on any one label binds the product — real Postgres",
  () => {
    let prisma: PrismaService;
    let ctx: TenantContextService;
    let service: SellingRestrictionsService;
    let tenantId: string;
    let customerId: string;
    const p: Record<string, string> = {};
    const c: Record<string, string> = {};

    const as = <T>(fn: () => Promise<T>) => ctx.run(tenantId, fn);

    /**
     * Runs `fn` with exactly one active FEDERAL / ALL rule on `label`, then deletes it. A `target` rule keeps its
     * legacy column on the UNUSED label C (the XOR CHECK needs one) and covers `label` through a target row only, so
     * a pass proves the target row decides, never the legacy column.
     */
    const withRule = async (kind: RuleKind, label: string, fn: () => Promise<void>) => {
      const rule = await prisma.sellingRestriction.create({
        data: {
          tenantId,
          categoryId: kind === "legacy" ? c[label] : c.C,
          jurisdiction: "FEDERAL",
          states: [],
          surface: "ALL",
          reason: `ML ${kind} ${label} ${RUN}`,
          effectiveFrom: FROM,
        },
      });
      if (kind === "target") {
        await prisma.sellingRestrictionTarget.create({
          data: { tenantId, ruleId: rule.id, categoryId: c[label], addedAt: FROM },
        });
      }
      try {
        await fn();
      } finally {
        await prisma.sellingRestrictionTarget.deleteMany({ where: { tenantId, ruleId: rule.id } });
        await prisma.sellingRestriction.delete({ where: { id: rule.id } });
      }
    };

    /** The 409 code `assertLinesSellable` throws for `key`, or null when the line is sellable. */
    const refusal = (key: string, channel: RestrictionChannel = "BUYER_PORTAL") =>
      as(async () => {
        try {
          await service.assertLinesSellable({
            tenantId,
            customerId,
            lines: [{ productId: p[key] }],
            channel,
            fulfilmentKind: "DELIVERY",
          });
          return null;
        } catch (e) {
          if (!(e instanceof ConflictException)) throw e;
          return (e.getResponse() as { code: string }).code;
        }
      });
    const staffOutcome = (key: string) =>
      as(
        async () =>
          (
            await service.checkLinesSellable({
              tenantId,
              customerId,
              lines: [{ productId: p[key] }],
              channel: "STAFF",
              fulfilmentKind: "DELIVERY",
            })
          ).outcome,
      );
    const portalHidden = () => as(() => service.restrictedProductIdsFor(tenantId, customerId));

    const mkProduct = async (key: string, extra: Record<string, unknown> = {}) => {
      p[key] = (
        await prisma.product.create({
          data: {
            tenantId,
            name: `ML ${key} ${RUN}`,
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

      const slug = assertTestTenant(`qa-sr-multilabel-${RUN}`, "multi-label.db.spec.ts");
      tenantId = (await prisma.tenant.create({ data: { slug, name: `ML ${slug}` } })).id;
      const user = await prisma.user.create({
        data: {
          email: `ml-${RUN}@example.invalid`,
          username: `ml-${RUN}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      customerId = (
        await prisma.customer.create({
          data: { userId: user.id, businessName: "ML Buyer", contactName: "ML", tenantId },
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
      // The staff channel applies only with the tenant switch on.
      await prisma.systemConfig.create({
        data: { tenantId, key: SYSTEM_CONFIG_ENABLED, value: "true" },
      });
      for (const key of ["A", "B", "C"]) {
        c[key] = (
          await prisma.productCategory.create({ data: { tenantId, name: `ML ${key} ${RUN}` } })
        ).id;
      }
      // P's free-text category names none of its labels: only the INCLUDE rows decide.
      await mkProduct("P", { kind: "FAMILY", category: `Unrelated text ${RUN}` });
      await mkProduct("V", { kind: "VARIANT", parentProductId: p.P });
      for (const key of ["A", "B"]) {
        await prisma.productCategoryLabel.create({
          data: { tenantId, productId: p.P, categoryId: c[key], mode: "INCLUDE" },
        });
      }
    }, 120_000);

    afterAll(async () => {
      if (tenantId) {
        await prisma.sellingRestrictionTarget.deleteMany({ where: { tenantId } });
        await prisma.sellingRestriction.deleteMany({ where: { tenantId } });
        await prisma.productCategoryLabel.deleteMany({ where: { tenantId } });
        await prisma.customerAddress.deleteMany({ where: { tenantId } });
        await prisma.customer.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.productCategory.deleteMany({ where: { tenantId } });
        await prisma.systemConfig.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      }
      await prisma.$disconnect();
    }, 120_000);

    describe.each<RuleKind>(["legacy", "target"])("a %s rule", (kind) => {
      it.each(["A", "B"])(
        "1-2 / 8: a rule on label %s blocks P at the portal (409)",
        async (label) => {
          await withRule(kind, label, async () => {
            expect(await refusal("P")).toBe("SELLING_RESTRICTED");
          });
        },
      );

      it("3: a rule on label C, which P does not carry, allows P", async () => {
        await withRule(kind, "C", async () => {
          expect(await refusal("P")).toBeNull();
          expect(await refusal("V")).toBeNull();
        });
      });
    });

    it("4: the B rule blocks the variant V through its parent's label", async () => {
      await withRule("legacy", "B", async () => {
        expect(await refusal("V")).toBe("SELLING_RESTRICTED");
      });
    });

    it("6: portal: under B the hidden set covers P and V; under C it is empty", async () => {
      await withRule("legacy", "B", async () => {
        const hidden = await portalHidden();
        expect(hidden.has(p.P)).toBe(true);
        expect(hidden.has(p.V)).toBe(true);
      });
      await withRule("legacy", "C", async () => {
        expect((await portalHidden()).size).toBe(0);
      });
    });

    it("7: staff channel: BLOCK under B, and flagRestrictedLines flags P", async () => {
      await withRule("legacy", "B", async () => {
        expect(await staffOutcome("P")).toBe("BLOCK");
        expect(await refusal("P", "STAFF")).toBe("SELLING_RESTRICTED");
        const warn = jest.fn();
        const flags = await as(() =>
          flagRestrictedLines(
            { restrictions: service, warn },
            { tenantId, customerId, productIds: [p.P], fulfilmentKind: "DELIVERY" },
          ),
        );
        expect(flags.map((f) => f.productId)).toEqual([p.P]);
        expect(warn).not.toHaveBeenCalled();
      });
    });

    describe("variant opt-out and label removal (these mutate labels, so they run last, in order)", () => {
      it("5: V's EXCLUDE of B pinned to P: V allowed under B, still blocked under A", async () => {
        await prisma.productCategoryLabel.create({
          data: {
            tenantId,
            productId: p.V,
            categoryId: c.B,
            mode: "EXCLUDE",
            parentProductIdAtWrite: p.P,
          },
        });
        await withRule("legacy", "B", async () => {
          expect(await refusal("V")).toBeNull();
          expect(await refusal("P")).toBe("SELLING_RESTRICTED");
          expect((await portalHidden()).has(p.V)).toBe(false);
        });
        await withRule("legacy", "A", async () => {
          expect(await refusal("V")).toBe("SELLING_RESTRICTED");
        });
      });

      it.each<RuleKind>(["legacy", "target"])(
        "9: B removed from P: a %s B rule allows P, the A rule still blocks it",
        async (kind) => {
          await prisma.productCategoryLabel.deleteMany({
            where: { tenantId, productId: p.P, categoryId: c.B },
          });
          await withRule(kind, "B", async () => {
            expect(await refusal("P")).toBeNull();
          });
          await withRule(kind, "A", async () => {
            expect(await refusal("P")).toBe("SELLING_RESTRICTED");
          });
        },
      );
    });
  },
);
