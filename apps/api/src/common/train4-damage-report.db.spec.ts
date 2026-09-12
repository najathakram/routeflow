/**
 * TP2 (test-plan.md T6-T14) — `apps/api/scripts/report-train4-damage.mjs` against a REAL
 * Postgres. The script does not exist yet, so every test here fails on
 * `expect(run.status).toBe(0)` with `Expected: 0, Received: 1` (node cannot find the module) —
 * that is the documented red, not `ECONNREFUSED`/`DB-backed specs need DATABASE_URL`, which would
 * be an environment failure instead (test-plan.md §6, §10).
 *
 * The sibling `train4-damage-report-script.spec.ts` (TP1) covers the CLI contract and the
 * read-only/no-write-keyword source guarantees with no database at all (T1-T5). What only a real
 * database can prove is R1/R3/R4: that each of the seven sections counts EXACTLY its seeded
 * damage row and skips its seeded near-miss, that the output never leaks a tenant id/slug/email/
 * free-text marker, and that every bucket carries the labelled bound test-plan.md names.
 *
 * Seed data is test-plan.md §7, copied verbatim — the expected counts/ids below are the ORACLE
 * and are never derived from the script (L-090: a pin written from the thing under test proves
 * only self-consistency). Five throwaway tenants (`assertTestTenant("qa-damage-<sfx>-*")`):
 * tenant A carries every section except the B/C/D rows B216 needs to prove its per-tenant armed
 * bucket. Every timestamp sits days (or, for the B215 revision gaps, tens of seconds) away from
 * `NOW`, never forged relative to "now minus a plausible offset" (L-090/L-082's shape).
 *
 * SAFETY. Every row lives under one of the four `qa-damage-<sfx>-*` tenants (`assertTestTenant`),
 * and `afterAll` deletes exactly those tenants' rows, in FK order, tolerant of a half-seeded run.
 * The CLI is invoked with `--tenant <A,B,C,D>` on every call, so a stray row elsewhere in the
 * shared compose database can never inflate an exact count here.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`) — run via
 * `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- train4-damage-report"`.
 */
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/report-train4-damage.mjs");

const SPEC_NAME = "train4-damage-report.db.spec.ts";

// ─── Time constants (test-plan.md §7) — every stamp sits far from `NOW`, never a plausible
// "now minus a bit" that a slow CI runner could make ambiguous (L-090, L-082). ─────────────────
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const NOW = new Date();
const DEL = new Date(NOW.getTime() - 20 * DAY); // the removal stamp
const DONE = new Date(NOW.getTime() - 15 * DAY); // stop completion
const B0 = new Date(NOW.getTime() - 50 * DAY); // billing chain
const R0 = new Date(NOW.getTime() - 12 * DAY); // revisions

function at(base: Date, offsetMs: number): Date {
  return new Date(base.getTime() + offsetMs);
}

// ─── Tenants ────────────────────────────────────────────────────────────────────────────────────
const sfx = randomUUID().slice(0, 8);

const TENANT_A_ID = `qa-damage-${sfx}-tenant-a`;
const TENANT_B_ID = `qa-damage-${sfx}-tenant-b`;
const TENANT_C_ID = `qa-damage-${sfx}-tenant-c`;
const TENANT_D_ID = `qa-damage-${sfx}-tenant-d`;
const TENANT_E_ID = `qa-damage-${sfx}-tenant-e`;
const TENANT_IDS = [TENANT_A_ID, TENANT_B_ID, TENANT_C_ID, TENANT_D_ID, TENANT_E_ID];

const TENANT_A_SLUG = assertTestTenant(`qa-damage-${sfx}-a`, SPEC_NAME);
const TENANT_B_SLUG = assertTestTenant(`qa-damage-${sfx}-b`, SPEC_NAME);
const TENANT_C_SLUG = assertTestTenant(`qa-damage-${sfx}-c`, SPEC_NAME);
const TENANT_D_SLUG = assertTestTenant(`qa-damage-${sfx}-d`, SPEC_NAME);
const TENANT_E_SLUG = assertTestTenant(`qa-damage-${sfx}-e`, SPEC_NAME);
const TENANT_SLUGS = [TENANT_A_SLUG, TENANT_B_SLUG, TENANT_C_SLUG, TENANT_D_SLUG, TENANT_E_SLUG];

// Two armed-downgrade effective dates that separate a chronological sort from a defaulted one.
// B's lands on the second-next FRIDAY, E's two days earlier on a WEDNESDAY: E is chronologically
// FIRST, but LAST under `Array#sort()`'s default comparator, which stringifies each Date and so
// orders by WEEKDAY NAME. Under `Date#toString()`'s weekday order (Fri < Mon < Sat < Sun < Thu <
// Tue < Wed), "Fri" < "Wed" keeps the defaulted sort naming B whether the read-back weekdays land
// as Wed/Fri, Tue/Thu (a UTC+13/+14 host, one day earlier), or Thu/Sat (UTC-12, one day later) —
// so the fixture stays discriminating on any host offset. Noon local keeps the weekday intact on
// this host through the timestamp-without-time-zone read-back skew (Prisma stores the UTC wall
// clock, node-postgres reads it back as local time), which shifts the instant by the machine's
// offset; the day-shift-tolerant pair above is what keeps it discriminating everywhere else.
const ARMED_B_AT = (() => {
  const d = new Date(NOW.getTime());
  d.setDate(d.getDate() + 7 + ((5 - d.getDay() + 7) % 7)); // 5 = Friday
  d.setHours(12, 0, 0, 0);
  return d;
})();
const ARMED_E_AT = (() => {
  const d = new Date(ARMED_B_AT.getTime());
  d.setDate(d.getDate() - 2);
  return d;
})();

const SECRET = `SECRET-${sfx}`;

// ─── Users & customers (tenant A only — B/C/D carry nothing but B216's billing rows) ───────────
const U_LIVE_ID = randomUUID();
const U_131_ID = randomUUID();
const U_141_ID = randomUUID();
const U_141X_ID = randomUUID();
const U_STAFF_ID = randomUUID();
const U_STAFF2_ID = randomUUID();
const SEEDED_EMAILS = [U_LIVE_ID, U_131_ID, U_141_ID, U_141X_ID, U_STAFF_ID, U_STAFF2_ID].map(
  (id) => `${id}@example.invalid`,
);

const C_LIVE_ID = randomUUID();
const C131_ID = randomUUID();
const C141_ID = randomUUID();
const C141X_ID = randomUUID();

const LINK_141_ID = randomUUID();
const LINK_141X_ID = randomUUID();

// ─── B134: invoices un-sent by a failed at-door approval ───────────────────────────────────────
const O134A_ID = randomUUID();
const O134B_ID = randomUUID();
const O134C_ID = randomUUID();
const O134D_ID = randomUUID();
const O134E_ID = randomUUID();
const I134A_ID = randomUUID();
const I134B_ID = randomUUID();
const I134C_ID = randomUUID();
const I134D_ID = randomUUID();
const I134E_ID = randomUUID();
const CR134A_ID = randomUUID();
const CR134B_ID = randomUUID();
const CR134D_ID = randomUUID();
const CR134E_ID = randomUUID();
const AUDIT_LINE = (dateLabel: string) =>
  `${SECRET}\n[${dateLabel} — reverted to Draft: source order edited]`;

