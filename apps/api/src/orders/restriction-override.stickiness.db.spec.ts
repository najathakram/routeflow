/**
 * Row 510 — real-Postgres proof that an override is STICKY BY (rule id, judged state), through OrdersService with the REAL
 * SellingRestrictionsService. A stamp stores `ruleId:STATE` keys (`UNKNOWN` for an unresolved sale), and a sale is covered
 * only when every current breach key is in the stored set:
 *
 *   - an INDETERMINATE override (customer with no state), then the customer gets a CA address, then an edit -> warns again;
 *   - a PICKUP override (judged at the store, TX), then a switch to delivery into a banned state (CA) -> warns again;
 *   - a quantity change with no state change -> still covered (no warning, the stamp is carried, no new audit row).
 *
 * Collected only by jest.db.config.js (`RUN_DB_SPECS=local npx jest -c jest.db.config.js --runInBand <this file>`).
 * One throwaway `qa-r510-<run>` tenant approved by `assertTestTenant`, deleted in afterAll.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    reconcileOrderDraftInvoice: jest.fn().mockResolvedValue(null),
    resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([]),
    followPartialPrices: jest.fn().mockResolvedValue({ issuedPartialsUnchanged: [] }),
    projectEditedInvoiceTotals: jest.fn().mockResolvedValue([]),
    revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
    findOpenOrderDraft: jest.fn().mockResolvedValue(null),
    createInvoiceFromOrder: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
    voidInvoiceInTx: jest.fn().mockResolvedValue({ id: "inv-1", status: "VOID" }),
  })),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
    sendToUser: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { OrdersService } from "./orders.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import {
  purgeOverrideWorld,
  seedOverrideWorld,
  setStoreState,
  staffPayload,
  type OverrideWorld,
} from "../../test/restriction-override-fixture";
import { buildOverrideModule } from "../../test/restriction-override-module";

const RUN = randomUUID().slice(0, 8);
const REASON = "Licensed buyer, paperwork on file";

describeDb("row 510: an override is sticky by (rule id, judged state) — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let svc: OrdersService;
  let dbPrisma: PrismaService;
  let tenantCtx: TenantContextService;
  let w: OverrideWorld;
  /** A product the CA+TX rule bans (so a STORE in TX breaches too), and that rule's id. */
  let bannedTx: string;
  let ruleTxId: string;
  let noStateCustomerId: string;
  const url = () => requireLocalDatabaseUrl();

  const as = <T>(fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);
  const staff = () => staffPayload(w, "OPERATOR");
  const errOf = async (p: Promise<unknown>): Promise<any> => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected a rejection");
  };
  const bodyOf = (e: any) => e.getResponse() as any;
  const ackFrom = (e: any, reason = REASON) => ({
    warningHash: bodyOf(e).warningHash as string,
    restrictionOverrides: (bodyOf(e).lines as Array<{ lineKey: string }>).map((l) => ({
      lineKey: l.lineKey,
      reason,
    })),
  });
  const lineRows = (orderId: string) =>
    raw.orderItem.findMany({ where: { orderId }, orderBy: [{ position: "asc" }] });
  const audits = (orderId: string) =>
    raw.auditLog.findMany({
      where: {
        tenantId: w.tenantId,
        action: "selling_restriction.overridden",
        meta: { path: ["documentId"], equals: orderId },
      },
    });
  const edit = (orderId: string, body: object) =>
    as(() => svc.updateOrderItems(orderId, body as never, staff()));

  beforeAll(async () => {
    pool = new Pool({ connectionString: url() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    dbPrisma = new PrismaService(tenantCtx);
    await dbPrisma.$connect();
    const module = await buildOverrideModule(tenantCtx, dbPrisma);
    svc = module.get(OrdersService);
    w = await seedOverrideWorld(raw, RUN, "restriction-override.stickiness.db.spec.ts");

    // a second restricted category whose rule bans CA AND TX
    const category = await raw.productCategory.create({
      data: { tenantId: w.tenantId, name: "Restricted TX" },
    });
    const product = await raw.product.create({
      data: {
        tenantId: w.tenantId,
        name: `Tonic ${RUN}`,
        unit: "each",
        pricePerUnit: "10.00",
        currentStock: 1000,
      },
    });
    await raw.productCategoryLabel.create({
      data: {
        tenantId: w.tenantId,
        productId: product.id,
        categoryId: category.id,
        mode: "INCLUDE",
      },
    });
    bannedTx = product.id;
    ruleTxId = (
      await raw.sellingRestriction.create({
        data: {
          tenantId: w.tenantId,
          categoryId: category.id,
          jurisdiction: "STATE",
          states: ["CA", "TX"],
          reason: "R510 CA and TX ban",
          effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        },
      })
    ).id;

    // a customer with NO address at all: the sale's state cannot be resolved
    const user = await raw.user.create({
      data: {
        email: `cust-none-${RUN}@example.test`,
        username: `cust-none-${RUN}`,
        role: "CUSTOMER",
        tenantId: w.tenantId,
      },
    });
    noStateCustomerId = (
      await raw.customer.create({
        data: {
          userId: user.id,
          businessName: "R510 none co",
          contactName: "Tester",
          tenantId: w.tenantId,
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    if (w?.tenantId) await purgeOverrideWorld(pool, w.tenantId);
    await dbPrisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  afterEach(async () => {
    await setStoreState(raw, w.tenantId, null);
  });

  it("an INDETERMINATE override (stored ruleId:UNKNOWN) warns again once the customer has a CA address; a qty change before that stays covered", async () => {
    const items = [{ productId: w.banned, qty: 2 }];
    const first = await errOf(
      as(() => svc.create({ customerId: noStateCustomerId, items } as never, staff())),
    );
    expect(bodyOf(first).lines[0]).toMatchObject({ productId: w.banned, outcome: "INDETERMINATE" });
    const order: any = await as(() =>
      svc.create({ customerId: noStateCustomerId, items, ...ackFrom(first) } as never, staff()),
    );
    const [line] = await lineRows(order.id);
    expect(line.restrictionOverrideRuleIds).toEqual([`${w.ruleId}:UNKNOWN`]);
    expect(await audits(order.id)).toHaveLength(1);

    // still no state: a quantity change is covered (no warning, the stamp is carried, no new audit row)
    await edit(order.id, { items: [{ id: line.id, qty: 5 }] });
    const [raised] = await lineRows(order.id);
    expect(Number(raised.qty)).toBe(5);
    expect(raised.restrictionOverrideRuleIds).toEqual([`${w.ruleId}:UNKNOWN`]);
    expect(await audits(order.id)).toHaveLength(1);

    // the customer gets a CA address: the same rule now BLOCKs at CA, which the UNKNOWN stamp does not cover
    await raw.customerAddress.create({
      data: {
        tenantId: w.tenantId,
        customerId: noStateCustomerId,
        line1: "9 Test St",
        city: "Testville",
        state: "CA",
        stateCode: "CA",
        zip: "00000",
        isDefault: true,
        addressType: "BILLING",
      },
    });
    const again = await errOf(edit(order.id, { items: [{ id: line.id, qty: 6 }] }));
    expect(again.getStatus()).toBe(409);
    expect(bodyOf(again).code).toBe("RESTRICTION_WARNING");
    expect(bodyOf(again).lines[0]).toMatchObject({ productId: w.banned, outcome: "BLOCK" });
    expect(Number((await lineRows(order.id))[0].qty)).toBe(5); // the edit wrote nothing

    await edit(order.id, {
      items: [{ id: line.id, qty: 6 }],
      ...ackFrom(again, "Address now on file"),
    });
    const [rewarned] = await lineRows(order.id);
    expect(Number(rewarned.qty)).toBe(6);
    expect(rewarned.restrictionOverrideRuleIds).toEqual([`${w.ruleId}:CA`]); // replaced, not appended
    expect(rewarned.restrictionOverrideReason).toBe("Address now on file");
    expect(await audits(order.id)).toHaveLength(2);
  });

  it("a PICKUP override (judged at the TX store) warns again when the order is switched to delivery into CA", async () => {
    await setStoreState(raw, w.tenantId, "TX");
    const items = [{ productId: bannedTx, qty: 1 }];
    const first = await errOf(
      as(() =>
        svc.create({ customerId: w.caCustomerId, items } as never, staff(), {
          fulfillPath: "PICKUP",
        }),
      ),
    );
    expect(bodyOf(first).lines[0].rules[0].reasonText).toBe("This product is banned in TX by law.");
    const order: any = await as(() =>
      svc.create({ customerId: w.caCustomerId, items, ...ackFrom(first) } as never, staff(), {
        fulfillPath: "PICKUP",
      }),
    );
    expect((await lineRows(order.id))[0].restrictionOverrideRuleIds).toEqual([`${ruleTxId}:TX`]);

    // delivery: judged at the customer's CA address, a state the TX stamp never covered
    const sw = (ack?: object) =>
      as(() => svc.updateFulfillPath(order.id, { fulfillPath: "ROUTE", ...ack } as never, staff()));
    const warned = await errOf(sw());
    expect(bodyOf(warned).code).toBe("RESTRICTION_WARNING");
    expect(bodyOf(warned).lines[0].rules[0].reasonText).toBe(
      "This product is banned in CA by law.",
    );
    expect((await raw.order.findUniqueOrThrow({ where: { id: order.id } })).fulfillPath).toBe(
      "PICKUP",
    );

    await sw(ackFrom(warned, "Delivering to a licensed buyer"));
    expect((await raw.order.findUniqueOrThrow({ where: { id: order.id } })).fulfillPath).toBe(
      "ROUTE",
    );
    expect((await lineRows(order.id))[0].restrictionOverrideRuleIds).toEqual([`${ruleTxId}:CA`]);
    expect(await audits(order.id)).toHaveLength(2);
  });

  it("the same sale at the SAME state stays covered: a PICKUP order at the TX store, qty raised, never warns twice", async () => {
    await setStoreState(raw, w.tenantId, "TX");
    const items = [{ productId: bannedTx, qty: 1 }];
    const opts = { fulfillPath: "PICKUP" } as never;
    const first = await errOf(
      as(() => svc.create({ customerId: w.caCustomerId, items } as never, staff(), opts)),
    );
    const order: any = await as(() =>
      svc.create({ customerId: w.caCustomerId, items, ...ackFrom(first) } as never, staff(), opts),
    );
    const [line] = await lineRows(order.id);
    await edit(order.id, { items: [{ id: line.id, qty: 9 }] });
    const [raised] = await lineRows(order.id);
    expect(Number(raised.qty)).toBe(9);
    expect(raised.restrictionOverrideRuleIds).toEqual([`${ruleTxId}:TX`]);
    expect(await audits(order.id)).toHaveLength(1);
  });
});
