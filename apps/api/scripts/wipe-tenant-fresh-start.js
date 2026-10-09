#!/usr/bin/env node
// Tenant-scoped "scrub for fresh start" wipe.
//
// KEEPS: Tenant row, TenantConfig, TenantGoogleOAuth, TenantSubscription,
//        TenantAddon, SystemConfig, User (operator login), UserPreference,
//        Driver, MileageRate, BuyerAccount + BuyerRefreshToken (platform-shared,
//        only the link to this tenant's customers is severed via CustomerLink).
//
// DELETES: every transactional + master-data row scoped to the tenant —
//          customers, products, orders, routes, runs, deliveries, invoices,
//          payments, credit notes, returns, expenses, suppliers, purchases,
//          vendor bills, estimates, recurring invoices, buyer favorites,
//          buyer merge requests, customer links, audit logs, messages,
//          payment counters, device tokens, refresh tokens, password reset
//          tokens, driver locations.
//
// Usage (#2500, SA-481 — exactly ONE path flag; neither is a usage error, exit 2):
//   Test tenant, local database (the only test-tenant path):
//     node apps/api/scripts/wipe-tenant-fresh-start.js <test-slug> --local [--execute]
//   Live tenant, client-requested fresh start — OWNER-RUN ONLY, Railway proxy only:
//     railway run --service postgres node apps/api/scripts/backup-production.mjs pre-fresh-start-<slug>
//     railway run --service postgres node apps/api/scripts/wipe-tenant-fresh-start.js <slug> \
//       --live-tenant-override --exclude-tenant <slug,...> [--execute --backup-taken]
//
// Dry run (row counts only) unless --execute. With --execute the operator types the slug back,
// then every delete runs inside one Prisma $transaction.
//
// PROTECTED targets (#2639, SA-547): a paying tenant (the MRR paying set) or one whose subscription
// is linked to Stripe is refused in EVERY mode unless --allow-paying-tenant; with the flag,
// --execute also asks for the typed phrase `WIPE PAYING <slug>` after the slug type-back.
//
// ONE target: the database URL is resolved once (lib/fresh-start-target.mjs) and that same value
// feeds the pg Pool, the redacted "DB:" banner (with its source) and the guard — the banner can
// never name a different database than the one wiped. --local accepts only a provably-local target
// (production-guard.js); --live-tenant-override dials only the Railway proxy variables, never a
// stray DATABASE_URL. --exclude-tenant names tenants that are never wiped in any mode (supplied at
// run time, never written into git) and is required on the live path.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const readline = require("readline");
const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
const { classifyDbTarget } = require("./lib/production-guard");

const USAGE =
  "Usage: node wipe-tenant-fresh-start.js <test-slug> --local [--execute]\n" +
  "   or (owner-run, under railway run): <slug> --live-tenant-override --exclude-tenant <slug,...> " +
  "[--execute --backup-taken]\n" +
  "   A paying or Stripe-linked target is refused in every mode unless --allow-paying-tenant\n" +
  "   (and --execute then also asks for the typed phrase WIPE PAYING <slug>).";

// Assigned once main() has resolved THE target; nothing dials before that.
let prisma;
let slug;
let execute;

// Ordered children-first for explicit FK safety. Each entry is the Prisma model
// name as it appears on the client (lowerCamel of the schema model name).
const NUKE_MODELS = [
  // 1. Leaf children of orders / invoices / routes / vendor bills / etc.
  "invoiceItem",
  "invoicePayment",
  "orderItem",
  "orderTemplateItem",
  "routeRunStop",
  "routeStop",
  "routeCustomer",
  "estimateItem",
  "vendorBillItem",
  "billPayment",
  "purchaseOrderItem",
  "returnItem",
  "recurringInvoiceItem",
  "expenseLineItem",
  "transactionItem",
  "customerTagAssignment",
  "stockLot",
  "stockMovement",
  "deliveryMutation",
  "productMapping",
  "customerPrice",
  "contactPerson",
  "customerComment",
  "customerDocument",
  "customerAddress",
  "auditLog",
  "message",
  "customerLink",
  "buyerFavorite",
  "driverLocation",
  "deviceToken",
  "refreshToken",

  // 2. Mid-level parents (now safe to remove since their items/lines went above).
  "invoice",
  "order",
  "orderTemplate",
  "routeRun",
  "route",
  "estimate",
  "vendorBill",
  "purchaseOrder",
  "returnRecord", // model is `Return` but `return` is a JS keyword — see resolveDelegate
  "recurringInvoice",
  "expense",
  "transaction",
  "payment",
  "advancePayment",
  "creditNote",
  "deliveryBatch",

  // 3. Master data the user explicitly wants gone.
  "customer",
  // #2717 M2 (SA-594): Recipe/RecipeComponent hold RESTRICT FKs into Product — children first.
  "recipeComponent",
  "recipe",
  "product",
  "supplier",
  "expenseCategory",
  "customerTag",
  "paymentCounter",
];