// ─── B135: at-door merges committed after the stop completed ───────────────────────────────────
const ROUTE_ID = randomUUID();
const ROUTE_STOP_ID = randomUUID();
const ROUTE_RUN_ID = randomUUID();
const RS1_ID = randomUUID();
const O135_ID = randomUUID();
const CR135A_ID = randomUUID();
const CR135B_ID = randomUUID();
const CR135C_ID = randomUUID();
const DM135A_ID = randomUUID();
const DM135B_ID = randomUUID();
const DM135C_ID = randomUUID();
const DM135D_ID = randomUUID();
const DM135E_ID = randomUUID();

// ─── B214: credit notes orphaned by invoice/order removal ──────────────────────────────────────
const CN_A_ID = randomUUID();
const CN_B_ID = randomUUID();
const CN_C_ID = randomUUID();
const CN_D_ID = randomUUID();
const CN_E_ID = randomUUID();

// ─── B215: staff merge folded twice under a replayed Idempotency-Key ───────────────────────────
const O215A_ID = randomUUID();
const O215B_ID = randomUUID();
const O215C_ID = randomUUID();
const O215D_ID = randomUUID();
const O215E_ID = randomUUID();
const O215F_ID = randomUUID();
const O215G_ID = randomUUID();

// ─── B216: pre-lapse downgrade applied after a Stripe reinstatement ────────────────────────────
const E1_ID = randomUUID();
const E2_ID = randomUUID();
const E3_ID = randomUUID();
const E4_ID = randomUUID();
const E5_ID = randomUUID();
const E6_ID = randomUUID();
const E7_ID = randomUUID();
const E8_ID = randomUUID();
const E9_ID = randomUUID();
const E10_ID = randomUUID();
const EB1_ID = randomUUID();
const EB2_ID = randomUUID();
const EC1_ID = randomUUID();
const EC2_ID = randomUUID();
const ED1_ID = randomUUID();
const EE1_ID = randomUUID();
const EE2_ID = randomUUID();

// ─── B131: removed customer's crons kept generating ────────────────────────────────────────────
const TPL131_ID = randomUUID();
const O131A_ID = randomUUID();
const O131B_ID = randomUUID();
const RI131_ID = randomUUID();
const I131A_ID = randomUUID();
const I131B_ID = randomUUID();
const I131C_ID = randomUUID();
const I131D_ID = randomUUID();

// ─── B141: removed customer's buyer kept access ────────────────────────────────────────────────
const O141A_ID = randomUUID();
const O141B_ID = randomUUID();
const O141C_ID = randomUUID();
const O141D_ID = randomUUID();
const BPR141A_ID = randomUUID();
const BPR141B_ID = randomUUID();

/** test-plan.md §7's snapshot-line shape: `{productId, name, qty, unitPrice:1, subtotal:qty, status}`. */
function snapshotOf(entries: { productId: string; qty: number }[]) {
  return {
    lineItems: entries.map((e) => ({
      productId: e.productId,
      name: `PRODUCT ${SECRET}`,
      qty: e.qty,
      unitPrice: 1,
      subtotal: e.qty,
      status: "PENDING",
    })),
  };
}

/** Every table this spec seeds, and which timestamp column T14 snapshots (§7's "the cascades
 * take BillingEvent and TenantSubscription" — those two are read here but deleted only via the
 * Tenant cascade). OrderRevision/BillingEvent carry no `updatedAt` column at all. */
const SNAPSHOT_TABLES: { table: string; timeCol: "updatedAt" | "createdAt" }[] = [
  { table: "Tenant", timeCol: "updatedAt" },
  { table: "User", timeCol: "updatedAt" },
  { table: "Customer", timeCol: "updatedAt" },
  { table: "CustomerLink", timeCol: "updatedAt" },
  { table: "Route", timeCol: "updatedAt" },
  { table: "RouteStop", timeCol: "updatedAt" },
  { table: "RouteRun", timeCol: "updatedAt" },
  { table: "RouteRunStop", timeCol: "updatedAt" },
  { table: "Order", timeCol: "updatedAt" },
  { table: "OrderRevision", timeCol: "createdAt" },
  { table: "ChangeRequest", timeCol: "updatedAt" },
  { table: "DeliveryMutation", timeCol: "updatedAt" },
  { table: "Invoice", timeCol: "updatedAt" },
  { table: "CreditNote", timeCol: "updatedAt" },
  { table: "OrderTemplate", timeCol: "updatedAt" },
  { table: "RecurringInvoice", timeCol: "updatedAt" },
  { table: "BuyerPaymentRequest", timeCol: "updatedAt" },
  { table: "TenantSubscription", timeCol: "updatedAt" },
  { table: "BillingEvent", timeCol: "createdAt" },
];

type Snapshot = Record<string, { n: number; t: string | null }>;

interface DamageReport {
  reportVersion: number;
  tenants: number;
  sections: Record<string, Record<string, unknown>>;
  labels: Record<string, Record<string, string>>;
  byTenant: Record<string, unknown>[];
}

