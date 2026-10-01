/**
 * SA-619 PR-2c, cases 6 and 8: two static INVENTORIES of the writes that bypass tenant stamping.
 *
 *  case 8: `prisma.<tenantOwnedModel>.create | createMany | createManyAndReturn | upsert(` called on the
 *          BASE client (not forTenant() / forSystem() / a tx). Such a create gets no tenantId from the
 *          extension, so under TENANT_CONTEXT_ENFORCE it is invisible to the guard.
 *  case 6: raw SQL (`$executeRaw` / `$queryRaw` and the Unsafe forms are NOT blocked; 150+ sites hold
 *          advisory locks, SET LOCAL, set_config) that INSERTs / UPDATEs / DELETEs a tenant-owned table
 *          without naming a tenant column.
 *
 * Both lists may only SHRINK: a new site is a red verify that needs review; a stale entry (a site that
 * was converted) is red too, so the list cannot rot. Entries carry a `why`. Nothing here changes
 * behaviour.
 */
import * as fs from "fs";
import * as path from "path";
import { isTenantOwnedModel } from "./nested-tenant-walk";
import { segments } from "../common/testing/unscoped-write-scan";

const SRC_ROOT = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(SRC_ROOT, f).split(path.sep).join("/");
const code = (src: string) =>
  segments(src)
    .map((s) => (s.kind === "code" ? s.text : '""'))
    .join("");

const CREATE_OPS = "create|createMany|createManyAndReturn|upsert";

/** Base-client creates on tenant-owned models: `model.op` keys. */
export function scanBaseClientCreates(src: string): string[] {
  const out: string[] = [];
  const re = new RegExp(
    `\\bprisma\\s*\\.\\s*([a-z][A-Za-z0-9]*)\\s*\\.\\s*(${CREATE_OPS})\\s*[(<]`,
    "g",
  );
  for (const m of code(src).matchAll(re)) {
    const model = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    if (isTenantOwnedModel(model)) out.push(`${m[1]}.${m[2]}`);
  }
  return out;
}

const WRITE_SQL = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"([A-Za-z0-9_]+)"/gi;

/** Raw-SQL writes on tenant-owned tables whose statement names no tenant column. */
export function scanRawSqlWrites(src: string): string[] {
  const out: string[] = [];
  for (const seg of segments(src)) {
    if (seg.kind !== "literal") continue;
    for (const m of seg.text.matchAll(WRITE_SQL)) {
      if (!isTenantOwnedModel(m[1])) continue;
      if (/tenantId|tenant_id/i.test(seg.text)) continue;
      out.push(m[1]);
    }
  }
  return out;
}

type Inventory = Record<string, Record<string, number>>;
const tally = (keys: string[]) => {
  const o: Record<string, number> = {};
  for (const k of keys) o[k] = (o[k] ?? 0) + 1;
  return o;
};
const inventory = (scan: (s: string) => string[]): Inventory => {
  const out: Inventory = {};
  for (const f of walk(SRC_ROOT)) {
    const hits = scan(fs.readFileSync(f, "utf8"));
    if (hits.length) out[rel(f)] = tally(hits);
  }
  return out;
};

/**
 * file -> "model.op" -> count. WHY every entry is here: it is the audited state of the tree at PR-2c, NOT
 * a per-site approval. Each site's data still has to carry an explicit tenantId (or move to forTenant() /
 * forSystem()); that review is one service per commit with the owner, and the commit deletes its entry.
 * Unreviewed on purpose: each conversion (one service per commit) deletes its entry. */
