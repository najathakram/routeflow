/**
 * #2118 — sales-facts timing script (plan A4 budget, plan §E "Performance").
 *
 * Seeds 100k invoice lines / 5k invoices / 2k credit notes / 300 returns into ONE tenant of a
 * LOCAL database, times the service call behind each product-insights endpoint, prints p50/p95,
 * EXPLAINs the four read paths the new indexes serve, deletes everything it seeded, and exits 1
 * when any JSON endpoint's p95 exceeds 300 ms or an index is not usable.
 *
 * Run from apps/api, against a LOCAL database only (refused otherwise):
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/<db> \
 *     npx ts-node --transpile-only -r tsconfig-paths/register scripts/sales-facts-timing.ts \
 *     [--tenant test] [--iterations 30] [--keep]
 *
 * Tenant: the approved `test` tenant (created, with a TenantConfig, when absent) — or any slug
 * `assertTestTenant` approves. Every seeded row carries this run's marker and is removed at the
 * end unless --keep. Measures service time (the controller adds only DTO validation).
 */
import { randomUUID } from "crypto";
import { performance } from "perf_hooks";
import { PrismaService } from "../src/prisma/prisma.service";
import { TenantContextService } from "../src/tenant/tenant-context.service";
import { requireLocalDatabaseUrl } from "../src/common/testing/db-spec";
import { SalesFactsService } from "../src/sales-facts/sales-facts.service";
import { ProductInsightsService } from "../src/sales-facts/product-insights.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const BUDGET_P95_MS = 300;
const INVOICES = 5_000;
const LINES_PER_INVOICE = 20; // → 100k lines
const PRODUCTS = 200;
const CUSTOMERS = 300;
const CREDIT_NOTES = 2_000;
const RETURNS = 300;
const MONTHS = 24;
const CHUNK = 2_000;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "true";
}