describeDb("report-train4-damage.mjs — real Postgres (seeded damage vs. near-miss)", () => {
  // Nothing env-dependent at collection time (db-lane.db.spec.ts's rule): construction lives in
  // hooks so a skipped `describe` body never throws.
  let pool: Pool;
  let prisma: PrismaClient;
  let outDir: string;
  let jsonRun: { status: number | null; stdout: string; stderr: string };
  let humanRun: { status: number | null; stdout: string; stderr: string };
  let report: DamageReport | null;
  let snapshotBeforeCli: Snapshot;
  let snapshotAfterCli: Snapshot;
  // The two armed effective dates as the DATABASE holds them, read back with this spec's own
  // pool: the oracle for T10's ordering assertions must not be the script under test, and must
  // not be the in-memory JS Date either (Prisma writes the UTC wall clock into a
  // `timestamp without time zone` column, so the value node-postgres reads back is offset).
  let armedIsoB: string;
  let armedIsoE: string;

  function runCli(args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Same scrub as backfill-legacy-tenant-ids.db.spec.ts: the Railway proxy pair wins over
    // DATABASE_URL in resolveUrl(), so both families are stripped before every child run.
    for (const key of Object.keys(env)) {
      if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
    }
    env.DATABASE_URL = requireLocalDatabaseUrl();
    const res = spawnSync(process.execPath, [CLI, ...args], {
      cwd: API_DIR,
      encoding: "utf8",
      env,
      timeout: 120_000,
    });
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }

  async function snapshotAll(): Promise<Snapshot> {
    const out: Snapshot = {};
    for (const { table, timeCol } of SNAPSHOT_TABLES) {
      // Tenant's own primary key IS the tenant id — every other table filters by its
      // `tenantId` foreign key column instead.
      const idCol = table === "Tenant" ? "id" : "tenantId";
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n, max("${timeCol}") AS t FROM "${table}" WHERE "${idCol}" = ANY($1::text[])`,
        [TENANT_IDS],
      );
      out[table] = { n: rows[0].n, t: rows[0].t ? new Date(rows[0].t).toISOString() : null };
    }
    return out;
  }

  beforeAll(async () => {
    const databaseUrl = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: databaseUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    // ── Tenants ──────────────────────────────────────────────────────────────────────────────
    await prisma.tenant.create({
      data: { id: TENANT_A_ID, slug: TENANT_A_SLUG, name: `ACME ${SECRET} A`, status: "ACTIVE" },
    });
    await prisma.tenant.create({
      data: { id: TENANT_B_ID, slug: TENANT_B_SLUG, name: `ACME ${SECRET} B`, status: "ACTIVE" },
    });
    await prisma.tenant.create({
      data: { id: TENANT_C_ID, slug: TENANT_C_SLUG, name: `ACME ${SECRET} C`, status: "ACTIVE" },
    });
    await prisma.tenant.create({
      data: { id: TENANT_D_ID, slug: TENANT_D_SLUG, name: `ACME ${SECRET} D`, status: "ACTIVE" },
    });
    await prisma.tenant.create({
      data: { id: TENANT_E_ID, slug: TENANT_E_SLUG, name: `ACME ${SECRET} E`, status: "ACTIVE" },
    });

    // ── Users (tenant A) ─────────────────────────────────────────────────────────────────────
    for (const [id, role] of [
      [U_LIVE_ID, "CUSTOMER"],
      [U_131_ID, "CUSTOMER"],
      [U_141_ID, "CUSTOMER"],
      [U_141X_ID, "CUSTOMER"],
      [U_STAFF_ID, "OPERATOR"],
      [U_STAFF2_ID, "OPERATOR"],
    ] as const) {
      await prisma.user.create({
        data: {
          id,
          email: `${id}@example.invalid`,
          username: id,
          role,
          tenantId: TENANT_A_ID,
        },
      });
    }

    // ── Customers (tenant A) ─────────────────────────────────────────────────────────────────
    await prisma.customer.create({
      data: {
        id: C_LIVE_ID,
        userId: U_LIVE_ID,
        businessName: `ACME ${SECRET} Live`,
        contactName: `${SECRET} Contact`,
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.customer.create({
      data: {
        id: C131_ID,
        userId: U_131_ID,
        businessName: `ACME ${SECRET} 131`,
        contactName: `${SECRET} Contact`,
        tenantId: TENANT_A_ID,
        deletedAt: DEL,
      },
    });
    await prisma.customer.create({
      data: {
        id: C141_ID,
        userId: U_141_ID,
        businessName: `ACME ${SECRET} 141`,
        contactName: `${SECRET} Contact`,
        tenantId: TENANT_A_ID,
        deletedAt: DEL,
      },
    });
    await prisma.customer.create({
      data: {
        id: C141X_ID,
        userId: U_141X_ID,
        businessName: `ACME ${SECRET} 141x`,
        contactName: `${SECRET} Contact`,
        tenantId: TENANT_A_ID,
        deletedAt: DEL,
      },
    });

    // C131 has no link at all. C141 has an ACTIVE link (in scope for B141). C141x has a
    // DISCONNECTED link (out of scope — the near-miss that proves the status filter bites).
    await prisma.customerLink.create({
      data: {
        id: LINK_141_ID,
        customerId: C141_ID,
        tenantId: TENANT_A_ID,
        status: "ACTIVE",
        buyerAccountId: null,
      },
    });
    await prisma.customerLink.create({
      data: {
        id: LINK_141X_ID,
        customerId: C141X_ID,
        tenantId: TENANT_A_ID,
        status: "DISCONNECTED",
        disconnectedAt: DEL,
        disconnectedBy: "SELLER",
      },
    });

    // ── B134 ─────────────────────────────────────────────────────────────────────────────────
    for (const id of [O134A_ID, O134B_ID, O134C_ID, O134D_ID, O134E_ID]) {
      await prisma.order.create({ data: { id, customerId: C_LIVE_ID, tenantId: TENANT_A_ID } });
    }
    await prisma.changeRequest.create({
      data: {
        id: CR134A_ID,
        orderId: O134A_ID,
        tenantId: TENANT_A_ID,
        type: "ADD_ITEM",
        status: "PENDING",
        payload: { productId: "P1", qty: 1, boxes: null, pieces: null, productName: "Widget" },
      },
    });
    await prisma.changeRequest.create({
      data: {
        id: CR134B_ID,
        orderId: O134B_ID,
        tenantId: TENANT_A_ID,
        type: "ADD_ITEM",
        status: "APPROVED",
        resolution: "MERGED_AT_STOP",
        resolvedAt: at(NOW, -DAY),
        payload: { productId: "P1", qty: 1, boxes: null, pieces: null, productName: "Widget" },
      },
    });
    // O134c gets no ChangeRequest at all — noChangeRequestContext.
    await prisma.changeRequest.create({
      data: {
        id: CR134D_ID,
        orderId: O134D_ID,
        tenantId: TENANT_A_ID,
        type: "ADD_ITEM",
        status: "PENDING",
        payload: { productId: "P1", qty: 1, boxes: null, pieces: null, productName: "Widget" },
      },
    });
    await prisma.changeRequest.create({
      data: {
        id: CR134E_ID,
        orderId: O134E_ID,
        tenantId: TENANT_A_ID,
        type: "ADD_ITEM",
        status: "PENDING",
        payload: { productId: "P1", qty: 1, boxes: null, pieces: null, productName: "Widget" },
      },
    });

    await prisma.invoice.create({
      data: {
        id: I134A_ID,
        invoiceNumber: `INV-134A-${sfx}`,
        customerId: C_LIVE_ID,
        orderId: O134A_ID,
        status: "DRAFT",
        subtotal: 100,
        total: 100,
        internalNotes: AUDIT_LINE("9/1/2026"),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.invoice.create({
      data: {
        id: I134B_ID,
        invoiceNumber: `INV-134B-${sfx}`,
        customerId: C_LIVE_ID,
        orderId: O134B_ID,
        status: "DRAFT",
        subtotal: 10,
        total: 10,
        internalNotes: AUDIT_LINE("9/1/2026"),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.invoice.create({
      data: {
        id: I134C_ID,
        invoiceNumber: `INV-134C-${sfx}`,
        customerId: C_LIVE_ID,
        orderId: O134C_ID,
        status: "DRAFT",
        subtotal: 10,
        total: 10,
        internalNotes: AUDIT_LINE("9/1/2026"),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.invoice.create({
      data: {
        id: I134D_ID,
        invoiceNumber: `INV-134D-${sfx}`,
        customerId: C_LIVE_ID,
        orderId: O134D_ID,
        status: "SENT",
        subtotal: 10,
        total: 10,
        internalNotes: AUDIT_LINE("9/1/2026"),
        sentAt: NOW,
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.invoice.create({
      data: {
        id: I134E_ID,
        invoiceNumber: `INV-134E-${sfx}`,
        customerId: C_LIVE_ID,
        orderId: O134E_ID,
        status: "DRAFT",
        subtotal: 10,
        total: 10,
        internalNotes: SECRET, // no audit line at all — never matches the LIKE filter
        tenantId: TENANT_A_ID,
      },
    });

    // ── B135 ─────────────────────────────────────────────────────────────────────────────────
    await prisma.route.create({
      data: { id: ROUTE_ID, name: `Damage route ${sfx}`, tenantId: TENANT_A_ID },
    });
    await prisma.routeStop.create({
      data: { id: ROUTE_STOP_ID, routeId: ROUTE_ID, stopNumber: 1, tenantId: TENANT_A_ID },
    });
    await prisma.routeRun.create({
      data: {
        id: ROUTE_RUN_ID,
        routeId: ROUTE_ID,
        scheduledDate: DONE,
        status: "COMPLETED",
        completedAt: DONE,
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.routeRunStop.create({
      data: {
        id: RS1_ID,
        routeRunId: ROUTE_RUN_ID,
        routeStopId: ROUTE_STOP_ID,
        stopNumber: 1,
        status: "COMPLETED",
        completedAt: DONE,
        podPhotoUrls: [],
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.order.create({
      data: {
        id: O135_ID,
        customerId: C_LIVE_ID,
        routeRunStopId: RS1_ID,
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.changeRequest.create({
      data: {
        id: CR135A_ID,
        orderId: O135_ID,
        routeRunStopId: RS1_ID,
        tenantId: TENANT_A_ID,
        type: "ADD_ITEM",
        status: "APPROVED",
        resolution: "MERGED_AT_STOP",
        resolvedAt: at(DONE, 10 * MIN),
        payload: { productId: "P1", qty: 1, boxes: null, pieces: null, productName: "Widget" },
      },
    });
    await prisma.changeRequest.create({
      data: {
        id: CR135B_ID,
        orderId: O135_ID,
        routeRunStopId: RS1_ID,
        tenantId: TENANT_A_ID,
        type: "CHANGE_QTY",
        status: "APPROVED",
        resolution: "MERGED_AT_STOP",
        resolvedAt: at(DONE, -10 * MIN),
        payload: { orderItemId: randomUUID(), newQty: 2, productName: "Widget" },
      },
    });
    await prisma.changeRequest.create({
      data: {
        id: CR135C_ID,
        orderId: O135_ID,
        routeRunStopId: RS1_ID,
        tenantId: TENANT_A_ID,
        type: "NOTE",
        status: "APPROVED",
        resolution: "MERGED_AT_STOP",
        resolvedAt: at(DONE, 5 * MIN),
        payload: { text: `note ${SECRET}` },
      },
    });
    await prisma.deliveryMutation.create({
      data: {
        id: DM135A_ID,
        orderId: O135_ID,
        routeRunStopId: RS1_ID,
        type: "ADD_ON",
        createdAt: at(DONE, 10 * MIN + 2 * SEC),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.deliveryMutation.create({
      data: {
        id: DM135B_ID,
        orderId: O135_ID,
        routeRunStopId: RS1_ID,
        type: "DELIVERED",
        createdAt: at(DONE, 1 * SEC),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.deliveryMutation.create({
      data: {
        id: DM135C_ID,
        orderId: O135_ID,
        routeRunStopId: RS1_ID,
        type: "DELIVERED",
        createdAt: at(DONE, 10 * MIN + 3 * SEC),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.deliveryMutation.create({
      data: {
        id: DM135D_ID,
        orderId: O135_ID,
        routeRunStopId: RS1_ID,
        type: "ADD_ON",
        createdAt: at(DONE, 10 * MIN + 25 * SEC),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.deliveryMutation.create({
      data: {
        id: DM135E_ID,
        orderId: O135_ID,
        routeRunStopId: RS1_ID,
        // right type, before CR135A.resolvedAt — fails ONLY the lower bound
        type: "ADD_ON",
        createdAt: at(DONE, 5 * MIN),
        tenantId: TENANT_A_ID,
      },
    });

    // ── B214 ─────────────────────────────────────────────────────────────────────────────────
    await prisma.creditNote.create({
      data: {
        id: CN_A_ID,
        creditNoteNumber: `CN-A-${sfx}`,
        customerId: C_LIVE_ID,
        invoiceId: null,
        status: "ISSUED",
        amount: 50,
        amountUsed: 10,
        reason: `REASON ${SECRET}`,
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.creditNote.create({
      data: {
        id: CN_B_ID,
        creditNoteNumber: `CN-B-${sfx}`,
        customerId: C_LIVE_ID,
        invoiceId: null,
        status: "ISSUED",
        amount: 5,
        amountUsed: 0,
        expiresAt: at(NOW, -DAY),
        reason: `REASON ${SECRET}`,
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.creditNote.create({
      data: {
        id: CN_C_ID,
        creditNoteNumber: `CN-C-${sfx}`,
        customerId: C_LIVE_ID,
        invoiceId: null,
        status: "VOID",
        amount: 30,
        amountUsed: 0,
        reason: `REASON ${SECRET}`,
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.creditNote.create({
      data: {
        id: CN_D_ID,
        creditNoteNumber: `CN-D-${sfx}`,
        customerId: C_LIVE_ID,
        invoiceId: I134C_ID,
        status: "ISSUED",
        amount: 25,
        amountUsed: 0,
        reason: `REASON ${SECRET}`,
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.creditNote.create({
      data: {
        id: CN_E_ID,
        creditNoteNumber: `CN-E-${sfx}`,
        customerId: C_LIVE_ID,
        invoiceId: null,
        status: "APPLIED",
        amount: 20,
        amountUsed: 20,
        reason: `REASON ${SECRET}`,
        tenantId: TENANT_A_ID,
      },
    });

    // ── B215 ─────────────────────────────────────────────────────────────────────────────────
    await prisma.order.create({
      data: {
        id: O215A_ID,
        customerId: C_LIVE_ID,
        tenantId: TENANT_A_ID,
        idempotencyKey: `KEY-${SECRET}`,
      },
    });
    await prisma.order.create({
      data: { id: O215B_ID, customerId: C_LIVE_ID, tenantId: TENANT_A_ID },
    });
    await prisma.order.create({
      data: { id: O215C_ID, customerId: C_LIVE_ID, tenantId: TENANT_A_ID },
    });
    await prisma.order.create({
      data: { id: O215D_ID, customerId: C_LIVE_ID, tenantId: TENANT_A_ID },
    });
    await prisma.order.create({
      data: { id: O215E_ID, customerId: C_LIVE_ID, tenantId: TENANT_A_ID },
    });
    await prisma.order.create({
      data: { id: O215F_ID, customerId: C_LIVE_ID, tenantId: TENANT_A_ID },
    });
    await prisma.order.create({
      data: { id: O215G_ID, customerId: C_LIVE_ID, tenantId: TENANT_A_ID },
    });

    async function revision(
      orderId: string,
      revisionNumber: number,
      createdAt: Date,
      editedById: string,
      entries: { productId: string; qty: number }[],
      source = "EDIT",
      tenantId: string | null = TENANT_A_ID,
    ) {
      await prisma.orderRevision.create({
        data: {
          id: randomUUID(),
          orderId,
          revisionNumber,
          createdAt,
          editedById,
          editedByRole: "OPERATOR",
          source,
          snapshot: snapshotOf(entries),
          tenantId,
        },
      });
    }

    // O215a — confirmed double fold: r1 -> r2 (+10 min) -> r3 (+60 s), all by U_staff.
    await revision(O215A_ID, 1, R0, U_STAFF_ID, [{ productId: "P1", qty: 2 }]);
    await revision(O215A_ID, 2, at(R0, 10 * MIN), U_STAFF_ID, [
      { productId: "P1", qty: 4 },
      { productId: "P2", qty: 3 },
    ]);
    await revision(O215A_ID, 3, at(R0, 10 * MIN + 60 * SEC), U_STAFF_ID, [
      { productId: "P1", qty: 6 },
      { productId: "P2", qty: 6 },
    ]);

    // O215b — near-miss: the second gap is 300s, over the 120s window.
    await revision(O215B_ID, 1, R0, U_STAFF_ID, [{ productId: "P1", qty: 2 }]);
    await revision(O215B_ID, 2, at(R0, 10 * MIN), U_STAFF_ID, [{ productId: "P1", qty: 4 }]);
    await revision(O215B_ID, 3, at(R0, 10 * MIN + 300 * SEC), U_STAFF_ID, [
      { productId: "P1", qty: 6 },
    ]);

    // O215c — near-miss: same quantities as O215a, 30s final gap, but r3 is a DIFFERENT editor.
    await revision(O215C_ID, 1, R0, U_STAFF_ID, [{ productId: "P1", qty: 2 }]);
    await revision(O215C_ID, 2, at(R0, 10 * MIN), U_STAFF_ID, [
      { productId: "P1", qty: 4 },
      { productId: "P2", qty: 3 },
    ]);
    await revision(O215C_ID, 3, at(R0, 10 * MIN + 30 * SEC), U_STAFF2_ID, [
      { productId: "P1", qty: 6 },
      { productId: "P2", qty: 6 },
    ]);

    // O215d — unconfirmable: only two revisions (no baseline before r1), 20s gap.
    await revision(O215D_ID, 1, R0, U_STAFF_ID, [{ productId: "P1", qty: 3 }]);
    await revision(O215D_ID, 2, at(R0, 20 * SEC), U_STAFF_ID, [{ productId: "P1", qty: 6 }]);

    // O215e — near-miss: r1 has no P2 at all, so P2's delta in r2 has no baseline to confirm.
    // O215f near-miss: r1 and r3 are EDITs by the same editor 40s apart, but the at-door
    // CHANGE_REQUEST revision r2 sits BETWEEN them, so r3's predecessor is not an EDIT and no
    // pair forms. A source filter pushed into the window CTE would hide r2, pair r3 with r1
    // (P1 delta +2, covered by r1's qty 4) and wrongly count an unconfirmable pair.
    await revision(O215F_ID, 1, R0, U_STAFF_ID, [{ productId: "P1", qty: 4 }]);
    await revision(
      O215F_ID,
      2,
      at(R0, 20 * SEC),
      U_STAFF_ID,
      [{ productId: "P1", qty: 5 }],
      "CHANGE_REQUEST",
    );
    await revision(O215F_ID, 3, at(R0, 40 * SEC), U_STAFF_ID, [{ productId: "P1", qty: 6 }]);

    // O215g near-miss: r1 and r3 are EDITs by the same editor 40s apart, but r2 — a DIFFERENT
    // editor, 20s in — carries tenantId NULL (the column is nullable). A tenant predicate pushed
    // onto the revision's OWN column hides r2 from the window, pairs r3 with r1 (P1 delta +2,
    // covered by r1's qty 4) and wrongly counts an unconfirmable pair. Scoping the window by the
    // ORDER's tenant keeps r2 visible, so r3's predecessor is a different editor and no pair forms.
    await revision(O215G_ID, 1, R0, U_STAFF_ID, [{ productId: "P1", qty: 4 }]);
    await revision(
      O215G_ID,
      2,
      at(R0, 20 * SEC),
      U_STAFF2_ID,
      [{ productId: "P1", qty: 5 }],
      "EDIT",
      null,
    );
    await revision(O215G_ID, 3, at(R0, 40 * SEC), U_STAFF_ID, [{ productId: "P1", qty: 6 }]);

    await revision(O215E_ID, 1, R0, U_STAFF_ID, [{ productId: "P1", qty: 3 }]);
    await revision(O215E_ID, 2, at(R0, 20 * SEC), U_STAFF_ID, [
      { productId: "P1", qty: 3 },
      { productId: "P2", qty: 1 },
    ]);

    // ── B216 ─────────────────────────────────────────────────────────────────────────────────
    await prisma.tenantSubscription.create({
      data: { id: randomUUID(), tenantId: TENANT_A_ID, downgradeToPlanKey: null },
    });
    await prisma.tenantSubscription.create({
      data: {
        id: randomUUID(),
        tenantId: TENANT_B_ID,
        downgradeToPlanKey: "STARTER",
        downgradeEffectiveAt: ARMED_B_AT,
      },
    });
    await prisma.tenantSubscription.create({
      data: {
        id: randomUUID(),
        tenantId: TENANT_C_ID,
        downgradeToPlanKey: "STARTER",
        downgradeEffectiveAt: at(NOW, 6 * DAY),
      },
    });
    await prisma.tenantSubscription.create({
      data: {
        id: randomUUID(),
        tenantId: TENANT_D_ID,
        downgradeToPlanKey: "STARTER",
        downgradeEffectiveAt: at(NOW, 7 * DAY),
      },
    });
    // Tenant E: a SECOND armed-after-reinstatement tenant whose effective date is chronologically
    // EARLIER than tenant B's but sorts LATER as a string. It carries nothing else, so no other
    // section's counts move.
    await prisma.tenantSubscription.create({
      data: {
        id: randomUUID(),
        tenantId: TENANT_E_ID,
        downgradeToPlanKey: "STARTER",
        downgradeEffectiveAt: ARMED_E_AT,
      },
    });

    async function billingEvent(
      id: string,
      tenantId: string,
      type: string,
      createdAt: Date,
      // Prisma JSON input type: `Record<string, unknown>` is not assignable to InputJsonValue.
      payload: Prisma.InputJsonObject = {},
      amountDelta: number | null = null,
    ) {
      await prisma.billingEvent.create({
        data: { id, tenantId, type, payload, createdAt, amountDelta: amountDelta ?? undefined },
      });
    }

    // Tenant A: one applied-after-reinstatement chain (E1-E5), then a NOT-applied chain
    // (E6-E10) where the latest schedule (E8) falls AFTER the resume (E7).
    await billingEvent(E1_ID, TENANT_A_ID, "plan.downgrade_scheduled", B0);
    await billingEvent(E2_ID, TENANT_A_ID, "subscription.suspended", at(B0, DAY));
    await billingEvent(E3_ID, TENANT_A_ID, "subscription.resumed", at(B0, 2 * DAY), {
      source: "stripe",
      reason: "payment_succeeded",
    });
    await billingEvent(E5_ID, TENANT_A_ID, "seat.freed", at(B0, 3 * DAY - 1 * SEC), {
      quantity: 2,
    });
    await billingEvent(
      E4_ID,
      TENANT_A_ID,
      "plan.changed",
      at(B0, 3 * DAY),
      { fromPlan: "GROWTH", toPlan: "STARTER", scheduled: true, applied: true },
      -50,
    );
    await billingEvent(E6_ID, TENANT_A_ID, "plan.downgrade_scheduled", at(B0, 4 * DAY));
    await billingEvent(E7_ID, TENANT_A_ID, "subscription.resumed", at(B0, 5 * DAY), {
      source: "stripe",
      reason: "payment_succeeded",
    });
    await billingEvent(E8_ID, TENANT_A_ID, "plan.downgrade_scheduled", at(B0, 6 * DAY));
    await billingEvent(
      E9_ID,
      TENANT_A_ID,
      "plan.changed",
      at(B0, 7 * DAY),
      { scheduled: true, applied: true },
      -20,
    );
    await billingEvent(E10_ID, TENANT_A_ID, "plan.changed", at(B0, 8 * DAY), {
      fromPlan: "TEAM",
      toPlan: "STARTER",
    });

    // Tenant B: armed, and the resume comes AFTER the schedule -> armedAfterReinstatement.
    await billingEvent(EB1_ID, TENANT_B_ID, "plan.downgrade_scheduled", B0);
    await billingEvent(EB2_ID, TENANT_B_ID, "subscription.resumed", at(B0, DAY), {
      source: "stripe",
      reason: "payment_succeeded",
    });

    // Tenant C (near-miss): armed, but the schedule comes AFTER the resume -> neither bucket.
    await billingEvent(EC1_ID, TENANT_C_ID, "subscription.resumed", B0, {
      source: "stripe",
      reason: "payment_succeeded",
    });
    await billingEvent(EC2_ID, TENANT_C_ID, "plan.downgrade_scheduled", at(B0, DAY));

    // Tenant D: armed, a stripe resume, and NO schedule event at all -> armedOrderUnknown.
    await billingEvent(ED1_ID, TENANT_D_ID, "subscription.resumed", B0, {
      source: "stripe",
      reason: "payment_succeeded",
    });

    // Tenant E: same shape as tenant B, so a SECOND armedAfterReinstatement row.
    await billingEvent(EE1_ID, TENANT_E_ID, "plan.downgrade_scheduled", B0);
    await billingEvent(EE2_ID, TENANT_E_ID, "subscription.resumed", at(B0, DAY), {
      source: "stripe",
      reason: "payment_succeeded",
    });

    // ── B131 ─────────────────────────────────────────────────────────────────────────────────
    await prisma.orderTemplate.create({
      data: {
        id: TPL131_ID,
        customerId: C131_ID,
        name: `Template ${sfx}`,
        daysOfWeek: [],
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.order.create({
      data: {
        id: O131A_ID,
        customerId: C131_ID,
        templateId: TPL131_ID,
        createdAt: at(DEL, DAY),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.order.create({
      data: {
        id: O131B_ID,
        customerId: C131_ID,
        templateId: TPL131_ID,
        createdAt: at(DEL, -DAY),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.recurringInvoice.create({
      data: {
        id: RI131_ID,
        customerId: C131_ID,
        frequency: "MONTHLY",
        nextRunAt: at(NOW, 10 * DAY),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.invoice.create({
      data: {
        id: I131A_ID,
        invoiceNumber: `INV-131A-${sfx}`,
        customerId: C131_ID,
        recurringInvoiceId: RI131_ID,
        status: "SENT",
        subtotal: 20,
        total: 20,
        sentAt: at(DEL, DAY),
        createdAt: at(DEL, DAY),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.invoice.create({
      data: {
        id: I131B_ID,
        invoiceNumber: `INV-131B-${sfx}`,
        customerId: C131_ID,
        recurringInvoiceId: RI131_ID,
        status: "DRAFT",
        subtotal: 20,
        total: 20,
        createdAt: at(DEL, -DAY),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.invoice.create({
      data: {
        id: I131C_ID,
        invoiceNumber: `INV-131C-${sfx}`,
        customerId: C131_ID,
        status: "DRAFT",
        subtotal: 15,
        total: 15,
        createdAt: at(DEL, 2 * DAY),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.invoice.create({
      data: {
        id: I131D_ID,
        invoiceNumber: `INV-131D-${sfx}`,
        customerId: C_LIVE_ID,
        status: "DRAFT",
        subtotal: 15,
        total: 15,
        createdAt: at(DEL, 2 * DAY),
        tenantId: TENANT_A_ID,
      },
    });

    // ── B141 ─────────────────────────────────────────────────────────────────────────────────
    await prisma.order.create({
      data: {
        id: O141A_ID,
        customerId: C141_ID,
        createdAt: at(DEL, -5 * DAY),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.orderRevision.create({
      data: {
        id: randomUUID(),
        orderId: O141A_ID,
        revisionNumber: 1,
        createdAt: at(DEL, HOUR),
        editedById: U_141_ID,
        editedByRole: "CUSTOMER",
        snapshot: {},
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.order.create({
      data: {
        id: O141B_ID,
        customerId: C141_ID,
        templateId: null,
        createdAt: at(DEL, 2 * HOUR),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.order.create({
      data: {
        id: O141C_ID,
        customerId: C141_ID,
        createdAt: at(DEL, -3 * DAY),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.orderRevision.create({
      data: {
        id: randomUUID(),
        orderId: O141C_ID,
        revisionNumber: 1,
        createdAt: at(DEL, -2 * DAY),
        editedById: U_141_ID,
        editedByRole: "CUSTOMER",
        snapshot: {},
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.order.create({
      data: {
        id: O141D_ID,
        customerId: C141X_ID,
        createdAt: at(DEL, 2 * HOUR),
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.orderRevision.create({
      data: {
        id: randomUUID(),
        orderId: O141D_ID,
        revisionNumber: 1,
        createdAt: at(DEL, 3 * HOUR),
        editedById: U_141X_ID,
        editedByRole: "CUSTOMER",
        snapshot: {},
        tenantId: TENANT_A_ID,
      },
    });
    await prisma.buyerPaymentRequest.create({
      data: {
        id: BPR141A_ID,
        tenantId: TENANT_A_ID,
        customerId: C141_ID,
        kind: "CASH",
        amount: 12.5,
        createdAt: at(DEL, 3 * HOUR),
      },
    });
    await prisma.buyerPaymentRequest.create({
      data: {
        id: BPR141B_ID,
        tenantId: TENANT_A_ID,
        customerId: C141_ID,
        kind: "CASH",
        amount: 99,
        // Not PENDING/SETTLING: the schema's partial unique index (invariant 8, one open
        // request per tenant+customer) would otherwise collide with BPR141a above.
        status: "REJECTED",
        createdAt: at(DEL, -DAY),
      },
    });

    // Snapshot right after seeding, BEFORE either CLI run — T14's "before" side.
    const armedBack = await pool.query(
      'SELECT "tenantId", "downgradeEffectiveAt" AS t FROM "TenantSubscription" WHERE "tenantId" = ANY($1::text[])',
      [[TENANT_B_ID, TENANT_E_ID]],
    );
    const armedByTenant = new Map<string, Date>(
      armedBack.rows.map((r: { tenantId: string; t: Date }) => [r.tenantId, r.t]),
    );
    armedIsoB = armedByTenant.get(TENANT_B_ID)!.toISOString();
    armedIsoE = armedByTenant.get(TENANT_E_ID)!.toISOString();

    snapshotBeforeCli = await snapshotAll();

    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "train4-damage-"));
    jsonRun = runCli(["--json", "--tenant", TENANT_IDS.join(",")]);
    humanRun = runCli(["--tenant", TENANT_IDS.join(","), "--out-dir", outDir]);
    report = jsonRun.status === 0 ? (JSON.parse(jsonRun.stdout) as DamageReport) : null;

    snapshotAfterCli = await snapshotAll();
  }, 180_000);

  afterAll(async () => {
    if (!pool) return;
    const t = [TENANT_IDS];
    // FK order (test-plan.md §7): children before parents; BillingEvent/TenantSubscription are
    // cascade-deleted by the Tenant delete, never removed directly.
    await pool.query('DELETE FROM "DeliveryMutation" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "ChangeRequest" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "OrderRevision" WHERE "tenantId" = ANY($1::text[])', t);
    // O215g's middle revision carries tenantId NULL by design, so the tenant-scoped removal above
    // cannot see it. Take it by orderId rather than leaning on the Order cascade.
    await pool.query('DELETE FROM "OrderRevision" WHERE "orderId" = $1', [O215G_ID]);
    await pool.query('DELETE FROM "CreditNote" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "BuyerPaymentRequest" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "Invoice" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "Order" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "RecurringInvoice" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "OrderTemplate" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "RouteRunStop" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "RouteRun" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "RouteStop" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "Route" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "CustomerLink" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "Customer" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "User" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "Tenant" WHERE "id" = ANY($1::text[])', t);

    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });

    await prisma?.$disconnect();
    await pool?.end();
  }, 180_000);

  it("TDR-T6 B134 buckets", () => {
    expect(jsonRun.status).toBe(0);
    const s = report!.sections.B134 as Record<string, unknown>;
    expect(s.candidates).toBe(1);
    expect(s.candidateInvoiceIds).toEqual([I134A_ID]);
    expect(s.candidateTotal).toBe(100);
    expect(s.mergedAtStopContext).toBe(1);
    expect(s.noChangeRequestContext).toBe(1);

    const labels = report!.labels.B134;
    expect(labels.candidates).toBe("UPPER_BOUND");
    expect(labels.mergedAtStopContext).toBe("CONTEXT");
    expect(labels.noChangeRequestContext).toBe("CONTEXT");
  });

  it("TDR-T7 B135 late merges", () => {
    expect(jsonRun.status).toBe(0);
    const s = report!.sections.B135 as Record<string, unknown>;
    expect(s.lateMerges).toBe(1);
    expect(s.changeRequestIds).toEqual([CR135A_ID]);
    expect(s.mutationIds).toEqual([DM135A_ID]);
    expect(s.lateNoteContext).toBe(1);

    const labels = report!.labels.B135;
    expect(labels.lateMerges).toBe("LOWER_BOUND");
    expect(labels.lateNoteContext).toBe("CONTEXT");
  });

  it("TDR-T8 B214 orphaned notes", () => {
    expect(jsonRun.status).toBe(0);
    const s = report!.sections.B214 as Record<string, unknown>;
    expect(s.orphaned).toBe(2);
    // Order-insensitive: the oracle here is WHICH two notes are orphaned, so a red means a
    // counting/selection bug, never the script's choice of output ordering.
    expect([...(s.creditNoteIds as string[])].sort()).toEqual([CN_A_ID, CN_B_ID].sort());
    expect(s.spendable).toBe(1);
    expect(s.spendableRemaining).toBe(40);
    expect(s.expired).toBe(1);
    expect(s.expiredRemaining).toBe(5);

    expect(report!.labels.B214.orphaned).toBe("UPPER_BOUND");
    expect(report!.labels.B214.spendableRemaining).toBe("UPPER_BOUND");
    expect(report!.labels.B214.expiredRemaining).toBe("CONTEXT");
  });

  it("TDR-T9 B215 double folds", () => {
    expect(jsonRun.status).toBe(0);
    const s = report!.sections.B215 as Record<string, unknown>;
    expect(s.confirmedPairs).toBe(1);
    expect(s.confirmedOrderIds).toEqual([O215A_ID]);
    expect(s.unconfirmablePairs).toBe(1);
    expect(s.unconfirmableOrderIds).toEqual([O215D_ID]);
    expect(s.keyedOrders).toBe(1);
    // O215f: a CHANGE_REQUEST revision between two EDITs by the same editor is NOT a pair.
    expect(s.confirmedOrderIds as string[]).not.toContain(O215F_ID);
    expect(s.unconfirmableOrderIds as string[]).not.toContain(O215F_ID);
    // O215g: the intervening revision carries tenantId NULL. It must still be visible to LAG under
    // `--tenant`, so r3's predecessor is a different editor and no pair forms.
    expect(s.confirmedOrderIds as string[]).not.toContain(O215G_ID);
    expect(s.unconfirmableOrderIds as string[]).not.toContain(O215G_ID);

    const labels = report!.labels.B215;
    expect(labels.confirmedPairs).toBe("ESTIMATE");
    expect(labels.unconfirmablePairs).toBe("UPPER_BOUND");
    expect(labels.keyedOrders).toBe("CONTEXT");
  });

  it("TDR-T10 B216 reinstated downgrades", () => {
    expect(jsonRun.status).toBe(0);
    const s = report!.sections.B216 as Record<string, unknown>;
    expect(s.appliedAfterReinstatement).toBe(1);
    expect(s.planChangedEventIds).toEqual([E4_ID]);
    expect(s.mrrDeltaSum).toBe(-50);
    expect(s.seatsFreedNear).toBe(2);
    expect(s.armedAfterReinstatement).toBe(2);
    expect(s.armedOrderUnknown).toBe(1);
    expect(Array.isArray(s.armedTenantOrdinals)).toBe(true);
    expect((s.armedTenantOrdinals as unknown[]).length).toBe(2);
    for (const ord of s.armedTenantOrdinals as string[]) expect(ord).toMatch(/^#\d+$/);

    // Tenant E's downgrade is due BEFORE tenant B's, so it leads armedEffectiveDates...
    expect(new Date(armedIsoE).getTime()).toBeLessThan(new Date(armedIsoB).getTime());
    expect(s.armedEffectiveDates).toEqual([armedIsoE, armedIsoB]);
    // ...but only a NUMERIC sort puts it there: `Array#sort()`'s default comparator stringifies
    // each Date and orders by weekday name, which is what this fixture is built to expose.
    expect([new Date(armedIsoE), new Date(armedIsoB)].sort()[0].toISOString()).toBe(armedIsoB);
    // B216 fixture must stay discriminating — see comment above ARMED_B_AT.
    const weekdayE = new Date(armedIsoE).toString().slice(0, 3);
    const weekdayB = new Date(armedIsoB).toString().slice(0, 3);
    expect([weekdayE, weekdayB].sort()[0]).toBe(weekdayB);

    // The line the owner acts on names the EARLIEST armed downgrade, as an ISO timestamp.
    expect(humanRun.stdout).toContain(`ACT BEFORE ${armedIsoE}`);
    expect(humanRun.stdout).not.toContain(`ACT BEFORE ${armedIsoB}`);

    const labels = report!.labels.B216;
    expect(labels.appliedAfterReinstatement).toBe("ESTIMATE");
    expect(labels.armedAfterReinstatement).toBe("UPPER_BOUND");
    expect(labels.armedOrderUnknown).toBe("UPPER_BOUND");
  });

  it("TDR-T11 B131 removed-customer generation", () => {
    expect(jsonRun.status).toBe(0);
    const s = report!.sections.B131 as Record<string, unknown>;
    expect(s.templateOrders).toBe(1);
    expect(s.templateOrderIds).toEqual([O131A_ID]);
    expect(s.recurringInvoices).toBe(1);
    expect(s.recurringInvoiceIds).toEqual([I131A_ID]);
    expect(s.recurringInvoicesEmailed).toBe(1);
    expect(s.manualInvoices).toBe(1);
    expect(s.manualInvoiceIds).toEqual([I131C_ID]);

    const labels = report!.labels.B131;
    expect(labels.templateOrders).toBe("LOWER_BOUND");
    expect(labels.recurringInvoices).toBe("LOWER_BOUND");
    expect(labels.manualInvoices).toBe("UPPER_BOUND");
  });

  it("TDR-T12 B141 post-removal buyer activity", () => {
    expect(jsonRun.status).toBe(0);
    const s = report!.sections.B141 as Record<string, unknown>;
    expect(s.customerSideEdits).toBe(1);
    expect(s.customerSideEditOrderIds).toEqual([O141A_ID]);
    expect(s.unmarkedOrdersUpperBound).toBe(1);
    expect(s.unmarkedOrderIds).toEqual([O141B_ID]);
    expect(s.buyerPaymentRequests).toBe(1);
    expect(s.buyerPaymentRequestIds).toEqual([BPR141A_ID]);
    expect(s.buyerPaymentRequestAmount).toBe(12.5);

    const labels = report!.labels.B141;
    expect(labels.customerSideEdits).toBe("LOWER_BOUND");
    expect(labels.unmarkedOrdersUpperBound).toBe("UPPER_BOUND");
    expect(labels.buyerPaymentRequests).toBe("LOWER_BOUND");
  });

  it("TDR-T13 output carries no identifiers", () => {
    expect(jsonRun.status).toBe(0);
    expect(humanRun.status).toBe(0);

    const forbidden = [SECRET, ...TENANT_IDS, ...TENANT_SLUGS, ...SEEDED_EMAILS];
    const jsonBlob = jsonRun.stdout;
    const humanBlob = humanRun.stdout + humanRun.stderr;

    for (const needle of forbidden) {
      expect(jsonBlob).not.toContain(needle);
      expect(humanBlob).not.toContain(needle);
    }

    expect(report!.tenants).toBe(5);
    for (const row of report!.byTenant) {
      expect((row as Record<string, unknown>).tenant as string).toMatch(/^#\d+$/);
    }

    const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);
    // EVERY `.jsonl` written under --out-dir is scanned: a second file must not be a leak hole.
    const lines = files.flatMap((file) =>
      fs
        .readFileSync(path.join(outDir, file), "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0),
    );
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
      for (const needle of forbidden) expect(line).not.toContain(needle);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed.class).toBe("string");
      expect(typeof parsed.bucket).toBe("string");
      expect(typeof parsed.label).toBe("string");
      // Ordinal only — `toBeDefined()` would pass for a leaked slug or for `null`.
      expect(parsed.tenant).toMatch(/^#\d+$/);
    }

    for (const section of ["B134", "B135", "B214", "B215", "B216", "B131", "B141"]) {
      expect(humanBlob).toContain(section);
    }
    expect(humanBlob).toContain("READ-ONLY");

    // Every bucket the section table labels is printed WITH its label, including the four that
    // are amounts/dates rather than plain counts, and every monetary total appears too.
    expect(humanBlob).toMatch(/spendableRemaining: 40\s+\[UPPER_BOUND\]/);
    expect(humanBlob).toMatch(/expiredRemaining: 5\s+\[CONTEXT\]/);
    expect(humanBlob).toMatch(/recurringInvoicesEmailed: \d+\s+\[LOWER_BOUND\]/);
    expect(humanBlob).toMatch(/earliestKeyedOrderAt: .*\[CONTEXT\]/);
    expect(humanBlob).toMatch(/candidateTotal=100/);
    expect(humanBlob).toMatch(/mrrDeltaSum=-50/);
    expect(humanBlob).toMatch(/buyerPaymentRequestAmount=12\.5/);
  });

  it("TDR-T14 run leaves the database unchanged", () => {
    expect(jsonRun.status).toBe(0);
    expect(humanRun.status).toBe(0);

    for (const { table } of SNAPSHOT_TABLES) {
      expect(snapshotAfterCli[table]).toEqual(snapshotBeforeCli[table]);
    }

    // "Nothing changed" alone is also true of a stub that queries nothing, so the same run this
    // snapshot pair measured must ALSO have read the seeded rows: parse its own stdout and pin
    // one query-only value plus the fixture tenant count.
    const measured = JSON.parse(jsonRun.stdout) as DamageReport;
    expect(measured.sections.B214.orphaned).toBe(2);
    expect(measured.tenants).toBe(5);
  });
});
