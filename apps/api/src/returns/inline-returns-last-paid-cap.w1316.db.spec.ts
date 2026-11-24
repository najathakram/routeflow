/**
 * W-1316 PR-1 (R-74 F1-F4): the last-paid cap proven through the REAL last-sale query. A mocked client ignores `select`, so a
 * field dropped from that select (productId, boxes, unitsPerBox) or a swapped pack precedence kept every mock row green while the
 * money moved. Each row here sells on a real invoice OUTSIDE the 90-day window (so the cap, not the window match, prices the
 * chunk) and asserts the exact subtotal and priceSource of the real quote.
 *
 *   D1 the newest invoice also holds another product's line: the cap uses only this product's line.
 *   D2 the last sale was a box split (`boxes` set, qty already pieces): 6 pieces for 12.00, 1 back -> 2.00.
 *   D3 the line's stored pack (6) differs from the product's pack today (24): the line's pack wins -> 2.00.
 *   D4 pack order, both ways: 1 box of 12 for 24.00 vs a pack of 24 today, and 1 box of 24 for 48.00 vs a pack of 1 today -> 2.00.
 *   D5 the C2 scenario: sold at 10.00, today 12.00, the credit is the paid 10.00.
 *
 * Run via `npm run local:test:db` (compose Postgres) - collected only by jest.db.config.js. Test tenant, acme placeholders.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("W-1316 PR-1 - the last-paid cap through the real query, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let quoteService: InlineReturnsQuoteService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(
    `qa-w1316cap-${run}`,
    "inline-returns-last-paid-cap.w1316.db.spec.ts",
  );
  let tenantId = "";
  let operatorId = "";
  const customerIds: string[] = [];
  const productIds: string[] = [];
  const userIds: string[] = [];
  const invoiceIds: string[] = [];
  let seq = 0;

  const staff: () => JwtPayload = () => ({
    sub: operatorId,
    username: "operator",
    role: "OPERATOR" as any,
    status: "ACTIVE" as any,
    forcePasswordChange: false,
    tenantId,
    tenantSlug: slug,
  });

  type Line = {
    productId: string;
    qty: number;
    subtotal: number;
    boxes?: number | null;
    unitsPerBox?: number | null;
  };

  const newProduct = async (price: number, unitsPerBox: number | null) => {
    const p = await raw.product.create({
      data: {
        name: `acme widget ${run} ${++seq}`,
        unit: "each",
        pricePerUnit: price.toFixed(2),
        ...(unitsPerBox != null ? { unitsPerBox } : {}),
        tenantId,
      },
    });
    productIds.push(p.id);
    return p.id;
  };

  /** A customer, and ONE PAID invoice 200 days old (outside the 90-day window) holding `items`. */
  const soldTo = async (items: Line[]) => {
    const u = await raw.user.create({
      data: {
        email: `cap-${run}-${++seq}@example.test`,
        username: `cap-${run}-${seq}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    userIds.push(u.id);
    const c = await raw.customer.create({
      data: { userId: u.id, businessName: `acme cap ${seq}`, contactName: "Cap Tester", tenantId },
    });
    customerIds.push(c.id);
    const net = items.reduce((t, l) => t + l.subtotal, 0);
    const invoice = await raw.invoice.create({
      data: {
        tenantId,
        customerId: c.id,
        orderId: null,
        invoiceNumber: `INV-W1316-${run}-${++seq}`,
        status: "PAID" as any,
        subtotal: net.toFixed(2),
        taxAmount: "0.00",
        total: net.toFixed(2),
        issueDate: new Date(Date.now() - 200 * 86_400_000),
      },
    });
    invoiceIds.push(invoice.id);
    for (const l of items) {
      await raw.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          productId: l.productId,
          description: "Widget",
          qty: l.qty,
          unitPrice: (l.subtotal / l.qty).toFixed(2),
          subtotal: l.subtotal.toFixed(2),
          taxRate: "0",
          boxes: l.boxes ?? null,
          unitsPerBox: l.unitsPerBox ?? null,
        },
      });
    }
    return c.id;
  };

  const quote = async (customerId: string, productId: string, pieces: number) => {
    const q = await tenantCtx.run(tenantId, () =>
      quoteService.quote({ customerId, items: [{ productId, boxes: 0, pieces }] } as any, staff()),
    );
    return { subtotal: q.chunks[0].subtotal, priceSource: q.chunks[0].priceSource };
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as any),
    );
    quoteService = new (InlineReturnsQuoteService as any)(prisma, systemConfig, undefined, {
      getEffectiveMode: async () => "ship",
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `W1316 ${slug}` } })).id;
    const op = await raw.user.create({
      data: {
        email: `cap-op-${run}@example.test`,
        username: `cap-op-${run}`,
        role: "OPERATOR",
        tenantId,
      },
    });
    userIds.push(op.id);
    operatorId = op.id;
    await raw.systemConfig.create({ data: { tenantId, key: "settings.taxRate", value: "0" } });
  }, 120_000);

  afterAll(async () => {
    await raw.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.systemConfig.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  it("D1 (F2): the newest invoice also holds another product's line: 10 back credit 100.00, today 120.00", async () => {
    const p = await newProduct(12, null);
    const other = await newProduct(12, null);
    const c = await soldTo([
      { productId: p, qty: 10, subtotal: 100 },
      { productId: other, qty: 10, subtotal: 1 },
    ]);
    expect(await quote(c, p, 10)).toEqual({ subtotal: 100, priceSource: "SOURCE_INVOICE" });
  }, 30_000);

  it("D2 (F3): a box split (6 pieces for 12.00, boxes set, qty in pieces), 1 back: 2.00, today 2.50 a piece", async () => {
    const p = await newProduct(60, 24);
    const c = await soldTo([{ productId: p, qty: 6, subtotal: 12, boxes: 0, unitsPerBox: 24 }]);
    expect(await quote(c, p, 1)).toEqual({ subtotal: 2, priceSource: "SOURCE_INVOICE" });
  }, 30_000);

  it("D3 (F4): 2 boxes of 6 for 24.00 (line pack 6), the product's pack today is 24: the line's pack wins, 1 back credits 2.00", async () => {
    const p = await newProduct(60, 24);
    const c = await soldTo([{ productId: p, qty: 2, subtotal: 24, unitsPerBox: 6 }]);
    expect(await quote(c, p, 1)).toEqual({ subtotal: 2, priceSource: "SOURCE_INVOICE" });
  }, 30_000);

  it("D4a (F1): sold as 1 box of 12 for 24.00, the pack today is 24: 1 piece back credits 2.00, never 1.00", async () => {
    const p = await newProduct(60, 24);
    const c = await soldTo([{ productId: p, qty: 1, subtotal: 24, unitsPerBox: 12 }]);
    expect(await quote(c, p, 1)).toEqual({ subtotal: 2, priceSource: "SOURCE_INVOICE" });
  }, 30_000);

  it("D4b (F1): sold as 1 box of 24 for 48.00, the pack today is 1 at 10.00: 1 piece back credits 2.00, never 10.00", async () => {
    const p = await newProduct(10, 1);
    const c = await soldTo([{ productId: p, qty: 1, subtotal: 48, unitsPerBox: 24 }]);
    expect(await quote(c, p, 1)).toEqual({ subtotal: 2, priceSource: "SOURCE_INVOICE" });
  }, 30_000);

  it("D5 (C2): sold at 10.00 outside the window, today 12.00: the credit is the paid 10.00", async () => {
    const p = await newProduct(12, null);
    const c = await soldTo([{ productId: p, qty: 1, subtotal: 10 }]);
    expect(await quote(c, p, 1)).toEqual({ subtotal: 10, priceSource: "SOURCE_INVOICE" });
  }, 30_000);
});
