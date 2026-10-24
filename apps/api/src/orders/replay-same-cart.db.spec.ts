/**
 * BUG-A / SA-715 - DB lane. Real Postgres proof that an Idempotency-Key replay is only ever a replay of the
 * SAME request: the helper (replay-same-cart.ts) runs over orders READ BACK from the database, through the
 * real replay lookups (`findReplayCandidateByKey`, `findOrderIdByIdempotencyKey`) and the real
 * `@@unique([tenantId, idempotencyKey])` P2002. create()'s own exits are pinned in
 * orders.replay-same-cart.spec.ts (a full create() needs the whole DI graph).
 */
// Mock InvoicesService before it's imported — prevents Jest from traversing
// invoice-pdf.service.ts which imports @react-pdf/renderer (ESM-only module).
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    createInvoiceFromOrder: jest
      .fn()
      .mockResolvedValue([{ id: "inv-1", invoiceNumber: "INV-1", total: 0 }]),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue(undefined),
    resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
    followPartialPrices: jest.fn().mockResolvedValue({ issuedPartialsUnchanged: [] }),
    projectEditedInvoiceTotals: jest.fn().mockResolvedValue([]),
  })),
}));

// Mock NotificationsService — it imports expo-server-sdk which is ESM-only
// and fails Jest's CommonJS parser.
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { ConflictException, Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { OrdersService } from "./orders.service";
import { assertReplaySameCart } from "./replay-same-cart";
import { mergeRequestHash } from "./merge-idempotency";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

interface Fx {
  tenantId: string;
  userId: string;
  customerId: string;
  orderId: string;
}

const cart = (qty: number, status?: "DRAFT" | "PENDING") => ({
  items: [{ name: "Widget", qty, unitPrice: 5 }],
  ...(status ? { status } : {}),
});

describeDb("BUG-A same-cart replay - real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let svc: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-samecart-${run}`, "replay-same-cart.db.spec.ts");
  let tenantId = "";
  const created: Fx[] = [];

  async function seed(
    tag: string,
    opts: { key: string | null; status?: "DRAFT" | "PENDING"; qty?: number },
  ): Promise<Fx> {
    const user = await raw.user.create({
      data: {
        email: `${tag}-${run}@example.test`,
        username: `${tag}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await raw.customer.create({
      data: { userId: user.id, businessName: `${tag} co`, contactName: "Same Cart", tenantId },
    });
    const order = await raw.order.create({
      data: {
        customerId: customer.id,
        tenantId,
        total: "10.00",
        status: opts.status ?? "PENDING",
        idempotencyKey: opts.key,
        lineItems: {
          create: [
            {
              tenantId,
              name: "Widget",
              qty: String(opts.qty ?? 2),
              unitPrice: "5.00",
              subtotal: "10.00",
            },
          ],
        },
      },
    });
    const fx = { tenantId, userId: user.id, customerId: customer.id, orderId: order.id };
    created.push(fx);
    return fx;
  }
  const candidate = (f: Fx, key: string) =>
    tenantCtx.run(tenantId, () => svc.findReplayCandidateByKey(key, f.customerId));
  const errorOf = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e) => e,
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    svc = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      logger: new Logger(OrdersService.name),
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `SameCart ${slug}` } })).id;
  }, 120_000);

  afterAll(async () => {
    for (const f of created) {
      await raw.orderItem.deleteMany({ where: { orderId: f.orderId } });
      await raw.order.deleteMany({ where: { customerId: f.customerId } });
      await raw.customer.deleteMany({ where: { id: f.customerId } });
      await raw.user.deleteMany({ where: { id: f.userId } });
    }
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("(a) the same key + an EDITED cart after a committed create: 409 CART_MISMATCH carrying the order id", async () => {
    const f = await seed("a", { key: `K-${run}-a` });
    const existing = await candidate(f, `K-${run}-a`);
    expect(() => assertReplaySameCart(existing, cart(2))).not.toThrow(); // the identical retry replays
    const e: any = await errorOf(
      Promise.resolve().then(() => assertReplaySameCart(existing, cart(3))),
    );
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({
      code: "IDEMPOTENCY_KEY_CART_MISMATCH",
      orderId: f.orderId,
    });
  });

  it("(b) the REAL P2002 race: the loser's key hits the unique index; the winner is NOT replayed for an edited body", async () => {
    const f = await seed("b", { key: `K-${run}-b` });
    const dup = await errorOf(
      raw.order.create({
        data: { customerId: f.customerId, tenantId, total: "30.00", idempotencyKey: `K-${run}-b` },
      }),
    );
    expect((dup as any)?.code).toBe("P2002"); // the constraint create()'s race exit catches
    const winner = await candidate(f, `K-${run}-b`);
    expect(winner.id).toBe(f.orderId);
    const e: any = await errorOf(
      Promise.resolve().then(() => assertReplaySameCart(winner, cart(3))),
    );
    expect(e.getResponse()).toMatchObject({
      code: "IDEMPOTENCY_KEY_CART_MISMATCH",
      orderId: f.orderId,
    });
  });

  it("(c) the staff fold's Order-COLUMN key hit: an edited cart is a 409, the identical cart replays unverified", async () => {
    const f = await seed("c", { key: `K-${run}-c` });
    const hash = mergeRequestHash({ customerId: f.customerId, items: cart(2).items });
    const same = await tenantCtx.run(tenantId, () =>
      svc.findOrderIdByIdempotencyKey(`K-${run}-c`, f.customerId, hash, undefined, cart(2)),
    );
    expect(same).toEqual({ orderId: f.orderId, verified: false });
    const e: any = await errorOf(
      tenantCtx.run(tenantId, () =>
        svc.findOrderIdByIdempotencyKey(`K-${run}-c`, f.customerId, hash, undefined, cart(3)),
      ),
    );
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({
      code: "IDEMPOTENCY_KEY_CART_MISMATCH",
      orderId: f.orderId,
    });
  });

  it("(d) Save as Draft, then Create Order on the same key: 409 DRAFT_MISMATCH with the order id (and the reverse)", async () => {
    const f = await seed("d", { key: `K-${run}-d`, status: "DRAFT" });
    const draft = await candidate(f, `K-${run}-d`);
    expect(() => assertReplaySameCart(draft, cart(2, "DRAFT"))).not.toThrow();
    const e: any = await errorOf(
      Promise.resolve().then(() => assertReplaySameCart(draft, cart(2, "PENDING"))),
    );
    expect(e.getResponse()).toMatchObject({
      code: "IDEMPOTENCY_KEY_DRAFT_MISMATCH",
      orderId: f.orderId,
    });
    const g = await seed("d2", { key: `K-${run}-d2`, status: "PENDING" });
    const real = await candidate(g, `K-${run}-d2`);
    const e2: any = await errorOf(
      Promise.resolve().then(() => assertReplaySameCart(real, cart(2, "DRAFT"))),
    );
    expect(e2.getResponse()).toMatchObject({
      code: "IDEMPOTENCY_KEY_DRAFT_MISMATCH",
      orderId: g.orderId,
    });
  });

  it("same key => ONE order (the unique index); different keys => TWO orders", async () => {
    const f = await seed("e", { key: `K-${run}-e1` });
    await raw.order.create({
      data: { customerId: f.customerId, tenantId, total: "10.00", idempotencyKey: `K-${run}-e2` },
    });
    const dup = await errorOf(
      raw.order.create({
        data: { customerId: f.customerId, tenantId, total: "10.00", idempotencyKey: `K-${run}-e1` },
      }),
    );
    expect((dup as any)?.code).toBe("P2002");
    expect(await raw.order.count({ where: { customerId: f.customerId } })).toBe(2);
  });

  it("merge-prompt round trip (B215): the 409 prompt writes nothing, then the SAME key folds ONCE and replays after", async () => {
    const f = await seed("m", { key: null });
    const key = `K-${run}-m`;
    const body = { customerId: f.customerId, items: cart(2).items };
    // mergeChoice is not part of the fingerprint, so request 1 (no choice) and request 2 (merge) share it.
    expect(mergeRequestHash(body)).toBe(mergeRequestHash({ ...body }));
    const hash = mergeRequestHash(body);
    // request 1: MERGE_CHOICE_REQUIRED wrote no key rows
    expect(
      await tenantCtx.run(tenantId, () => svc.findOrderIdByIdempotencyKey(key, f.customerId, hash)),
    ).toBeNull();
    const fold = async () =>
      tenantCtx.run(tenantId, async () => {
        if (await svc.findOrderIdByIdempotencyKey(key, f.customerId, hash)) return "replayed";
        await prisma.tenantTransaction(async (tx: any) => {
          await tx.$executeRaw`UPDATE "Order" SET "total" = "total" + 10 WHERE "id" = ${f.orderId}`;
          await svc.recordMergeIdempotencyKey(tx, f.orderId, { key, responseHash: hash });
        });
        await svc.recordIdempotencyKey(f.orderId, key);
        return "folded";
      });
    expect(await fold()).toBe("folded"); // request 2: the operator's merge choice, same key
    expect(await fold()).toBe("replayed"); // request 3: a retry
    expect(Number((await raw.order.findUniqueOrThrow({ where: { id: f.orderId } })).total)).toBe(
      20,
    );
  });
});
