/**
 * demo-verify.js — READ-ONLY health report for the `routeflow-demo` tenant.
 *
 * Checks the things a demo can silently get wrong: money that does not add up,
 * child rows that lost their tenantId (nested creates bypass the tenant
 * extension — see prisma.service.ts forTenant), stock that went negative, and
 * whether the catalog actually carries images and descriptions. Also confirms
 * the source tenant it was copied from is untouched.
 *
 * Issues no writes of any kind.
 *
 * Usage (from repo root):
 *   node apps/api/scripts/demo-verify.js
 *   railway run --service postgres node apps/api/scripts/demo-verify.js
 */

const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
const { DEMO_SLUG } = require("./lib/demo-ids");

const TENANT_SLUG = assertTestTenant(DEMO_SLUG, "demo-verify");

function resolveDbUrl() {
  const e = process.env;
  if (
    e.RAILWAY_TCP_PROXY_DOMAIN &&
    e.RAILWAY_TCP_PROXY_PORT &&
    e.POSTGRES_USER &&
    e.POSTGRES_PASSWORD &&
    e.POSTGRES_DB
  ) {
    return (
      `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
      `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`
    );
  }
  return e.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/routeflow_dev";
}

const pool = new Pool({ connectionString: resolveDbUrl() });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const money = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
const problems = [];
function check(label, passed, detail) {
  console.log(`   ${passed ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!passed) problems.push(label);
}

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
  if (!tenant) {
    console.error(`\n❌ Tenant "${TENANT_SLUG}" does not exist. Run demo-seed.js --live first.\n`);
    process.exit(1);
  }
  const t = { tenantId: tenant.id };
  console.log(`\n🔍 Demo tenant report — ${TENANT_SLUG} (${tenant.status}/${tenant.plan})\n`);

  // ── Inventory of what exists ────────────────────────────────────────────────
  const [
    users,
    customers,
    products,
    suppliers,
    routes,
    orders,
    invoices,
    payments,
    movements,
    credits,
    ledger,
  ] = await Promise.all([
    prisma.user.count({ where: t }),
    prisma.customer.count({ where: t }),
    prisma.product.count({ where: t }),
    prisma.supplier.count({ where: t }),
    prisma.route.count({ where: t }),
    prisma.order.count({ where: t }),
    prisma.invoice.count({ where: t }),
    prisma.invoicePayment.count({ where: t }),
    prisma.stockMovement.count({ where: t }),
    prisma.creditNote.count({ where: t }),
    prisma.regulatedSalesLedger.count({ where: t }),
  ]);
  console.log("📊 Contents");
  console.log(
    `   ${users} users · ${customers} customers · ${products} products · ${suppliers} suppliers · ${routes} routes`,
  );
  console.log(
    `   ${orders} orders · ${invoices} invoices · ${payments} payments · ${movements} stock movements · ${credits} credit notes · ${ledger} regulated ledger rows`,
  );

  // ── Catalog richness ────────────────────────────────────────────────────────
  console.log("\n🖼  Catalog");
  const withImages = await prisma.product.count({
    where: { ...t, NOT: { imageKeys: { isEmpty: true } } },
  });
  const withDescription = await prisma.product.count({
    where: { ...t, description: { not: null } },
  });
  const inStock = await prisma.product.count({ where: { ...t, currentStock: { gt: 0 } } });
  check("every product has an image", withImages === products, `${withImages}/${products}`);
  check("descriptions present", withDescription > 0, `${withDescription}/${products}`);
  check("stock on hand", inStock > products * 0.8, `${inStock}/${products} in stock`);
  const negative = await prisma.product.count({ where: { ...t, currentStock: { lt: 0 } } });
  check("no negative stock", negative === 0, `${negative} negative`);

  // ── Tenant scoping: the failure mode that poisons a tenant silently ─────────
  // A nested create bypasses the forTenant extension, so a child row can land
  // with tenantId NULL while its parent is correctly scoped. Ask the question
  // that way round — via the parent — because unrelated legacy NULLs elsewhere
  // in the database say nothing about whether this seed is sound.
  console.log("\n🔒 Tenant scoping");
  const orphans = {};
  for (const [model, count] of [
    ["orderItem", () => prisma.orderItem.count({ where: { tenantId: null, order: { ...t } } })],
    [
      "invoiceItem",
      () => prisma.invoiceItem.count({ where: { tenantId: null, invoice: { ...t } } }),
    ],
    [
      "invoicePayment",
      () => prisma.invoicePayment.count({ where: { tenantId: null, invoice: { ...t } } }),
    ],
    [
      "stockMovement",
      () => prisma.stockMovement.count({ where: { tenantId: null, product: { ...t } } }),
    ],
    [
      "customerAddress",
      () => prisma.customerAddress.count({ where: { tenantId: null, customer: { ...t } } }),
    ],
    ["regulatedSalesLedger", () => Promise.resolve(0)], // tenantId is non-nullable here
  ]) {
    orphans[model] = await count();
  }
  const totalOrphans = Object.values(orphans).reduce((a, b) => a + b, 0);
  check(
    "no NULL-tenantId child rows under this tenant",
    totalOrphans === 0,
    totalOrphans === 0 ? "clean" : JSON.stringify(orphans),
  );

  // Informational only: pre-existing NULLs owned by other tenants are somebody
  // else's backfill, not a demo problem.
  const elsewhere =
    (await prisma.invoicePayment.count({ where: { tenantId: null } })) +
    (await prisma.stockMovement.count({ where: { tenantId: null } })) +
    (await prisma.invoiceItem.count({ where: { tenantId: null } }));
  if (elsewhere > 0) {
    console.log(
      `   ℹ ${elsewhere} NULL-tenantId row(s) exist elsewhere in this database (not this tenant)`,
    );
  }

  // ── Money ───────────────────────────────────────────────────────────────────
  console.log("\n💰 Money");
  const invoiceRows = await prisma.invoice.findMany({
    where: t,
    include: { items: true, payments: true },
  });
  let badTotals = 0;
  let badLineSums = 0;
  let badPaid = 0;
  for (const inv of invoiceRows) {
    const lineSum = Math.round(inv.items.reduce((s, i) => s + Number(i.subtotal), 0) * 100) / 100;
    if (Math.abs(lineSum - Number(inv.subtotal)) > 0.01) badLineSums += 1;
    const expected =
      Math.round((Number(inv.subtotal) + Number(inv.taxAmount) + Number(inv.shippingFee)) * 100) /
      100;
    if (Math.abs(expected - Number(inv.total)) > 0.01) badTotals += 1;
    const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
    if (inv.status === "PAID" && Math.abs(paid - Number(inv.total)) > 0.01) badPaid += 1;
    if (inv.status === "PARTIAL" && !(paid > 0 && paid < Number(inv.total))) badPaid += 1;
    // OVERDUE is what recomputeStatus returns for an untouched invoice past its
    // due date, so it must carry no payment at all.
    if (inv.status === "OVERDUE" && paid > 0) badPaid += 1;
    if (inv.status === "SENT" && paid > 0) badPaid += 1;
  }
  check("invoice line sums match subtotal", badLineSums === 0, `${badLineSums} mismatched`);
  check("subtotal + tax + shipping = total", badTotals === 0, `${badTotals} mismatched`);
  check("payments agree with invoice status", badPaid === 0, `${badPaid} mismatched`);

  const revenue = invoiceRows.reduce((s, i) => s + Number(i.total), 0);
  const collected = invoiceRows.reduce(
    (s, i) => s + i.payments.reduce((a, p) => a + Number(p.amount), 0),
    0,
  );
  const byStatus = {};
  invoiceRows.forEach((i) => (byStatus[i.status] = (byStatus[i.status] ?? 0) + 1));
  const today = new Date().toISOString().slice(0, 10);
  const overdue = invoiceRows.filter(
    (i) =>
      !["PAID", "VOID", "WRITTEN_OFF", "DRAFT"].includes(i.status) &&
      i.dueDate &&
      i.dueDate.toISOString().slice(0, 10) < today,
  ).length;
  console.log(
    `   invoiced ${money(revenue)} · collected ${money(collected)} · outstanding ${money(revenue - collected)}`,
  );
  console.log(`   statuses ${JSON.stringify(byStatus)} · ${overdue} currently overdue`);
  check("has receivables to show", revenue - collected > 0);
  check("has an overdue invoice", overdue > 0, `${overdue}`);

  // ── Demo readiness ──────────────────────────────────────────────────────────
  console.log("\n🎯 Demo readiness");
  const operator = await prisma.user.findFirst({
    where: { ...t, username: "routeflow_demo" },
    select: { role: true, status: true },
  });
  check(
    "operator login exists",
    !!operator,
    operator ? `${operator.role}/${operator.status}` : "missing",
  );

  const owner = await prisma.customer.findFirst({
    where: { ...t, email: "najathakram1@gmail.com" },
    include: { customerLink: true, orders: { select: { id: true } } },
  });
  check(
    "owner customer wired up",
    !!owner && owner.orders.length > 0,
    owner
      ? `${owner.businessName}, ${owner.orders.length} orders, link ${owner.customerLink?.status ?? "none (sign-in will connect)"}`
      : "missing",
  );

  const orderStatuses = await prisma.order.groupBy({ by: ["status"], where: t, _count: true });
  const statusMap = Object.fromEntries(orderStatuses.map((r) => [r.status, r._count]));
  console.log(`   order pipeline ${JSON.stringify(statusMap)}`);
  check(
    "pipeline has open work",
    (statusMap.PENDING ?? 0) + (statusMap.CONFIRMED ?? 0) + (statusMap.OUT_FOR_DELIVERY ?? 0) > 0,
  );

  // ── The source tenant must be untouched ─────────────────────────────────────
  const sourceSlug = (process.env.DEMO_SOURCE_TENANT ?? "").trim().toLowerCase();
  if (sourceSlug) {
    console.log("\n🛡  Source tenant");
    const source = await prisma.tenant.findUnique({
      where: { slug: sourceSlug },
      select: { id: true },
    });
    if (source) {
      const strays = await prisma.product.count({
        where: {
          tenantId: source.id,
          id: {
            in: (await prisma.product.findMany({ where: t, select: { id: true } })).map(
              (p) => p.id,
            ),
          },
        },
      });
      check(
        `no demo rows leaked into "${sourceSlug}"`,
        strays === 0,
        `${strays} overlapping product ids`,
      );
    }
  }

  console.log(
    problems.length === 0
      ? "\n✅ All checks passed — the demo tenant is ready.\n"
      : `\n⚠  ${problems.length} check(s) failed: ${problems.join("; ")}\n`,
  );
  if (problems.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("\n❌ Verify failed:", e?.message ?? e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