const BASE_CLIENT_CREATES: Inventory = {
  "audit/audit.service.ts": { "auditLog.create": 1 },
  "auth/auth.service.ts": { "refreshToken.upsert": 1 },
  "auth/google-oauth.service.ts": { "refreshToken.upsert": 1 },
  "billing/billing-notification.service.ts": { "billingNotificationLog.create": 1 },
  "billing/billing.service.ts": { "auditLog.create": 2, "tenantSubscription.upsert": 2 },
  "billing/feature-config.service.ts": { "tenantFeatureConfig.upsert": 1 },
  "billing/feature-diff.service.ts": { "featureResolverDiff.create": 1 },
  "billing/feature-override.service.ts": { "tenantFeatureOverride.create": 1 },
  "billing/meter.service.ts": { "meterUsage.upsert": 1 },
  "bookkeeping/bookkeeping.service.ts": { "expenseCategory.createMany": 1 },
  "buyer/buyer-admin.service.ts": { "customerLink.create": 1 },
  "buyer/buyer.service.ts": { "customerLink.upsert": 2 },
  "crm/crm-connection.service.ts": { "crmConnection.upsert": 2 },
  "crm/gohighlevel/gohighlevel-poll.service.ts": { "crmHandoff.create": 1 },
  "customers/customers.service.ts": { "customerLink.upsert": 1, "tenantSubscription.upsert": 1 },
  "email/mailbox/mailbox-connection.service.ts": { "mailboxConnection.upsert": 1 },
  "invoices/invoices.service.ts": { "paymentCounter.upsert": 1 },
  "orders/merge-restriction-warning.ts": { "auditLog.create": 1 },
  "payment-requests/payment-requests.service.ts": { "buyerPaymentRequest.create": 2 },
  "platform-admin/platform-admin.service.ts": { "tenantConfig.upsert": 1, "user.create": 1 },
  "platform-admin/tenant-mirror.service.ts": { "contactPerson.create": 1 },
  "selling-restrictions/restricted-lines-flag.ts": { "auditLog.create": 1 },
  "stripe-connect/stripe-connect.service.ts": { "tenantStripeConnect.upsert": 2 },
  "system-config/settings.controller.ts": { "tenantConfig.upsert": 2 },
  "tenants/tenants.service.ts": { "tenantGoogleOAuth.upsert": 1 },
};
/** file -> table -> count. */
const RAW_SQL_WRITES: Inventory = {
  "credit-notes/credit-notes.service.ts": { AdvancePayment: 1 },
};

describe("case 8: base-client creates on tenant-owned models (inventory)", () => {
  const found = inventory(scanBaseClientCreates);

  it("the scan walks the API source (a wrong root would pass vacuously)", () => {
    expect(walk(SRC_ROOT).length).toBeGreaterThan(300);
  });

  it("every site is on the inventory, and every inventory entry is still a site", () => {
    expect(found).toEqual(BASE_CLIENT_CREATES);
  });

  it("every inventoried file exists (a renamed file cannot hide its entry)", () => {
    for (const f of Object.keys(BASE_CLIENT_CREATES))
      expect(fs.existsSync(path.join(SRC_ROOT, f))).toBe(true);
  });

  it.each([
    ["a plain create", "await this.prisma.customer.create({ data })", ["customer.create"]],
    ["a split call", "this.prisma\n  .order\n  .createMany({ data })", ["order.createMany"]],
    ["an upsert", "prisma.product.upsert({ where, create, update })", ["product.upsert"]],
    ["forTenant is NOT the base client", "this.prisma.forTenant().customer.create({ data })", []],
    ["a tx is NOT the base client", "tx.customer.create({ data })", []],
    ["a platform model is exempt", "this.prisma.tenant.create({ data })", []],
    ["a read is not a create", "this.prisma.customer.findMany({})", []],
    ["a comment is ignored", "// this.prisma.customer.create({})", []],
    ["a string is ignored", 'const s = "this.prisma.customer.create(";', []],
  ])("scanBaseClientCreates mutant: %s", (_n, src, want) => {
    expect(scanBaseClientCreates(src)).toEqual(want);
  });
});

describe("case 6: raw SQL writes on tenant-owned tables without a tenant column (inventory)", () => {
  const found = inventory(scanRawSqlWrites);

  it("every site is on the inventory, and every inventory entry is still a site", () => {
    expect(found).toEqual(RAW_SQL_WRITES);
  });

  it.each([
    [
      "an INSERT without tenantId",
      'await tx.$executeRaw`INSERT INTO "Invoice" ("id") VALUES (${id})`',
      ["Invoice"],
    ],
    [
      "an UPDATE without a tenant column",
      'tx.$executeRaw`UPDATE "Order" SET "total" = 1 WHERE "id" = ${id}`',
      ["Order"],
    ],
    ["a DELETE", 'tx.$executeRaw`DELETE FROM "Customer" WHERE "id" = ${id}`', ["Customer"]],
    [
      "a statement naming tenantId passes",
      'tx.$executeRaw`UPDATE "Order" SET "total" = 1 WHERE "id" = ${id} AND "tenantId" = ${t}`',
      [],
    ],
    ["a lock / set_config is ignored", "tx.$executeRaw`SELECT pg_advisory_xact_lock(${k})`", []],
    ["a platform table is exempt", 'tx.$executeRaw`UPDATE "Tenant" SET "name" = ${n}`', []],
    ["a SELECT is ignored", 'tx.$queryRaw`SELECT * FROM "Invoice"`', []],
  ])("scanRawSqlWrites mutant: %s", (_n, src, want) => {
    expect(scanRawSqlWrites(src)).toEqual(want);
  });
});