/** Deterministic PRNG so two runs seed the same shape. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(2118);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const money = (n: number) => Math.round(n * 100) / 100;

async function inChunks<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    await write(rows.slice(i, i + CHUNK));
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

async function main() {
  requireLocalDatabaseUrl();
  const slug = assertTestTenant(arg("tenant", "test") as string, "sales-facts-timing.ts");
  const iterations = Number(arg("iterations", "30"));
  const keep = arg("keep") === "true";
  const RUN = `T2118-${randomUUID().slice(0, 6)}`;

  const tenantCtx = new TenantContextService();
  const prisma = new PrismaService(tenantCtx);
  await prisma.$connect();
  const facts = new SalesFactsService(prisma);
  const insights = new ProductInsightsService(facts);

  const created = {
    tenant: false,
    config: false,
    users: [] as string[],
    customers: [] as string[],
    products: [] as string[],
    orders: [] as string[],
    invoices: [] as string[],
    creditNotes: [] as string[],
    returns: [] as string[],
  };

  let tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    tenant = await prisma.tenant.create({ data: { slug, name: `Timing ${slug}` } });
    created.tenant = true;
  }
  const tenantId = tenant.id;
  if (!(await prisma.tenantConfig.findUnique({ where: { tenantId } }))) {
    await prisma.tenantConfig.create({ data: { tenantId, timezone: "America/New_York" } });
    created.config = true;
  }

  try {
    const t0 = performance.now();
    console.log(`seeding ${RUN} into tenant "${slug}" …`);

    // Customers
    const customers = Array.from({ length: CUSTOMERS }, (_, i) => ({
      userId: randomUUID(),
      id: randomUUID(),
      name: `${RUN} Buyer ${i}`,
    }));
    await inChunks(customers, (chunk) =>
      prisma.user.createMany({
        data: chunk.map((c) => ({
          id: c.userId,
          email: `${c.userId}@example.invalid`,
          username: `${RUN}-${c.userId.slice(0, 8)}`,
          role: "CUSTOMER" as const,
          tenantId,
        })),
      }),
    );
    await inChunks(customers, (chunk) =>
      prisma.customer.createMany({
        data: chunk.map((c) => ({
          id: c.id,
          userId: c.userId,
          businessName: c.name,
          contactName: c.name,
          tenantId,
        })),
      }),
    );
    created.users = customers.map((c) => c.userId);
    created.customers = customers.map((c) => c.id);

    // Products: every third is boxed (12); HOT is on every invoice (the worst case).
    const products = Array.from({ length: PRODUCTS + 1 }, (_, i) => ({
      id: randomUUID(),
      sku: `${RUN}-P${i}`,
      unitsPerBox: i % 3 === 0 ? 12 : null,
      price: money(2 + rnd() * 40),
    }));
    const HOT = products[0];
    await prisma.product.createMany({
      data: products.map((p, i) => ({
        id: p.id,
        tenantId,
        name: `${RUN} Product ${i}`,
        sku: p.sku,
        unit: "case",
        pricePerUnit: p.price,
        unitsPerBox: p.unitsPerBox,
      })),
    });
    created.products = products.map((p) => p.id);

    // Invoices (+ orders), spread over the last 24 months; 5% written off, 5% void.
    const now = Date.now();
    const invoices = Array.from({ length: INVOICES }, (_, i) => {
      const daysAgo = Math.floor(rnd() * MONTHS * 30.4);
      const d = new Date(now - daysAgo * 86_400_000);
      const issueDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const r = rnd();
      return {
        id: randomUUID(),
        orderId: rnd() < 0.9 ? randomUUID() : null,
        customerId: pick(customers).id,
        number: `${RUN}-INV-${i}`,
        issueDate,
        status: r < 0.05 ? "WRITTEN_OFF" : r < 0.1 ? "VOID" : r < 0.55 ? "PAID" : "SENT",
      };
    });
    const orders = invoices.filter((inv) => inv.orderId);
    await inChunks(orders, (chunk) =>
      prisma.order.createMany({
        data: chunk.map((inv) => ({
          id: inv.orderId as string,
          customerId: inv.customerId,
          tenantId,
          orderNumber: `${inv.number}-O`,
        })),
      }),
    );
    created.orders = orders.map((o) => o.orderId as string);

    const items: any[] = [];
    const invoiceRows = invoices.map((inv) => {
      let subtotal = 0;
      for (let k = 0; k < LINES_PER_INVOICE; k++) {
        const p = k === 0 ? HOT : pick(products.slice(1));
        const boxed = p.unitsPerBox != null;
        const boxes = boxed ? 1 + Math.floor(rnd() * 4) : null;
        const pieces = boxed ? Math.floor(rnd() * 12) : null;
        const qty = boxed
          ? (boxes as number) * 12 + (pieces as number)
          : 1 + Math.floor(rnd() * 24);
        const lineTotal = boxed
          ? money(p.price * ((boxes as number) + (pieces as number) / 12))
          : money((p.price / 12) * qty);
        subtotal += lineTotal;
        items.push({
          id: randomUUID(),
          invoiceId: inv.id,
          tenantId,
          productId: p.id,
          description: "timing line",
          qty,
          unitPrice: boxed ? p.price : money(p.price / 12),
          subtotal: lineTotal,
          boxes,
          pieces,
          unitsPerBox: boxed ? 12 : null,
        });
      }
      subtotal = money(subtotal);
      return {
        id: inv.id,
        tenantId,
        customerId: inv.customerId,
        orderId: inv.orderId,
        invoiceNumber: inv.number,
        status: inv.status as any,
        issueDate: inv.issueDate,
        subtotal,
        total: subtotal,
      };
    });
    await inChunks(invoiceRows, (chunk) => prisma.invoice.createMany({ data: chunk }));
    created.invoices = invoiceRows.map((r) => r.id);
    await inChunks(items, (chunk) => prisma.invoiceItem.createMany({ data: chunk }));

    // Credit notes: half header-only, half itemized on one line of their invoice.
    const liveInvoices = invoices.filter((inv) => inv.status !== "VOID");
    const itemsByInvoice = new Map<string, any[]>();
    for (const it of items) {
      const arr = itemsByInvoice.get(it.invoiceId) ?? [];
      arr.push(it);
      itemsByInvoice.set(it.invoiceId, arr);
    }
    const cnRows: any[] = [];
    const cnItems: any[] = [];
    for (let i = 0; i < CREDIT_NOTES; i++) {
      const inv = pick(liveInvoices);
      const id = randomUUID();
      const createdAt = new Date(
        inv.issueDate.getTime() + (1 + Math.floor(rnd() * 20)) * 86_400_000,
      );
      if (i % 2 === 1) {
        const line = pick(itemsByInvoice.get(inv.id) as any[]);
        const amount = money(Math.min(Number(line.subtotal), 1 + rnd() * 10));
        cnRows.push({
          id,
          tenantId,
          customerId: inv.customerId,
          invoiceId: inv.id,
          creditNoteNumber: `${RUN}-CN-${i}`,
          amount,
          status: "ISSUED",
          createdAt,
        });
        cnItems.push({
          id: randomUUID(),
          tenantId,
          creditNoteId: id,
          invoiceItemId: line.id,
          amount,
          qty: 1,
        });
      } else {
        cnRows.push({
          id,
          tenantId,
          customerId: inv.customerId,
          invoiceId: inv.id,
          creditNoteNumber: `${RUN}-CN-${i}`,
          amount: money(1 + rnd() * 25),
          status: "ISSUED",
          createdAt,
        });
      }
    }
    await inChunks(cnRows, (chunk) => prisma.creditNote.createMany({ data: chunk }));
    await inChunks(cnItems, (chunk) => prisma.creditNoteItem.createMany({ data: chunk }));
    created.creditNotes = cnRows.map((r) => r.id);

    // Returns: STANDARD external refunds, credit-note returns (on the header-only notes), INLINE refunds.
    const headerOnly = cnRows.filter((_, i) => i % 2 === 0);
    const returnRows: any[] = [];
    const returnItems: any[] = [];
    const withOrder = invoices.filter((inv) => inv.orderId && inv.status !== "VOID");
    for (let i = 0; i < RETURNS; i++) {
      const inv = pick(withOrder);
      const id = randomUUID();
      const line = pick(itemsByInvoice.get(inv.id) as any[]);
      const at = new Date(inv.issueDate.getTime() + (2 + Math.floor(rnd() * 20)) * 86_400_000);
      const mode = i % 3;
      const cn = mode === 1 ? headerOnly[i] : null;
      returnRows.push({
        id,
        tenantId,
        customerId: inv.customerId,
        orderId: inv.orderId,
        returnNumber: `${RUN}-R-${i}`,
        reason: "DAMAGED",
        status: "REFUNDED",
        kind: mode === 2 ? "INLINE" : "STANDARD",
        refundMethod: mode === 1 ? "CREDIT_NOTE" : "EXTERNAL_REFUND",
        refundAmount: mode === 1 ? cn.amount : money(3 + rnd() * 10),
        refundedAt: mode === 1 ? cn.createdAt : at,
        creditNoteId: cn ? cn.id : null,
      });
      returnItems.push({
        id: randomUUID(),
        tenantId,
        returnId: id,
        productId: line.productId,
        qty: 1,
        subtotal: mode === 2 ? money(Math.min(Number(line.subtotal), 3)) : null,
        sourceInvoiceItemId: mode === 2 ? line.id : null,
      });
    }
    await inChunks(returnRows, (chunk) => prisma.return.createMany({ data: chunk }));
    await inChunks(returnItems, (chunk) => prisma.returnItem.createMany({ data: chunk }));
    created.returns = returnRows.map((r) => r.id);
    console.log(
      `seeded in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${items.length} lines, ${invoiceRows.length} invoices, ${cnRows.length} credit notes, ${returnRows.length} returns`,
    );
    await prisma.$executeRawUnsafe(
      `ANALYZE "Invoice", "InvoiceItem", "CreditNote", "CreditNoteItem", "Return", "ReturnItem"`,
    );

    // ── Timing ──────────────────────────────────────────────────────────────
    const typical = products[7];
    const aCustomer = invoices[0].customerId;
    const firstPage = await tenantCtx.run(tenantId, () =>
      insights.getProductSalesPage(HOT.id, { limit: 100 }),
    );
    const cases: [string, boolean, () => Promise<unknown>][] = [
      ["insights HOT 12 months (month)", true, () => insights.getProductInsights(HOT.id, {})],
      [
        "insights HOT 36 months (month)",
        true,
        () => insights.getProductInsights(HOT.id, { from: isoMonthsAgo(35), grain: "month" }),
      ],
      [
        "insights HOT 90 days (day)",
        true,
        () => insights.getProductInsights(HOT.id, { from: isoDaysAgo(89), grain: "day" }),
      ],
      ["insights typical 12 months", true, () => insights.getProductInsights(typical.id, {})],
      [
        "sales HOT page 1 (100 lines)",
        true,
        () => insights.getProductSalesPage(HOT.id, { limit: 100 }),
      ],
      [
        "sales HOT cursor page (100 lines)",
        true,
        () =>
          insights.getProductSalesPage(HOT.id, {
            limit: 100,
            cursor: firstPage.nextCursor ?? undefined,
          }),
      ],
      [
        "sales HOT one buyer",
        true,
        () =>
          insights.getProductSalesPage(HOT.id, { customerId: aCustomer, from: isoMonthsAgo(35) }),
      ],
      [
        "csv typical 12 months (streamed)",
        false,
        async () => {
          const { csv } = await insights.prepareCsvExport(typical.id, {});
          let n = 0;
          for await (const chunk of csv) n += chunk.length;
          return n;
        },
      ],
    ];
    let failed = false;
    console.log(
      `\n${"endpoint".padEnd(40)} ${"p50 ms".padStart(8)} ${"p95 ms".padStart(8)}  budget`,
    );
    for (const [name, gated, fn] of cases) {
      const samples: number[] = [];
      for (let i = 0; i < iterations + 3; i++) {
        const start = performance.now();
        // eslint-disable-next-line no-await-in-loop
        await tenantCtx.run(tenantId, fn);
        if (i >= 3) samples.push(performance.now() - start); // 3 warm-ups
      }
      samples.sort((a, b) => a - b);
      const p50 = percentile(samples, 0.5);
      const p95 = percentile(samples, 0.95);
      const over = gated && p95 > BUDGET_P95_MS;
      if (over) failed = true;
      console.log(
        `${name.padEnd(40)} ${p50.toFixed(1).padStart(8)} ${p95.toFixed(1).padStart(8)}  ${gated ? (over ? "OVER" : "ok") : "(report only)"}`,
      );
    }

    // ── EXPLAIN: the four read paths the new indexes serve ──────────────────
    const monthStart = new Date(Date.now() - 45 * 86_400_000);
    const monthEnd = new Date(Date.now() - 15 * 86_400_000);
    const pageLineIds = items.slice(0, 100).map((i) => i.id);
    const probes: [string, string, unknown[]][] = [
      [
        "CreditNote_tenantId_createdAt_idx",
        `SELECT id FROM "CreditNote" WHERE "tenantId" = $1 AND "status" <> 'VOID' AND "createdAt" >= $2 AND "createdAt" < $3`,
        [tenantId, monthStart, monthEnd],
      ],
      [
        "Return_tenantId_refundedAt_idx",
        `SELECT id FROM "Return" WHERE "tenantId" = $1 AND "refundMethod" = 'EXTERNAL_REFUND' AND "refundedAt" >= $2 AND "refundedAt" < $3`,
        [tenantId, monthStart, monthEnd],
      ],
      [
        "CreditNoteItem_invoiceItemId_idx",
        `SELECT "invoiceItemId", amount FROM "CreditNoteItem" WHERE "invoiceItemId" = ANY($1::text[])`,
        [pageLineIds],
      ],
      [
        "Invoice_customerId_issueDate_idx",
        `SELECT id FROM "Invoice" WHERE "customerId" = $1 AND "issueDate" >= $2 AND "issueDate" < $3`,
        [aCustomer, monthStart, monthEnd],
      ],
    ];
    for (const [index, sql, params] of probes) {
      const natural = await explain(prisma, sql, params, false);
      const forced = await explain(prisma, sql, params, true);
      const usedNatural = natural.includes(index);
      const usable = forced.includes(index);
      if (!usable) failed = true;
      console.log(
        `\n── ${index}: ${usedNatural ? "USED by the planner" : "not chosen at this size (seq scan cheaper)"}; ${usable ? "usable" : "NOT USABLE"}`,
      );
      console.log((usedNatural ? natural : forced).trim());
    }

    console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (!keep) await cleanup(prisma, tenantId, created);
    await prisma.$disconnect();
  }
}

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}
function isoMonthsAgo(n: number): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1)).toISOString().slice(0, 10);
}

async function explain(
  prisma: PrismaService,
  sql: string,
  params: unknown[],
  forceIndex: boolean,
): Promise<string> {
  return prisma.$transaction(async (tx: any) => {
    if (forceIndex) await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
    const rows: any[] = await tx.$queryRawUnsafe(`EXPLAIN (ANALYZE, COSTS OFF) ${sql}`, ...params);
    return rows.map((r) => r["QUERY PLAN"]).join("\n");
  });
}

async function cleanup(prisma: PrismaService, tenantId: string, c: any) {
  const del = async (ids: string[], fn: (chunk: string[]) => Promise<unknown>) => inChunks(ids, fn);
  await del(c.creditNotes, (ids) =>
    prisma.creditNoteItem.deleteMany({ where: { creditNoteId: { in: ids } } }),
  );
  await del(c.returns, (ids) => prisma.returnItem.deleteMany({ where: { returnId: { in: ids } } }));
  await del(c.returns, (ids) => prisma.return.deleteMany({ where: { id: { in: ids } } }));
  await del(c.creditNotes, (ids) => prisma.creditNote.deleteMany({ where: { id: { in: ids } } }));
  await del(c.invoices, (ids) =>
    prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: ids } } }),
  );
  await del(c.invoices, (ids) => prisma.invoice.deleteMany({ where: { id: { in: ids } } }));
  await del(c.orders, (ids) => prisma.order.deleteMany({ where: { id: { in: ids } } }));
  await del(c.products, (ids) => prisma.product.deleteMany({ where: { id: { in: ids } } }));
  await del(c.customers, (ids) => prisma.customer.deleteMany({ where: { id: { in: ids } } }));
  await del(c.users, (ids) => prisma.user.deleteMany({ where: { id: { in: ids } } }));
  if (c.config) await prisma.tenantConfig.deleteMany({ where: { tenantId } });
  if (c.tenant) await prisma.tenant.delete({ where: { id: tenantId } });
  console.log("cleanup: removed every row this run seeded");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
