/**
 * SA-929 (W-773 / W-774) on real Postgres, through the REAL SellingRestrictionsService (the sibling
 * `pickup-complete.complete-at-counter.db.spec.ts` stubs it). Complete at counter on a ROUTE order whose line is banned
 * at the STORE's state (the switch ROUTE -> PICKUP is judged there) with the owner switch ON. It proves the W-774
 * pre-judge (read-only, before the claim) and the switch's own judgement agree on ONE warning hash:
 *
 *  1. first call: 409 RESTRICTION_WARNING with a hash; the order still ROUTE / CONFIRMED, no claim, no stamp, no audit row;
 *  2. the SAME request + that 409's hash + a reason: the order completes and the override is stamped and audited ONCE;
 *  3. a DRIVER (no override right): a hard 409, nothing written.
 *
 * The tender and the completion email are spies (pinned elsewhere). Collected only by `jest.db.config.js`
 * (`npm run local:test:db`). One throwaway `qa-r510-<run>` tenant (assertTestTenant), purged in afterAll.
 */
jest.mock("../../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { buildDbOrdersService } from "../../common/testing/orders-service-db-harness";
import { PrismaService } from "../../prisma/prisma.service";
import { ProductLabelsService } from "../../product-labels/product-labels.service";
import { SellingRestrictionsService } from "../../selling-restrictions/selling-restrictions.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { PickupCompleteService } from "./pickup-complete.service";
import {
  purgeOverrideWorld,
  seedOverrideWorld,
  setStoreState,
  staffPayload,
  type OverrideWorld,
} from "../../../test/restriction-override-fixture";

const RUN = randomUUID().slice(0, 8);
const REASON = "Licensed buyer, paperwork on file";

describeDb("SA-929 Complete at counter x the real restriction warning — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  let w: OverrideWorld;
  let n = 0;
  const sent: string[] = [];
  const email = jest.fn(async () => ({ delivered: true }));
  const storePickup = {
    get: async () => ({ methods: ["ROUTE", "SHIP", "PICKUP"], counter: "off" }) as never,
  };

  const as = <T>(fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);
  const engine = () =>
    new (PickupCompleteService as any)(
      orders,
      orders.invoicesService,
      prisma,
      storePickup as never,
      { emitRouteProgress: jest.fn() } as never,
    );
  /** The same request every time: only the acknowledgement differs between the calls. */
  const complete = (
    orderId: string,
    key: string,
    ack: object = {},
    role: "OPERATOR" | "DRIVER" = "OPERATOR",
  ) => as(() => engine().complete(orderId, ack as never, staffPayload(w, role), key));
  const errOf = async (p: Promise<unknown>): Promise<any> => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected a rejection");
  };
  const bodyOf = (e: any) => e.getResponse() as any;
  const ackFrom = (e: any) => ({
    warningHash: bodyOf(e).warningHash as string,
    restrictionOverrides: (bodyOf(e).lines as Array<{ lineKey: string }>).map((l) => ({
      lineKey: l.lineKey,
      reason: REASON,
    })),
  });
  const claimCount = (orderId: string) =>
    raw.auditLog.count({
      where: { tenantId: w.tenantId, entityId: orderId, action: "PICKUP_COMPLETE_CLAIM" },
    });
  const overrideAudits = (orderId: string) =>
    raw.auditLog.findMany({
      where: {
        tenantId: w.tenantId,
        action: "selling_restriction.overridden",
        meta: { path: ["documentId"], equals: orderId },
      },
    });
  const lineRows = (orderId: string) => raw.orderItem.findMany({ where: { orderId } });
  const stateOf = async (orderId: string) => {
    const o = await raw.order.findUniqueOrThrow({ where: { id: orderId } });
    return { path: o.fulfillPath, status: o.status };
  };

  /** A CONFIRMED ROUTE order with one banned line (store CA, customer TX) and its DRAFT invoice (nothing owed). */
  async function seed() {
    n += 1;
    const order = await raw.order.create({
      data: {
        tenantId: w.tenantId,
        customerId: w.txCustomerId,
        status: "CONFIRMED",
        fulfillPath: "ROUTE",
        orderNumber: `SA929-${RUN}-${n}`,
        source: "APP",
        subtotal: "0",
        total: "0",
        lineItems: {
          create: [
            {
              tenantId: w.tenantId,
              productId: w.banned,
              qty: "2",
              unitPrice: "0",
              subtotal: "0",
              status: "PENDING" as never,
              position: 0,
            },
          ],
        },
      },
    });
    const invoice = await raw.invoice.create({
      data: {
        invoiceNumber: `INV-SA929-${RUN}-${n}`,
        customerId: w.txCustomerId,
        orderId: order.id,
        tenantId: w.tenantId,
        status: "DRAFT",
        subtotal: 0,
        total: 0,
      },
    });
    return { orderId: order.id, invoiceId: invoice.id };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    orders = buildDbOrdersService(prisma, tenantCtx, {
      invoices: {
        send: async (id: string, opts?: { suppressNotify?: boolean }) => {
          sent.push(`${id}:${opts?.suppressNotify === true ? "quiet" : "notify"}`);
          await raw.invoice.update({ where: { id }, data: { status: "SENT" } });
          return { status: "SENT" };
        },
        recordPayment: jest.fn(),
        sendCompletionEmail: email,
      },
    });
    // the REAL engine in place of the harness's allow-all stand-in: this is what the spec is for
    orders.sellingRestrictions = new SellingRestrictionsService(
      prisma,
      new ProductLabelsService(prisma),
    );
    w = await seedOverrideWorld(raw, RUN, "pickup-complete.restriction-warning.db.spec.ts");
    await setStoreState(raw, w.tenantId, "CA");
  }, 60_000);

  afterAll(async () => {
    try {
      if (w) await purgeOverrideWorld(pool, w.tenantId);
    } finally {
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }
  });

  beforeEach(() => {
    sent.length = 0;
    email.mockClear();
  });

  it("warn, then the same request + the 409's hash + a reason completes with the override stamped ONCE", async () => {
    const { orderId, invoiceId } = await seed();
    const key = `key-${RUN}-warn`;

    // 1. the pre-judge warns (read-only): nothing is claimed, stamped or switched
    const warn = await errOf(complete(orderId, key));
    expect(warn.getStatus()).toBe(409);
    expect(bodyOf(warn)).toMatchObject({ code: "RESTRICTION_WARNING" });
    expect(bodyOf(warn).warningHash).toEqual(expect.any(String));
    expect(await stateOf(orderId)).toEqual({ path: "ROUTE", status: "CONFIRMED" });
    expect(await claimCount(orderId)).toBe(0);
    expect((await lineRows(orderId))[0].restrictionOverrideAt).toBeNull();
    expect(await overrideAudits(orderId)).toHaveLength(0);
    expect((await raw.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
      "DRAFT",
    );
    expect(sent).toEqual([]);

    // 2. the SAME request (same key) + the hash + a reason: the switch re-judges to the SAME hash and completes
    await complete(orderId, key, ackFrom(warn));
    expect(await stateOf(orderId)).toEqual({ path: "PICKUP", status: "DELIVERED" });
    const rows = await lineRows(orderId);
    expect(rows[0]).toMatchObject({
      restrictionOverrideReason: REASON,
      restrictionOverrideBy: w.operatorId,
    });
    expect(rows[0].restrictionOverrideAt).toBeInstanceOf(Date);
    expect(await overrideAudits(orderId)).toHaveLength(1);
    expect(await claimCount(orderId)).toBe(1);
  }, 60_000);

  it("a DRIVER cannot override: a hard 409 (no warning to acknowledge), nothing written", async () => {
    const { orderId, invoiceId } = await seed();
    const err = await errOf(complete(orderId, `key-${RUN}-driver`, {}, "DRIVER"));
    expect(err.getStatus?.()).toBe(409);
    expect(bodyOf(err).code).not.toBe("RESTRICTION_WARNING");
    expect(bodyOf(err)).toMatchObject({ code: "SELLING_RESTRICTED" });
    expect(await stateOf(orderId)).toEqual({ path: "ROUTE", status: "CONFIRMED" });
    expect(await claimCount(orderId)).toBe(0);
    expect((await lineRows(orderId))[0].restrictionOverrideAt).toBeNull();
    expect(await overrideAudits(orderId)).toHaveLength(0);
    expect((await raw.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
      "DRAFT",
    );
    expect(sent).toEqual([]);
  }, 60_000);
});