// Some Prisma model names map to JS-reserved or differently-cased delegates.
function resolveDelegate(name) {
  if (name === "returnRecord") return prisma.return;
  return prisma[name];
}

async function getTenant() {
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    console.error(`Tenant slug "${slug}" not found.`);
    process.exit(2);
  }
  return tenant;
}

async function countAll(tenantId) {
  const rows = [];
  for (const name of NUKE_MODELS) {
    const delegate = resolveDelegate(name);
    if (!delegate || typeof delegate.count !== "function") {
      rows.push({ model: name, count: "(no delegate)" });
      continue;
    }
    try {
      const n = await delegate.count({ where: { tenantId } });
      rows.push({ model: name, count: n });
    } catch (err) {
      rows.push({ model: name, count: `error: ${err.message.split("\n")[0]}` });
    }
  }
  return rows;
}

function printCounts(rows) {
  const max = Math.max(...rows.map((r) => r.model.length));
  let total = 0;
  for (const r of rows) {
    const pad = " ".repeat(max - r.model.length);
    console.log(`  ${r.model}${pad}  ${r.count}`);
    if (typeof r.count === "number") total += r.count;
  }
  console.log(`  ${"-".repeat(max + 12)}`);
  console.log(`  TOTAL ROWS TO DELETE: ${total}`);
  return total;
}

async function confirm(slugToType, what = "the tenant slug") {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      `\nType ${what} "${slugToType}" exactly to proceed (or anything else to abort): `,
      (answer) => {
        rl.close();
        resolve(answer.trim() === slugToType);
      },
    );
  });
}

// Each model maps to a list of relation paths from the model up to a row
// whose tenantId column is the source of truth. The delete filter becomes
// the OR of (child.tenantId == X) and one branch per path.
// Paths must be exhaustive — any Invoice that we want gone must be reachable
// from every InvoicePayment via at least one of its paths, otherwise the
// payment won't get deleted and the parent delete will FK-fail.
const CHILD_PATHS = {
  // Leaf children
  invoiceItem: [["invoice"], ["invoice", "customer"]],
  invoicePayment: [["invoice"], ["invoice", "customer"]],
  orderItem: [["order"], ["order", "customer"]],
  orderTemplateItem: [["template"], ["template", "customer"]],
  routeRunStop: [["routeRun"], ["routeRun", "route"]],
  routeStop: [["route"]],
  routeCustomer: [["route"], ["customer"]],
  estimateItem: [["estimate"], ["estimate", "customer"]],
  vendorBillItem: [["vendorBill"], ["vendorBill", "supplier"]],
  billPayment: [["vendorBill"], ["vendorBill", "supplier"]],
  purchaseOrderItem: [["po"], ["po", "supplier"]],
  returnItem: [
    ["return"],
    ["return", "customer"],
    ["return", "order"],
    ["return", "order", "customer"],
  ],
  recurringInvoiceItem: [["recurringInvoice"], ["recurringInvoice", "customer"]],
  expenseLineItem: [
    ["expense"],
    ["expense", "category"],
    ["expense", "supplier"],
    ["expense", "customer"],
  ],
  transactionItem: [["transaction"], ["transaction", "customer"]],
  customerTagAssignment: [["customer"]],
  stockLot: [["product"]],
  stockMovement: [["product"], ["supplier"]],
  deliveryMutation: [["order"], ["order", "customer"]],
  productMapping: [["product"]],
  customerPrice: [["customer"]],
  contactPerson: [["customer"]],
  customerComment: [["customer"]],
  customerDocument: [["customer"]],
  customerAddress: [["customer"]],
  customerLink: [["customer"]],
  buyerFavorite: [["customer"]],
  // Mid-level rows that are themselves children of master tables
  invoice: [["customer"]],
  order: [["customer"]],
  orderTemplate: [["customer"]],
  estimate: [["customer"]],
  vendorBill: [["supplier"]],
  purchaseOrder: [["supplier"]],
  returnRecord: [["customer"], ["order"], ["order", "customer"]],
  recurringInvoice: [["customer"]],
  expense: [["category"], ["supplier"], ["customer"]],
  transaction: [["customer"]],
  advancePayment: [["customer"]],
  creditNote: [["customer"]],
  deliveryBatch: [["customer"]],
};

function buildPathFilter(path, tenantId) {
  let inner = { tenantId };
  for (let i = path.length - 1; i >= 0; i--) {
    inner = { [path[i]]: inner };
  }
  return inner;
}

function buildWhere(modelName, tenantId) {
  const paths = CHILD_PATHS[modelName];
  if (!paths || paths.length === 0) return { tenantId };
  const branches = [{ tenantId }, ...paths.map((p) => buildPathFilter(p, tenantId))];
  return { OR: branches };
}

