/**
 * L8 — real-Postgres proof that WHICH state judges a state ban follows how the goods change hands, end to end through
 * the real engine (`SellingRestrictionsService`) and the real fulfil-path switch guard (`assertFulfilPathSwitchAllowed`):
 *
 *   (a) a COUNTER sale and a PICKUP are judged at the STORE state for a named customer whose own address is elsewhere;
 *   (b) an unset store state refuses both with 409 SELLING_RESTRICTED (INDETERMINATE, fail closed);
 *   (c) the two row-504 switch directions: PICKUP -> delivery judges the CUSTOMER's state, delivery -> PICKUP the
 *       STORE's; a customer with no address is the coded 400 ORDER_DELIVERY_ADDRESS_MISSING (nothing judged);
 *   (d) the buyer portal of a PICKUP-ONLY tenant hides by the store state (unset: hidden), a shipping tenant by the
 *       buyer's, and enable-readiness needs a store state for a pickup portal.
 *
 * Collected only by `jest.db.config.js`; run via `npm run local:test:db`. The tenant is a throwaway `qa-l8-<run>` slug
 * approved by `assertTestTenant`; afterAll deletes exactly what it made. NOT RUN in the authoring environment (no
 * Postgres): the landing lane runs it.
 */
import { BadRequestException, ConflictException } from "@nestjs/common";
import { FulfillPath } from "@prisma/client";
import { randomUUID } from "crypto";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { assertFulfilPathSwitchAllowed } from "../orders/fulfil-path-restrictions";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import type { SaleFulfilmentKind } from "./sale-fulfilment";
import { SellingRestrictionsService } from "./selling-restrictions.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("L8 store state by fulfilment kind — real Postgres", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let service: SellingRestrictionsService;
  let tenantId: string;
  let productId: string;
  const ids: Record<string, string> = {};

  const as = <T>(fn: () => Promise<T>) => ctx.run(tenantId, fn);
  const setStore = async (state: string | null) => {
    await prisma.tenantConfig.deleteMany({ where: { tenantId } });
    if (state !== null) await prisma.tenantConfig.create({ data: { tenantId, state } });
  };
  const setModel = async (mode: string | null) => {
    await prisma.tenantFeatureConfig.deleteMany({ where: { tenantId } });
    if (mode !== null)
      await prisma.tenantFeatureConfig.create({
        data: { tenantId, featureKey: "fulfilment_model", mode, reason: "L8 db spec" },
      });
  };
  const judge = (customerId: string, fulfilmentKind: SaleFulfilmentKind) =>
    as(() =>
      service.assertLinesSellable({
        tenantId,
        customerId,
        lines: [{ productId }],
        channel: "STAFF",
        fulfilmentKind,
      }),
    );
  const outcome = (customerId: string, fulfilmentKind: SaleFulfilmentKind) =>
    judge(customerId, fulfilmentKind).then(
      () => "ALLOW",
      (e) => (e instanceof ConflictException ? e.getResponse() : e),
    );
  const switchTo = (customerKey: string, from: FulfillPath, target: FulfillPath) =>
    as(() =>
      assertFulfilPathSwitchAllowed(service, {
        order: {
          tenantId,
          customerId: ids[customerKey],
          status: "PENDING",
          fulfillPath: from,
          counterSale: false,
          customer: { addresses: customerKey === "noaddr" ? [] : [{}] },
          lineItems: [{ productId }],
        },
        target,
        principal: { role: "OPERATOR", tenantId } as never,
        ambientTenantId: tenantId,
      }),
    );

  async function mkCustomer(key: string, state?: string) {
    const handle = `l8-${RUN}-${key}`;
    const user = await prisma.user.create({
      data: { email: `${handle}@example.invalid`, username: handle, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `Acme ${key}`, contactName: "L8", tenantId },
    });
    if (state) {
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
    }
    ids[key] = customer.id;
  }

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    service = new SellingRestrictionsService(prisma, new ProductLabelsService(prisma));

    const slug = assertTestTenant(`qa-l8-${RUN}`, "store-state-by-fulfilment.l8.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `L8 ${slug}` } })).id;
    await prisma.systemConfig.create({
      data: { tenantId, key: "selling_restrictions.enabled", value: "true" },
    });
    const category = await prisma.productCategory.create({
      data: { tenantId, name: "Restricted" },
    });
    productId = (
      await prisma.product.create({
        data: { tenantId, name: "L8 item", unit: "each", pricePerUnit: 10 },
      })
    ).id;
    await prisma.productCategoryLabel.create({
      data: { tenantId, productId, categoryId: category.id, mode: "INCLUDE" },
    });
    await prisma.sellingRestriction.create({
      data: {
        tenantId,
        categoryId: category.id,
        jurisdiction: "STATE",
        states: ["TX"],
        reason: "L8 state ban",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await mkCustomer("ca", "CA");
    await mkCustomer("tx", "TX");
    await mkCustomer("noaddr");
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      await prisma.sellingRestriction.deleteMany({ where: { tenantId } });
      await prisma.productCategoryLabel.deleteMany({ where: { tenantId } });
      await prisma.systemConfig.deleteMany({ where: { tenantId } });
      await prisma.tenantConfig.deleteMany({ where: { tenantId } });
      await prisma.tenantFeatureConfig.deleteMany({ where: { tenantId } });
      await prisma.customerAddress.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.product.deleteMany({ where: { tenantId } });
      await prisma.productCategory.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    await prisma?.$disconnect();
  }, 120_000);

  describe.each<SaleFulfilmentKind>(["COUNTER", "PICKUP"])(
    "(a) %s is judged at the STORE",
    (kind) => {
      it("a CA customer, store in TX: refused (the TX ban applies, the customer's CA does not matter)", async () => {
        await setStore("TX");
        expect(await outcome(ids["ca"], kind)).toMatchObject({ code: "SELLING_RESTRICTED" });
      });
      it("a TX customer, store in CA: sold (the customer's TX does not matter)", async () => {
        await setStore("CA");
        expect(await outcome(ids["tx"], kind)).toBe("ALLOW");
      });
      it("(b) an unset store state is refused 409 SELLING_RESTRICTED (INDETERMINATE), for a named customer", async () => {
        await setStore(null);
        expect(await outcome(ids["ca"], kind)).toMatchObject({ code: "SELLING_RESTRICTED" });
      });
    },
  );

  it("(a) DELIVERY keeps the customer's address: CA customer, store TX: sold", async () => {
    await setStore("TX");
    expect(await outcome(ids["ca"], "DELIVERY")).toBe("ALLOW");
    expect(await outcome(ids["tx"], "DELIVERY")).toMatchObject({ code: "SELLING_RESTRICTED" });
  });

  describe("(c) row 504: a fulfil-path switch re-judges at the TARGET path's state", () => {
    it("PICKUP -> ROUTE uses the CUSTOMER's state: TX customer refused, CA customer allowed (store TX)", async () => {
      await setStore("TX");
      await expect(switchTo("tx", FulfillPath.PICKUP, FulfillPath.ROUTE)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(switchTo("ca", FulfillPath.PICKUP, FulfillPath.ROUTE)).resolves.toBeUndefined();
    });
    it("PICKUP -> SHIP uses the CUSTOMER's state too", async () => {
      await setStore("TX");
      await expect(switchTo("tx", FulfillPath.PICKUP, FulfillPath.SHIP)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
    it("ROUTE -> PICKUP uses the STORE's state: store TX refuses a CA customer, store CA allows a TX one", async () => {
      await setStore("TX");
      await expect(switchTo("ca", FulfillPath.ROUTE, FulfillPath.PICKUP)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await setStore("CA");
      await expect(switchTo("tx", FulfillPath.ROUTE, FulfillPath.PICKUP)).resolves.toBeUndefined();
    });
    it("ROUTE -> PICKUP with an unset store state is refused (fail closed)", async () => {
      await setStore(null);
      await expect(switchTo("ca", FulfillPath.ROUTE, FulfillPath.PICKUP)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
    it("PICKUP -> ROUTE for a customer with NO address is the coded 400 ORDER_DELIVERY_ADDRESS_MISSING", async () => {
      await setStore("CA");
      const err = await switchTo("noaddr", FulfillPath.PICKUP, FulfillPath.ROUTE).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toMatchObject({ code: "ORDER_DELIVERY_ADDRESS_MISSING" });
    });
  });

  describe("(d) the buyer portal and enable-readiness follow the fulfilment model", () => {
    const hidden = async (customerKey: string) => [
      ...(await as(() => service.restrictedProductIdsFor(tenantId, ids[customerKey]))),
    ];

    it("a PICKUP-ONLY tenant, CA buyer, store TX: the TX ban hides (the buyer's CA is not consulted)", async () => {
      await setModel("pickup");
      await setStore("TX");
      expect(await hidden("ca")).toEqual([productId]);
    });
    it("a PICKUP-ONLY tenant, TX buyer, store CA: nothing hidden", async () => {
      await setModel("pickup");
      await setStore("CA");
      expect(await hidden("tx")).toEqual([]);
    });
    it("a PICKUP-ONLY tenant with NO store state hides the restricted product (fail closed) and is NOT ready", async () => {
      await setModel("pickup");
      await setStore(null);
      expect(await hidden("ca")).toEqual([productId]);
      // the staff rule also needs the store state here; the point is the pickup portal is reported the same way
      expect((await as(() => service.getEnableReadiness(tenantId))).businessStateMissing).toBe(
        true,
      );
    });
    it("a MIXED pickup+ship tenant keeps the buyer's state: the CA buyer is not hidden from a TX ban, the TX buyer is", async () => {
      await setModel("pickup_ship");
      await setStore("CA");
      expect(await hidden("ca")).toEqual([]);
      expect(await hidden("tx")).toEqual([productId]);
    });
  });
});
