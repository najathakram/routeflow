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
// Usage:
//   node apps/api/scripts/wipe-tenant-fresh-start.js <tenant-slug>
//   node apps/api/scripts/wipe-tenant-fresh-start.js <tenant-slug> --execute
//
// Without --execute the script prints row counts only (dry run).
// With --execute the script requires the operator to type the slug back to confirm,
// then runs all deletes inside one Prisma $transaction.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const readline = require("readline");
const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");

const dbUrl =
  process.env.DATABASE_PUBLIC_URL ||
  process.env.DATABASE_URL ||
  "postgresql://user:pass@localhost:5432/routeflow_dev";

const pool = new Pool({ connectionString: dbUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const slug = process.argv[2];
const execute = process.argv.includes("--execute");

if (!slug) {
  console.error("Missing tenant slug. Usage: node wipe-tenant-fresh-start.js <slug> [--execute]");
  process.exit(1);
}

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

async function confirm(slugToType) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      `\nType the tenant slug "${slugToType}" exactly to proceed (or anything else to abort): `,
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
  const dbUrl = (process.env.DATABASE_URL || "").replace(/:\/\/[^@]*@/, "://***:***@");
  console.log(`\nDB:     ${dbUrl}`);
  console.log(`Tenant: ${slug}`);
  console.log(`Mode:   ${execute ? "EXECUTE (DESTRUCTIVE)" : "DRY-RUN (counts only)"}\n`);

  const tenant = await getTenant();
  console.log(`Resolved tenant: ${tenant.name} (id=${tenant.id})\n`);

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

  console.log("\nExecuting wipe in a single transaction...\n");
  await nuke(tenant.id);
  console.log("\nDone. Tenant shell, operator login, drivers, and settings preserved.");

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error("\nFATAL:", err);
  await prisma.$disconnect();
  process.exit(99);
});