async function nuke(tenantId) {
  const results = await prisma.$transaction(
    async (tx) => {
      const out = [];
      for (const name of NUKE_MODELS) {
        const delegate = name === "returnRecord" ? tx.return : tx[name];
        if (!delegate || typeof delegate.deleteMany !== "function") {
          out.push({ name, count: 0, skipped: true });
          continue;
        }
        const r = await delegate.deleteMany({ where: buildWhere(name, tenantId) });
        out.push({ name, count: r.count });
      }
      return out;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  let total = 0;
  for (const r of results) {
    console.log(`  ${r.name.padEnd(30)} ${r.skipped ? "(skipped)" : `deleted ${r.count}`}`);
    if (!r.skipped) total += r.count;
  }
  console.log(`\n  Total rows deleted: ${total}`);
  return total;
}

(async () => {
  const { parseFreshStartArgs, planFreshStart, checkExcludedTenants, checkProtectedTarget } =
    await import("./lib/fresh-start-target.mjs");
  const { resolveDatabaseUrl, redactUrl } = await import("./lib/railway-db-url.mjs");
  const args = parseFreshStartArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    process.exit(2);
  }
  // #2500: THE target — one resolution feeds the Pool, the banner and the guard below.
  const target = planFreshStart(args, process.env, {
    resolve: resolveDatabaseUrl,
    redact: redactUrl,
    classifyLocal: (url, env) => classifyDbTarget(url, env),
    isTestTenant,
  });
  if (!target.ok) {
    console.error(target.reason);
    if (target.exit === 2) console.error(USAGE);
    process.exit(target.exit);
  }
  slug = args.slug;
  execute = args.execute;
  prisma = new PrismaClient({ adapter: new PrismaPg(new Pool(target.poolConfig)) });

  console.log(`\n${target.banner}`);
  if (target.backupCommand) console.log(`Backup: ${target.backupCommand}`);
  console.log(`Tenant: ${slug}`);
  console.log(`Mode:   ${execute ? "EXECUTE (DESTRUCTIVE)" : "DRY-RUN (counts only)"}\n`);

  const tenant = await getTenant();
  // #2639 (lead's Opus HIGH-2): ids only in every output — a business name is a client identifier.
  console.log(`Resolved tenant: id=${tenant.id}\n`);

  // #2508 F1: every excluded slug must name a tenant in THIS database (same client), and the
  // target is refused by id, all BEFORE any count or write.
  const found = args.exclude.length
    ? await prisma.tenant.findMany({
        where: { slug: { in: args.exclude } },
        select: { id: true, slug: true, name: true },
      })
    : [];
  const exclusion = checkExcludedTenants({ exclude: args.exclude, found, tenant });
  if (!exclusion.ok) {
    console.error(exclusion.reason);
    await prisma.$disconnect();
    process.exit(1);
  }
  for (const line of exclusion.lines) console.log(line);
  if (exclusion.lines.length) console.log("");

  // #2639 / SA-547: a paying or Stripe-linked target is refused in EVERY mode unless
  // --allow-paying-tenant — read from THIS database (same client), before any count or write.
  const sub = await prisma.tenantSubscription.findUnique({
    where: { tenantId: tenant.id },
    select: { planKey: true, stripeSubId: true, couponFull: true },
  });
  const guard = checkProtectedTarget({ tenant, sub, allowPayingTenant: args.allowPayingTenant });
  if (!guard.ok) {
    console.error(guard.reason);
    await prisma.$disconnect();
    process.exit(1);
  }
  if (guard.line) console.log(`${guard.line}\n`);

  console.log("Row counts in nuke scope:");
  const rows = await countAll(tenant.id);
  const total = printCounts(rows);

  if (!execute) {
    console.log("\nDry-run complete. Re-run with --execute to actually delete.");
    await prisma.$disconnect();
    return;
  }

  if (total === 0) {
    console.log("\nNothing to delete.");
    await prisma.$disconnect();
    return;
  }

  const ok = await confirm(slug);
  if (!ok) {
    console.log("\nAborted.");
    await prisma.$disconnect();
    process.exit(3);
  }
  // #2639 / SA-547: a protected target (flag given) needs a SECOND, distinct typed phrase.
  if (guard.phrase && !(await confirm(guard.phrase, "the phrase"))) {
    console.log("\nAborted: the protected-tenant confirmation did not match.");
    await prisma.$disconnect();
    process.exit(3);
  }

  console.log("\nExecuting wipe in a single transaction...\n");
  await nuke(tenant.id);
  console.log("\nDone. Tenant shell, operator login, drivers, and settings preserved.");

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error("\nFATAL:", err);
  if (prisma) await prisma.$disconnect();
  process.exit(99);
});
