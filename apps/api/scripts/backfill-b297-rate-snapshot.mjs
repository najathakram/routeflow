// B297 PR6 (SA-734r2 D3 / L2 / MED-2): the PROVABLE rate-snapshot backfill for regulated lines. Owner-run,
// dry-run first. It writes ONLY the category and rate-trio columns of a line (`trackedCategoryId`,
// `categoryTaxType`, `categoryTaxRate`, `categoryPriceIncludesTax`) — never an amount, quantity, subtotal or
// total — and only where the stored `categoryTaxAmount` PROVES the value it would copy.
//
//   TRIO        a regulated line (`trackedCategoryId` set) whose trio is NULL (any one NULL counts, R4):
//               the trio is set to the category's CURRENT values ONLY where
//               computeCategoryTax(current trio, the line's own basis) === the stored amount (the line
//               proves it was priced at this rate); left NULL otherwise.
//   L2-ORDER    an OrderItem with `trackedCategoryId` NULL and a non-zero `categoryTaxAmount` (the B767
//               shape): `trackedCategoryId` + the trio are copied from its matching invoice lines
//               (same `orderItemId`, non-VOID invoice). EVERY contributing invoice line must name the same
//               category and agree on a full trio (R2); only when the copied trio's recompute at the ORDER
//               line's basis equals the stored amount. Otherwise left and listed.
//   L2-INVOICE  (MED-2) the twin: an InvoiceItem with no category and a non-zero amount copies from its
//               order line (`orderItemId`) under the same proof, at the INVOICE line's basis.
//
// The arithmetic is production's own: `computeCategoryTax` + `regulatedUnitBasis` from @routeflow/pricing,
// the line's own pack (its `unitsPerBox` snapshot, else the product's). A line whose proof fails is LEFT and
// listed in the plan file (ids only); nothing is written for it. The LEFT list goes to the OWNER before any
// filing is LOCKED (PR5).
//
// DRY-RUN IS THE DEFAULT: a READ ONLY transaction, always rolled back. It saves a content-hashed plan
// (local-assets/handoff) that --apply later replays.
//
//   railway run --service postgres node apps/api/scripts/backfill-b297-rate-snapshot.mjs
//   DATABASE_URL=postgresql://…@localhost:5432/<db> node apps/api/scripts/backfill-b297-rate-snapshot.mjs --local
//   node apps/api/scripts/backfill-b297-rate-snapshot.mjs --self-test
//
// APPLY replays a SAVED plan only (never a live re-query):
//   node apps/api/scripts/backfill-b297-rate-snapshot.mjs --apply --plan <file> --confirm-plan <hash> \
//     --guard-sha <sha> --i-have-a-fresh-backup [--local] [--allow-protected <tenantId>]... \
//     [--live-tenant-override --confirm "APPLY <n> LINES" --yes-tenant <tenantId>...]
// Gates, ALL must pass or nothing is written (SA-134 / B681's set):
//   1. --confirm-plan equals the plan file's own sha256;
//   2. --guard-sha is a git ancestor of this checkout's HEAD (the PR3 code that stops new NULL lines);
//   3. the DB fingerprint (database, tenant ids) still matches the dry run;
//   4. a LIVE (non-test) tenant needs --live-tenant-override, the literal phrase, its own
//      --yes-tenant <tenantId> AND the tenant id typed back at a real terminal (stdin and stdout; a
//      non-TTY run refuses) — the owner's yes, per live tenant;
//   4b. a PROTECTED tenant (paying, Stripe-linked, or named in PROTECTED_TENANT_SLUGS) is HELD at the dry
//      run unless named with --allow-protected <tenantId>; the apply RE-DERIVES protection in its
//      transaction and, for every protected tenant it writes, needs --allow-protected plus a typed
//      "ALLOW PROTECTED <tenantId>" at a real terminal (live-target-guard.cjs). The plan file and the
//      logs carry tenant IDS and counts only — never slugs;
//   5. --i-have-a-fresh-backup, always;
//   6. every planned line is RE-READ under a row lock: its category, trio, amount, quantity and subtotal
//      must be unchanged — any change refuses the whole apply.
// One transaction. Exit: 0 ok · 1 refused (nothing written) · 2 env/connection error.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { isLocalDbTarget } from "./lib/local-db-target.cjs";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const require = createRequire(import.meta.url);
const {
  categoryTaxSnapshotOf,
  computeCategoryTax,
  regulatedUnitBasis,
  roundMoney,
} = require("@routeflow/pricing");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
const { protectedArm } = require("./lib/paying-tenant.cjs");
const { loadProtectedSlugs } = require("./lib/protected-slugs.cjs");
const {
  assertWritableTenant,
  confirmProtectedOverride,
  hasBackupAttestation,
  refuseRetiredFlags,
  ProtectedTenantError,
} = require("./lib/live-target-guard.cjs");

const TAG = "backfill-b297";
const PAGE = 500;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SELF = fileURLToPath(import.meta.url);

/** The two line tables that carry the trio. A table name reaches SQL only from this list. */
export const TABLES = ["OrderItem", "InvoiceItem"];

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const argvAll = (name) =>
  process.argv.flatMap((a, i, all) => (a === name && all[i + 1] !== undefined ? [all[i + 1]] : []));
const sha256 = (obj) => createHash("sha256").update(JSON.stringify(obj)).digest("hex");
const refuse = (msg) => Object.assign(new Error(msg), { refuse: true });
const cents = (n) => Math.round(roundMoney(Number(n) || 0) * 100);

// ─── pure: the proof ──────────────────────────────────────────────────────────

/** True when any of the three columns is NULL (R4: a partly NULL trio is NULL). */
export const trioIsNull = (l) =>
  l.categoryTaxType == null || l.categoryTaxRate == null || l.categoryPriceIncludesTax == null;

/** The recompute of `line` at `trio` (`{ taxType, rate, priceIncludesTax }`): production's own arithmetic. */
export function recomputeAt(line, trio) {
  const pack =
    line.unitsPerBox != null ? Number(line.unitsPerBox) : Number(line.productUnitsPerBox ?? 0);
  const unitBasisQty = regulatedUnitBasis(
    {
      qty: Number(line.qty) || 0,
      boxes: line.boxes,
      pieces: line.pieces,
      unitLabel: line.unitLabel,
    },
    pack,
  ).unitBasisQty;
  return computeCategoryTax({
    taxType: trio.taxType,
    rate: Number(trio.rate),
    unitBasisQty,
    lineSubtotal: Number(line.subtotal),
    priceIncludesTax: !!trio.priceIncludesTax,
  });
}

const provesAmount = (line, trio) =>
  cents(recomputeAt(line, trio)) === cents(line.categoryTaxAmount);

/**
 * A proof is WEAK when more than one 4-decimal rate reproduces the stored cents (a small basis): the line is
 * still proven (it matches production's own lazy stamp), but the owner reads the count. Per-unit types read
 * the piece basis, PERCENT_OF_SALE the subtotal; a step of 0.0001 moves the amount by < 1 cent below 100.
 */
function isWeakProof(line, trio) {
  const pack =
    line.unitsPerBox != null ? Number(line.unitsPerBox) : Number(line.productUnitsPerBox ?? 0);
  const basis =
    String(trio.taxType) === "PERCENT_OF_SALE"
      ? Math.abs(Number(line.subtotal))
      : regulatedUnitBasis(
          {
            qty: Number(line.qty) || 0,
            boxes: line.boxes,
            pieces: line.pieces,
            unitLabel: line.unitLabel,
          },
          pack,
        ).unitBasisQty;
  return basis * 0.0001 < 0.01;
}

/** A zero recompute at a non-zero rate proves nothing (a zero basis, a NONE type): the line is left. */
const isVacuous = (line, trio) => cents(recomputeAt(line, trio)) === 0 && Number(trio.rate) !== 0;

/**
 * TRIO mode, one line. `line` carries the live category columns (`liveTaxType`, `liveRate`,
 * `livePriceIncludesTax`). Returns { kind: "APPLY", set, rate0 } | { kind: "LEFT", reason } | null (out of scope).
 */
export function classifyTrio(line) {
  if (line.trackedCategoryId == null || !trioIsNull(line)) return null;
  if (line.liveTaxType == null) return { kind: "LEFT", reason: "category-unresolved" };
  const trio = {
    taxType: line.liveTaxType,
    rate: line.liveRate,
    priceIncludesTax: !!line.livePriceIncludesTax,
  };
  // The category must belong to the line's own tenant (a cross-tenant category id is never copied).
  if (
    line.categoryTenantId != null &&
    line.tenantId != null &&
    line.categoryTenantId !== line.tenantId
  ) {
    return { kind: "LEFT", reason: "cross-tenant" };
  }
  if (!provesAmount(line, trio)) {
    // An exempt customer's invoice line is re-zeroed by both invoice paths: its amount can never prove a rate.
    return { kind: "LEFT", reason: line.exempt ? "exempt" : "mismatch" };
  }
  if (isVacuous(line, trio)) return { kind: "LEFT", reason: "zero-basis" };
  const snap = categoryTaxSnapshotOf(trio);
  return {
    kind: "APPLY",
    set: {
      trackedCategoryId: line.trackedCategoryId,
      categoryTaxType: snap.categoryTaxType,
      categoryTaxRate: String(snap.categoryTaxRate),
      categoryPriceIncludesTax: snap.categoryPriceIncludesTax,
    },
    rate0: Number(trio.rate) === 0,
    weak: isWeakProof(line, trio),
  };
}

/** True when every source names the same category and a full, equal trio. */
export function sourcesAgree(sources, tenantId = null) {
  if (sources.length === 0) return { ok: false, reason: "no-match" };
  const [first, ...rest] = sources;
  if (first.trackedCategoryId == null) return { ok: false, reason: "no-category" };
  for (const s of sources) {
    if (s.trackedCategoryId == null) return { ok: false, reason: "no-category" };
    if (trioIsNull(s)) return { ok: false, reason: "source-trio-null" };
    // A counterpart or category of ANOTHER tenant is never copied.
    if (tenantId != null && s.tenantId != null && s.tenantId !== tenantId)
      return { ok: false, reason: "cross-tenant" };
    if (tenantId != null && s.categoryTenantId != null && s.categoryTenantId !== tenantId)
      return { ok: false, reason: "cross-tenant" };
  }
  for (const s of rest) {
    if (
      s.trackedCategoryId !== first.trackedCategoryId ||
      String(s.categoryTaxType) !== String(first.categoryTaxType) ||
      Number(s.categoryTaxRate) !== Number(first.categoryTaxRate) ||
      !!s.categoryPriceIncludesTax !== !!first.categoryPriceIncludesTax
    ) {
      return { ok: false, reason: "disagree" };
    }
  }
  return { ok: true, source: first };
}

/**
 * L2 mode, one no-category line with a non-zero amount, given its counterpart `sources` (the matching
 * invoice lines for an order line, the order line for an invoice line). APPLY only when they agree AND the
 * copied trio's recompute at THIS line's basis equals the stored amount.
 */
export function classifyL2(line, sources) {
  if (line.trackedCategoryId != null || cents(line.categoryTaxAmount) === 0) return null;
  const agreed = sourcesAgree(sources, line.tenantId ?? null);
  if (!agreed.ok) return { kind: "LEFT", reason: agreed.reason };
  const s = agreed.source;
  const trio = {
    taxType: s.categoryTaxType,
    rate: s.categoryTaxRate,
    priceIncludesTax: !!s.categoryPriceIncludesTax,
  };
  if (!provesAmount(line, trio)) return { kind: "LEFT", reason: "mismatch" };
  if (isVacuous(line, trio)) return { kind: "LEFT", reason: "zero-basis" };
  return {
    kind: "APPLY",
    set: {
      trackedCategoryId: s.trackedCategoryId,
      categoryTaxType: String(s.categoryTaxType),
      categoryTaxRate: String(s.categoryTaxRate),
      categoryPriceIncludesTax: !!s.categoryPriceIncludesTax,
    },
    rate0: Number(s.categoryTaxRate) === 0,
    weak: isWeakProof(line, trio),
  };
}

// ─── pure: protection / plan file (same shape as the B294 backfill) ───────────

const PROTECTION_SQL = `
  SELECT t.id, t.slug, t.status, t.class, t."deletedAt", s."planKey", s."stripeSubId"
  FROM "Tenant" t LEFT JOIN "TenantSubscription" s ON s."tenantId" = t.id
  WHERE t.id = ANY($1::text[])`;

/** Rows from PROTECTION_SQL -> Map<tenantId, arm> (protected only). */
export function protectedTenants(rows, protectedSlugs) {
  const out = new Map();
  for (const r of rows) {
    const arm = protectedArm(
      { slug: r.slug, status: r.status, class: r.class, deletedAt: r.deletedAt },
      { planKey: r.planKey, stripeSubId: r.stripeSubId },
      protectedSlugs,
    );
    if (arm) out.set(r.id, arm);
  }
  return out;
}

/** A protected tenant's writes are HELD unless the operator named its id. Ids and counts only. */
export function splitProtected(candidates, protectedById, allowedIds) {
  const apply = [];
  const held = [];
  for (const c of candidates) {
    if (!protectedById.has(c.tenantId) || allowedIds.has(c.tenantId)) apply.push(c);
    else
      held.push({
        table: c.table,
        id: c.id,
        tenantId: c.tenantId,
        arm: protectedById.get(c.tenantId),
      });
  }
  const admitted = [
    ...new Set(apply.filter((c) => protectedById.has(c.tenantId)).map((c) => c.tenantId)),
  ].sort();
  return { apply, held, admittedProtectedTenantIds: admitted };
}

/** The apply never trusts the plan: a tenant protected NOW that the plan did not admit refuses it all. */
export function payingGate({ admittedProtectedTenantIds, nowProtected }) {
  const admitted = new Set(admittedProtectedTenantIds ?? []);
  const turned = [...nowProtected.keys()].filter((id) => !admitted.has(id)).sort();
  if (turned.length) {
    return {
      ok: false,
      reason: `tenant(s) ${turned.join(", ")} became protected (paying / Stripe-linked / listed) since the dry run — re-run the dry run`,
    };
  }
  return { ok: true };
}

const UNHASHED_PLAN_KEYS = ["planHash", "review", "held"];
export function planFileOf(plan, review, held) {
  return { ...plan, planHash: sha256(plan), review, held };
}
export function verifyPlanFile(saved, confirmPlan) {
  const plan = Object.fromEntries(
    Object.entries(saved).filter(([k]) => !UNHASHED_PLAN_KEYS.includes(k)),
  );
  return sha256(plan) === confirmPlan && saved.planHash === confirmPlan ? plan : null;
}

/**
 * The live-tenant yes (SA: an owner yes per live tenant). `liveTenantIds` are the plan's non-test tenants.
 * Needs --live-tenant-override, the literal phrase for the plan's line count, and a --yes-tenant for each.
 */
/** The literal confirm phrase: the per-mode line counts the owner is approving. */
export const confirmPhrase = ({ trio, l2 }) => `APPLY TRIO ${trio} L2 ${l2} LINES`;

/** Per-mode line counts of a plan's apply list (TRIO vs the two L2 modes). */
export function modeCounts(apply) {
  const trio = apply.filter((a) => a.mode === "TRIO").length;
  return { trio, l2: apply.length - trio };
}

export function liveTenantGate({
  liveTenantIds,
  counts,
  override,
  confirm,
  yesTenants,
  typedTenants,
}) {
  if (liveTenantIds.length === 0) return { ok: true };
  const phrase = confirmPhrase(counts);
  if (!override || confirm !== phrase) {
    return {
      ok: false,
      reason: `${liveTenantIds.length} LIVE tenant(s) in this plan: pass --live-tenant-override --confirm "${phrase}" and --yes-tenant <tenantId> for each`,
    };
  }
  const yes = new Set(yesTenants);
  const missing = liveTenantIds.filter((id) => !yes.has(id)).sort();
  if (missing.length) {
    return { ok: false, reason: `no --yes-tenant for live tenant(s) ${missing.join(", ")}` };
  }
  // House policy for a live-tenant write: dry run first PLUS a type-back at a real terminal. The flag alone
  // (an automated session can pass it) is never enough; `typedTenants` is what `confirmLiveTenantYes` minted.
  const typed = new Set(typedTenants ?? []);
  const untyped = liveTenantIds.filter((id) => !typed.has(id)).sort();
  if (untyped.length) {
    return {
      ok: false,
      reason: `live tenant(s) ${untyped.join(", ")} not confirmed by typing the tenant id at a terminal`,
    };
  }
  return { ok: true };
}

function readlineAsk(stdin, stdout, question) {
  const readline = require("node:readline");
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    }),
  );
}

/**
 * The owner's yes for ONE live tenant: --yes-tenant <tenantId> naming it, AND the tenant id typed back at a
 * real terminal (stdin and stdout). Refuses when either is missing or not a TTY. Returns the tenant id.
 */
export async function confirmLiveTenantYes({
  tenantId,
  argv,
  stdin = process.stdin,
  stdout = process.stdout,
  ask,
}) {
  if (!argv.some((a, i) => a === "--yes-tenant" && argv[i + 1] === tenantId)) {
    throw refuse(`live tenant ${tenantId}: --yes-tenant must name this tenant's id`);
  }
  if (!(stdin && stdin.isTTY && stdout && stdout.isTTY)) {
    throw refuse(
      `live tenant ${tenantId}: the confirmation needs a real terminal (stdin and stdout)`,
    );
  }
  const typed = await (ask ?? ((q) => readlineAsk(stdin, stdout, q)))(
    `LIVE tenant. Type the tenant id (${tenantId}) back to confirm: `,
  );
  if (String(typed).trim() !== tenantId) {
    throw refuse(`live tenant ${tenantId}: the typed confirmation did not match`);
  }
  return tenantId;
}

// ─── SQL ──────────────────────────────────────────────────────────────────────

const SCOPE_SQL = `((i."trackedCategoryId" IS NOT NULL
        AND (i."categoryTaxType" IS NULL OR i."categoryTaxRate" IS NULL OR i."categoryPriceIncludesTax" IS NULL))
    OR (i."trackedCategoryId" IS NULL AND i."categoryTaxAmount" <> 0))`;

function pageSql(table) {
  if (!TABLES.includes(table)) throw new Error(`unknown table ${table}`);
  const inv = table === "InvoiceItem";
  const tenantExpr = inv
    ? `COALESCE(i."tenantId", iv."tenantId")`
    : `COALESCE(i."tenantId", o."tenantId")`;
  return `SELECT i.id, ${tenantExpr} AS "tenantId", i."trackedCategoryId",
       i."categoryTaxType", i."categoryTaxRate"::text AS "categoryTaxRate", i."categoryPriceIncludesTax",
       i.qty::text AS qty, i.boxes, i.pieces, i."unitsPerBox", i."unitLabel",
       i.subtotal::text AS subtotal, i."categoryTaxAmount"::text AS "categoryTaxAmount",
       ${inv ? 'i."orderItemId" AS "orderItemId"' : 'NULL::text AS "orderItemId"'},
       ${inv ? `COALESCE(cu."isTaxExempt", false) AS "exempt"` : `false AS "exempt"`},
       p."unitsPerBox" AS "productUnitsPerBox",
       c."taxType" AS "liveTaxType", c.rate::text AS "liveRate", c."priceIncludesTax" AS "livePriceIncludesTax",
       c."tenantId" AS "categoryTenantId"
  FROM "${table}" i
  LEFT JOIN "Product" p ON p.id = i."productId"
  LEFT JOIN "TrackedCategory" c ON c.id = i."trackedCategoryId"
  ${
    inv
      ? `JOIN "Invoice" iv ON iv.id = i."invoiceId" AND iv.status <> 'VOID'
  LEFT JOIN "Customer" cu ON cu.id = iv."customerId"`
      : `LEFT JOIN "Order" o ON o.id = i."orderId"`
  }
 WHERE ${SCOPE_SQL}
   AND i.id > $1::text
 ORDER BY i.id
 LIMIT ${PAGE}`;
}

const TRIO_COLS = `i."trackedCategoryId", i."categoryTaxType", i."categoryTaxRate"::text AS "categoryTaxRate",
       i."categoryPriceIncludesTax", c."tenantId" AS "categoryTenantId"`;
const INVOICE_SOURCES_SQL = `
  SELECT i.id, i."orderItemId", COALESCE(i."tenantId", iv."tenantId") AS "tenantId", ${TRIO_COLS}
    FROM "InvoiceItem" i JOIN "Invoice" iv ON iv.id = i."invoiceId" AND iv.status <> 'VOID'
    LEFT JOIN "TrackedCategory" c ON c.id = i."trackedCategoryId"
   WHERE i."orderItemId" = ANY($1::text[])`;
const ORDER_SOURCES_SQL = `
  SELECT i.id, COALESCE(i."tenantId", o."tenantId") AS "tenantId", ${TRIO_COLS}
    FROM "OrderItem" i LEFT JOIN "Order" o ON o.id = i."orderId"
    LEFT JOIN "TrackedCategory" c ON c.id = i."trackedCategoryId"
   WHERE i.id = ANY($1::text[])`;

async function allPages(client, table) {
  const rows = [];
  let after = "";
  for (;;) {
    const page = (await client.query(pageSql(table), [after])).rows;
    rows.push(...page);
    if (page.length < PAGE) return rows;
    after = page[page.length - 1].id;
  }
}

// ─── the plan ─────────────────────────────────────────────────────────────────

const expectedOf = (l) => ({
  trackedCategoryId: l.trackedCategoryId ?? null,
  categoryTaxType: l.categoryTaxType ?? null,
  categoryTaxRate: l.categoryTaxRate == null ? null : String(Number(l.categoryTaxRate)),
  categoryPriceIncludesTax: l.categoryPriceIncludesTax ?? null,
  categoryTaxAmount: String(l.categoryTaxAmount),
  qty: String(l.qty),
  subtotal: String(l.subtotal),
});

/**
 * Classify the whole population. `read` is `{ order: rows, invoice: rows, invoiceSourcesFor(ids), orderSourcesFor(ids) }`
 * (the DB reads, injectable for tests). TRIO runs first; its planned values are the EFFECTIVE state the L2
 * modes read from, so a counterpart repaired in this very run can prove its twin.
 */
export async function classifyPopulation({ order, invoice, invoiceSourcesFor, orderSourcesFor }) {
  const candidates = [];
  const left = [];
  const effective = new Map(); // "Table:id" -> trio columns after the planned TRIO writes
  const push = (table, line, mode, c) => {
    // A line with no derivable tenant is never planned: no gate could judge it.
    if (c.kind === "APPLY" && line.tenantId == null) c = { kind: "LEFT", reason: "no-tenant" };
    if (c.kind === "APPLY") {
      candidates.push({
        table,
        id: line.id,
        tenantId: line.tenantId ?? null,
        categoryId: c.set.trackedCategoryId,
        mode,
        rate0: !!c.rate0,
        weak: !!c.weak,
        set: c.set,
        expected: expectedOf(line),
      });
      effective.set(`${table}:${line.id}`, { ...c.set });
    } else {
      left.push({
        table,
        id: line.id,
        tenantId: line.tenantId ?? null,
        categoryId: line.trackedCategoryId ?? null,
        mode,
        reason: c.reason,
      });
    }
  };

  const l2Order = [];
  const l2Invoice = [];
  for (const [table, rows] of [
    ["OrderItem", order],
    ["InvoiceItem", invoice],
  ]) {
    for (const line of rows) {
      const t = classifyTrio(line);
      if (t) push(table, line, "TRIO", t);
      else if (line.trackedCategoryId == null && cents(line.categoryTaxAmount) !== 0) {
        (table === "OrderItem" ? l2Order : l2Invoice).push(line);
      }
    }
  }

  const overlay = (table, row) => ({ ...row, ...(effective.get(`${table}:${row.id}`) ?? {}) });
  if (l2Order.length) {
    const sources = await invoiceSourcesFor(l2Order.map((l) => l.id));
    for (const line of l2Order) {
      const own = sources
        .filter((s) => s.orderItemId === line.id)
        .map((s) => overlay("InvoiceItem", s));
      const c = classifyL2(line, own);
      if (c) push("OrderItem", line, "L2-ORDER", c);
    }
  }
  if (l2Invoice.length) {
    const ids = [...new Set(l2Invoice.map((l) => l.orderItemId).filter(Boolean))];
    const found = ids.length ? await orderSourcesFor(ids) : [];
    // An order line repaired by L2-ORDER above counts as its twin's source too.
    const byId = new Map(found.map((s) => [s.id, overlay("OrderItem", s)]));
    for (const line of l2Invoice) {
      const src = line.orderItemId ? byId.get(line.orderItemId) : undefined;
      const c = classifyL2(line, src ? [src] : []);
      if (c) push("InvoiceItem", line, "L2-INVOICE", c);
    }
  }
  return { candidates, left };
}

const tenantLabel = (n) =>
  `tenant ${String.fromCharCode(65 + (n % 26))}${n >= 26 ? Math.floor(n / 26) : ""}`;

/** Anonymous per-tenant/category summary (SA-058 shape): matched / left NULL / rate-0 per mode. Ids never leave. */
export function summarize(candidates, left, isTestByTenant = new Map()) {
  const tenants = [...new Set([...candidates, ...left].map((c) => c.tenantId ?? null))]
    .filter((t) => t != null)
    .sort();
  const label = new Map(tenants.map((t, n) => [t, tenantLabel(n)]));
  const blocks = new Map();
  const bump = (c, field) => {
    const key = c.tenantId ?? null;
    if (!blocks.has(key)) blocks.set(key, { cats: new Map(), totals: {} });
    const b = blocks.get(key);
    b.totals[`${c.mode}.${field}`] = (b.totals[`${c.mode}.${field}`] ?? 0) + 1;
    const cat = c.categoryId ?? "(none)";
    if (!b.cats.has(cat)) b.cats.set(cat, {});
    const cb = b.cats.get(cat);
    cb[`${c.mode}.${field}`] = (cb[`${c.mode}.${field}`] ?? 0) + 1;
  };
  for (const c of candidates) {
    bump(c, "matched");
    if (c.rate0) bump(c, "rate0");
    if (c.weak) bump(c, "weak");
  }
  for (const c of left) bump(c, `left:${c.reason}`);
  return [...blocks.entries()].map(([tid, b]) => {
    const catIds = [...b.cats.keys()].sort();
    return {
      tenant: tid == null ? "no tenant" : label.get(tid),
      test: !!isTestByTenant.get(tid),
      ...b.totals,
      categories: catIds.map((cid, n) => ({
        category: cid === "(none)" ? "no category" : `category ${n + 1}`,
        ...b.cats.get(cid),
      })),
    };
  });
}

// ─── DB plumbing ──────────────────────────────────────────────────────────────

async function resolveTarget() {
  const local = process.argv.includes("--local");
  const url = local
    ? process.env.DATABASE_URL
    : resolveDatabaseUrl(process.env, { requireProxy: true });
  if (!url) throw new Error("--local requires DATABASE_URL");
  if (local && !isLocalDbTarget(url))
    throw new Error(`--local refuses a non-local host (${redactUrl(url)})`);
  return url;
}
const dialConfig = (url) =>
  process.argv.includes("--local") ? requireLocalPgConfig(url) : { connectionString: url };

async function fingerprint(client) {
  const [db, tenants] = await Promise.all([
    client.query("SELECT current_database() AS db"),
    client.query('SELECT id FROM "Tenant" ORDER BY id'),
  ]);
  return { database: db.rows[0].db, tenantIds: tenants.rows.map((t) => t.id) };
}

/** The DB reads for classifyPopulation, from one open client. */
export function readersFor(client) {
  return {
    invoiceSourcesFor: async (ids) => (await client.query(INVOICE_SOURCES_SQL, [ids])).rows,
    orderSourcesFor: async (ids) => (await client.query(ORDER_SOURCES_SQL, [ids])).rows,
  };
}

/**
 * The dry-run core, on an OPEN client already inside a read-only transaction. Returns the plan body, the
 * unhashed review/held, and the anonymous summary. Writes nothing.
 */
export async function buildPlan(client, { protectedSlugs, allowedIds = new Set() }) {
  const fp = await fingerprint(client);
  const order = await allPages(client, "OrderItem");
  const invoice = await allPages(client, "InvoiceItem");
  const { candidates, left } = await classifyPopulation({ order, invoice, ...readersFor(client) });
  const tenantIds = [...new Set([...candidates, ...left].map((c) => c.tenantId).filter(Boolean))];
  const protRows = tenantIds.length ? (await client.query(PROTECTION_SQL, [tenantIds])).rows : [];
  const protectedById = protectedTenants(protRows, protectedSlugs);
  const isTestByTenant = new Map(protRows.map((r) => [r.id, isTestTenant(r.slug)]));
  const { apply, held, admittedProtectedTenantIds } = splitProtected(
    candidates,
    protectedById,
    allowedIds,
  );
  const plan = {
    generatedAt: new Date().toISOString(),
    fingerprint: fp,
    admittedProtectedTenantIds,
    apply,
  };
  const review = left;
  return {
    plan,
    review,
    held,
    summary: summarize(candidates, left, isTestByTenant),
    counts: {
      scanned: order.length + invoice.length,
      apply: apply.length,
      left: left.length,
      held: held.length,
    },
  };
}

/**
 * The one write. The WHERE re-states what the locked re-read proved, so a row that slipped any gate writes
 * nothing: the line's own tenant, and the column the mode fills still NULL (TRIO: the rate; L2: the
 * category). `$6` is the tenant id. The apply counts rows and refuses unless every planned line wrote one.
 */
export function writeSqlFor(table, mode) {
  if (!TABLES.includes(table)) throw refuse(`unknown table ${table} in the plan`);
  const parent = table === "InvoiceItem" ? ["Invoice", "invoiceId"] : ["Order", "orderId"];
  const stillNull = mode === "TRIO" ? `"categoryTaxRate" IS NULL` : `"trackedCategoryId" IS NULL`;
  return `UPDATE "${table}" i SET "trackedCategoryId" = $2, "categoryTaxType" = $3::"TrackedCategoryTaxType",
      "categoryTaxRate" = $4::numeric, "categoryPriceIncludesTax" = $5
    WHERE i.id = $1 AND i.${stillNull}
      AND COALESCE(i."tenantId", (SELECT p."tenantId" FROM "${parent[0]}" p WHERE p.id = i."${parent[1]}")) = $6`;
}
const REREAD_SQL = (table) =>
  table === "InvoiceItem"
    ? `SELECT COALESCE(i."tenantId", iv."tenantId") AS "tenantId", iv.status::text AS "parentStatus",
      i."trackedCategoryId", i."categoryTaxType", i."categoryTaxRate"::text AS "categoryTaxRate",
      i."categoryPriceIncludesTax", i."categoryTaxAmount"::text AS "categoryTaxAmount",
      i.qty::text AS qty, i.subtotal::text AS subtotal, i.boxes, i.pieces, i."unitsPerBox",
      i."unitLabel", p."unitsPerBox" AS "productUnitsPerBox"
    FROM "InvoiceItem" i JOIN "Invoice" iv ON iv.id = i."invoiceId"
    LEFT JOIN "Product" p ON p.id = i."productId"
    WHERE i.id = $1 FOR UPDATE OF i`
    : `SELECT COALESCE(i."tenantId", o."tenantId") AS "tenantId", o.status::text AS "parentStatus",
      i."trackedCategoryId", i."categoryTaxType", i."categoryTaxRate"::text AS "categoryTaxRate",
      i."categoryPriceIncludesTax", i."categoryTaxAmount"::text AS "categoryTaxAmount",
      i.qty::text AS qty, i.subtotal::text AS subtotal, i.boxes, i.pieces, i."unitsPerBox",
      i."unitLabel", p."unitsPerBox" AS "productUnitsPerBox"
    FROM "OrderItem" i LEFT JOIN "Order" o ON o.id = i."orderId"
    LEFT JOIN "Product" p ON p.id = i."productId"
    WHERE i.id = $1 FOR UPDATE OF i`;

// FOR SHARE: the category's trio cannot move under the apply between this check and COMMIT.
const CATEGORY_SQL = `SELECT "tenantId", "taxType"::text AS "taxType", rate::text AS rate, "priceIncludesTax"
    FROM "TrackedCategory" WHERE id = $1 FOR SHARE`;

/** TRIO mode copies the category's CURRENT trio: all three must still equal the planned values. */
export const categoryMatchesPlan = (cat, set) =>
  cat != null &&
  String(cat.taxType) === String(set.categoryTaxType) &&
  Number(cat.rate) === Number(set.categoryTaxRate) &&
  !!cat.priceIncludesTax === !!set.categoryPriceIncludesTax;

const sameExpected = (row, e) =>
  (row.trackedCategoryId ?? null) === e.trackedCategoryId &&
  (row.categoryTaxType ?? null) === e.categoryTaxType &&
  (row.categoryTaxRate == null ? null : String(Number(row.categoryTaxRate))) ===
    e.categoryTaxRate &&
  (row.categoryPriceIncludesTax ?? null) === e.categoryPriceIncludesTax &&
  Number(row.categoryTaxAmount) === Number(e.categoryTaxAmount) &&
  Number(row.qty) === Number(e.qty) &&
  Number(row.subtotal) === Number(e.subtotal);

/**
 * The apply proves every write from the LOCKED database row, never from the plan file: the row's own tenant
 * must be the plan's (a relabelled plan cannot move a live tenant's line behind a test tenant's gates), the
 * parent invoice must not be VOID, the category must be the line's tenant's, and the amount must still prove
 * the trio at the row's own basis.
 */
export function assertRowProvesWrite(row, a, categoryTenantId) {
  if (row.tenantId == null || row.tenantId !== a.tenantId)
    throw refuse(`${a.table} line ${a.id} no longer belongs to the planned tenant`);
  if (a.table === "InvoiceItem" && row.parentStatus === "VOID")
    throw refuse(`${a.table} line ${a.id} is now on a VOID invoice`);
  if (categoryTenantId == null || categoryTenantId !== row.tenantId)
    throw refuse(`${a.table} line ${a.id}: the planned category is not the line's tenant's`);
  const trio = {
    taxType: a.set.categoryTaxType,
    rate: a.set.categoryTaxRate,
    priceIncludesTax: !!a.set.categoryPriceIncludesTax,
  };
  if (cents(recomputeAt(row, trio)) !== cents(row.categoryTaxAmount))
    throw refuse(`${a.table} line ${a.id} no longer proves the planned rate`);
}

/**
 * The apply core, on an OPEN client already `BEGIN`-ed. Every gate that needs the database runs here; the
 * caller COMMITs on a return and ROLLBACKs on a throw. `ctx`: { protectedSlugs, overrides: Map<tenantId,
 * token>, liveOverride, confirm, yesTenants, typedTenants }. Returns the number of lines written.
 */
export async function applyPlan(client, plan, ctx) {
  if (JSON.stringify(await fingerprint(client)) !== JSON.stringify(plan.fingerprint)) {
    throw refuse("DB fingerprint changed since the dry run (database or tenants differ)");
  }
  if (plan.apply.some((a) => a.tenantId == null)) {
    throw refuse("the plan holds a line with no tenant; re-run the dry run");
  }
  const tenantIds = [...new Set(plan.apply.map((a) => a.tenantId))];
  const slugRows = tenantIds.length
    ? (await client.query('SELECT id, slug FROM "Tenant" WHERE id = ANY($1::text[])', [tenantIds]))
        .rows
    : [];
  const slugById = new Map(slugRows.map((t) => [t.id, t.slug]));
  const protRows = tenantIds.length
    ? (await client.query(`${PROTECTION_SQL} FOR SHARE OF t`, [tenantIds])).rows
    : [];
  const nowArm = protectedTenants(protRows, ctx.protectedSlugs);
  const gate = payingGate({
    admittedProtectedTenantIds: plan.admittedProtectedTenantIds,
    nowProtected: new Map([...nowArm.entries()].map(([id, arm]) => [id, { arm }])),
  });
  if (!gate.ok) throw refuse(gate.reason);
  for (const r of protRows) {
    try {
      assertWritableTenant(
        { id: r.id, slug: r.slug, status: r.status, class: r.class, deletedAt: r.deletedAt },
        { planKey: r.planKey, stripeSubId: r.stripeSubId },
        ctx.protectedSlugs,
        { allowProtected: ctx.overrides?.get(r.id) },
      );
    } catch (e) {
      if (e instanceof ProtectedTenantError) throw refuse(e.message);
      throw e;
    }
  }
  const live = tenantIds.filter((id) => !isTestTenant(slugById.get(id)));
  const liveGate = liveTenantGate({
    liveTenantIds: live,
    counts: modeCounts(plan.apply),
    override: !!ctx.liveOverride,
    confirm: ctx.confirm,
    yesTenants: ctx.yesTenants ?? [],
    typedTenants: ctx.typedTenants ?? [],
  });
  if (!liveGate.ok) throw refuse(liveGate.reason);

  let written = 0;
  for (const a of plan.apply) {
    if (!TABLES.includes(a.table)) throw refuse(`unknown table ${a.table} in the plan`);
    if (a.tenantId == null) throw refuse(`${a.table} line ${a.id} has no tenant in the plan`);
    const row = (await client.query(REREAD_SQL(a.table), [a.id])).rows[0];
    if (!row || !sameExpected(row, a.expected)) {
      throw refuse(`${a.table} line ${a.id} has changed since the dry run`);
    }
    const cat = (await client.query(CATEGORY_SQL, [a.set.trackedCategoryId])).rows[0];
    assertRowProvesWrite(row, a, cat?.tenantId ?? null);
    if (a.mode === "TRIO" && !categoryMatchesPlan(cat, a.set)) {
      throw refuse(
        `${a.table} line ${a.id}: its category ${a.set.trackedCategoryId} changed since the dry run`,
      );
    }
    const res = await client.query(writeSqlFor(a.table, a.mode), [
      a.id,
      a.set.trackedCategoryId,
      a.set.categoryTaxType,
      a.set.categoryTaxRate,
      a.set.categoryPriceIncludesTax,
      a.tenantId,
    ]);
    written += res.rowCount;
  }
  if (written !== plan.apply.length) {
    throw refuse(`wrote ${written} of ${plan.apply.length} planned line(s)`);
  }
  return written;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

/** The target URL, or a printed refusal (exit 2: an environment problem, never a silent crash). */
async function targetOrNull() {
  try {
    return await resolveTarget();
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return null;
  }
}

/**
 * The exact apply command for this plan: through `railway run` (prod is reached only that way), with every
 * gate flag the plan will need. Live-tenant ids come from the plan file, never echoed here.
 */
export function applyHint(built, file, planHash) {
  const rel = SELF.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");
  const parts = [
    `railway run --service postgres node ${rel} --apply`,
    `--plan ${file.replace(/\\/g, "/")} --confirm-plan ${planHash}`,
    "--guard-sha <merged sha> --i-have-a-fresh-backup",
  ];
  for (const id of built.plan.admittedProtectedTenantIds) parts.push(`--allow-protected ${id}`);
  const live = `--live-tenant-override --confirm "${confirmPhrase(modeCounts(built.plan.apply))}"`;
  return (
    `to apply: ${parts.join(" \\\n    ")}\n` +
    `  a plan holding a LIVE tenant also needs: ${live} --yes-tenant <tenantId> (one per live tenant, each typed back at a terminal)`
  );
}

async function dryRun() {
  const url = await targetOrNull();
  if (!url) return 2;
  let protectedSlugs;
  try {
    protectedSlugs = loadProtectedSlugs(process.env, url);
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 2;
  }
  console.log(`${TAG}: target ${redactUrl(url)} DRY-RUN`);
  const client = new pg.Client(dialConfig(url));
  try {
    await client.connect();
    // One snapshot for every page and source read: a twin is never proven from a state that never existed
    // alongside it.
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const allowedIds = new Set(argvAll("--allow-protected"));
    const built = await buildPlan(client, { protectedSlugs, allowedIds });
    await client.query("ROLLBACK");

    const planFile = planFileOf(built.plan, built.review, built.held);
    const dir = resolve(REPO_ROOT, "local-assets/handoff", new Date().toISOString().slice(0, 10));
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `b297-backfill-plan-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(planFile, null, 2));

    console.log(`\n${TAG}: ${built.counts.scanned} in-scope line(s) scanned`);
    console.log(`  APPLY: ${built.counts.apply} line(s)`);
    console.log(
      `  LEFT:  ${built.counts.left} line(s) (listed in the plan file's review; nothing is written for them)`,
    );
    console.log(
      `  PAYING-HELD: ${built.counts.held} line(s)` +
        (built.plan.admittedProtectedTenantIds.length
          ? `; ${built.plan.admittedProtectedTenantIds.length} protected tenant(s) ADMITTED (--allow-protected)`
          : " (pass --allow-protected <tenantId> to plan them; ids are in the plan file)"),
    );
    console.log(JSON.stringify(built.summary, null, 2));
    console.log(`\nplan: ${file}\nplan hash: ${planFile.planHash}`);
    if (built.counts.apply > 0) console.log(`\n${applyHint(built, file, planFile.planHash)}`);
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`${TAG}: ${e.message}`);
    return 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function verifyGuardSha(guardSha) {
  const head = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  try {
    execFileSync("git", ["-C", REPO_ROOT, "merge-base", "--is-ancestor", guardSha, head]);
  } catch {
    throw refuse(`--guard-sha ${guardSha} is not an ancestor of this checkout's HEAD (${head})`);
  }
}

async function apply() {
  const planFile = argOf("--plan");
  const confirmPlan = argOf("--confirm-plan");
  const guardSha = argOf("--guard-sha");
  if (
    !planFile ||
    !confirmPlan ||
    !guardSha ||
    !hasBackupAttestation(process.argv.slice(2), "--i-have-a-fresh-backup")
  ) {
    console.error(
      `${TAG}: --apply needs --plan, --confirm-plan, --guard-sha and --i-have-a-fresh-backup`,
    );
    return 1;
  }
  const saved = JSON.parse(readFileSync(planFile, "utf8"));
  const plan = verifyPlanFile(saved, confirmPlan);
  if (!plan) {
    console.error(`${TAG}: --confirm-plan does not match the plan file's own hash -- refusing`);
    return 1;
  }
  try {
    verifyGuardSha(guardSha);
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 1;
  }

  const url = await targetOrNull();
  if (!url) return 2;
  let protectedSlugs;
  try {
    protectedSlugs = loadProtectedSlugs(process.env, url);
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 2;
  }
  // Every protected tenant the plan admitted needs its OWN operator confirmation, taken BEFORE the
  // transaction opens (a prompt must not hold row locks).
  const overrides = new Map();
  for (const id of plan.admittedProtectedTenantIds ?? []) {
    try {
      overrides.set(
        id,
        await confirmProtectedOverride({
          tenantId: id,
          argv: process.argv.slice(2),
          backupFlag: "--i-have-a-fresh-backup",
        }),
      );
    } catch (e) {
      console.error(`${TAG}: ${e.message}`);
      return 1;
    }
  }
  console.log(`${TAG}: target ${redactUrl(url)} APPLY (${plan.apply.length} line(s))`);
  const client = new pg.Client(dialConfig(url));
  try {
    await client.connect();
    // The owner's yes per LIVE tenant is typed back at a terminal BEFORE the transaction opens (a prompt
    // must not hold row locks). The plan's tenants are classified here only to know whom to ask; the
    // transaction below re-derives every gate from the database.
    const planTenants = [...new Set(plan.apply.map((a) => a.tenantId).filter(Boolean))];
    const slugRows = planTenants.length
      ? (
          await client.query('SELECT id, slug FROM "Tenant" WHERE id = ANY($1::text[])', [
            planTenants,
          ])
        ).rows
      : [];
    const typedTenants = [];
    for (const t of slugRows.filter((r) => !isTestTenant(r.slug))) {
      typedTenants.push(
        await confirmLiveTenantYes({ tenantId: t.id, argv: process.argv.slice(2) }),
      );
    }
    await client.query("BEGIN");
    // A lock held on a production tenant row must never queue app traffic behind a long apply.
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const written = await applyPlan(client, plan, {
      protectedSlugs,
      overrides,
      liveOverride: process.argv.includes("--live-tenant-override"),
      confirm: argOf("--confirm"),
      yesTenants: argvAll("--yes-tenant"),
      typedTenants,
    });
    await client.query("COMMIT");
    console.log(`${TAG}: committed — ${written} line(s)`);
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`${TAG}: ${e.message}${e.refuse ? " -- nothing was written" : ""}`);
    return e.refuse ? 1 : 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** --self-test: the pure proof, no database. */
function selfTest() {
  const base = {
    id: "l1",
    tenantId: "t1",
    trackedCategoryId: "cat-1",
    categoryTaxType: null,
    categoryTaxRate: null,
    categoryPriceIncludesTax: null,
    qty: "12",
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitLabel: null,
    subtotal: "100.00",
    categoryTaxAmount: "0.60",
    productUnitsPerBox: null,
    liveTaxType: "EXCISE_PER_UNIT",
    liveRate: "0.0500",
    livePriceIncludesTax: false,
    exempt: false,
  };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const cases = [
    ["TRIO proven: 12 x 0.05 = 0.60", classifyTrio(base)?.kind === "APPLY"],
    [
      "TRIO left: the rate moved (0.07 x 12 = 0.84 != 0.60)",
      eq(classifyTrio({ ...base, liveRate: "0.0700" }), { kind: "LEFT", reason: "mismatch" }),
    ],
    [
      "TRIO: a partly NULL trio is NULL (R4)",
      classifyTrio({ ...base, categoryTaxType: "EXCISE_PER_UNIT", categoryTaxRate: "0.05" })
        ?.kind === "APPLY",
    ],
    [
      "TRIO: a full trio is out of scope",
      classifyTrio({
        ...base,
        categoryTaxType: "EXCISE_PER_UNIT",
        categoryTaxRate: "0.05",
        categoryPriceIncludesTax: false,
      }) === null,
    ],
    [
      "TRIO left: an unresolved category",
      eq(classifyTrio({ ...base, liveTaxType: null }), {
        kind: "LEFT",
        reason: "category-unresolved",
      }),
    ],
    [
      "TRIO left: an exempt customer's line never proves a rate",
      eq(classifyTrio({ ...base, liveRate: "0.0700", exempt: true }), {
        kind: "LEFT",
        reason: "exempt",
      }),
    ],
    [
      "TRIO rate-0 is reported",
      classifyTrio({ ...base, liveRate: "0", categoryTaxAmount: "0.00" })?.rate0 === true,
    ],
  ];
  const noCat = { ...base, trackedCategoryId: null, categoryTaxAmount: "0.60" };
  const src = (over = {}) => ({
    trackedCategoryId: "cat-1",
    categoryTaxType: "EXCISE_PER_UNIT",
    categoryTaxRate: "0.0500",
    categoryPriceIncludesTax: false,
    ...over,
  });
  cases.push(
    ["L2 proven from one source", classifyL2(noCat, [src()])?.kind === "APPLY"],
    ["L2 left: no matching line", eq(classifyL2(noCat, []), { kind: "LEFT", reason: "no-match" })],
    [
      "L2 left: sources disagree",
      eq(classifyL2(noCat, [src(), src({ categoryTaxRate: "0.0700" })]), {
        kind: "LEFT",
        reason: "disagree",
      }),
    ],
    [
      "L2 left: the copied trio does not reproduce the amount",
      eq(classifyL2({ ...noCat, categoryTaxAmount: "4.20" }, [src()]), {
        kind: "LEFT",
        reason: "mismatch",
      }),
    ],
    [
      "L2 left: a source with a NULL trio",
      eq(classifyL2(noCat, [src({ categoryTaxType: null })]), {
        kind: "LEFT",
        reason: "source-trio-null",
      }),
    ],
    [
      "L2: a zero amount is out of scope",
      classifyL2({ ...noCat, categoryTaxAmount: "0.00" }, [src()]) === null,
    ],
  );
  let failed = 0;
  for (const [name, ok] of cases) {
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  }
  console.log(
    failed ? `${TAG} self-test: ${failed} FAILED` : `${TAG} self-test: all ${cases.length} passed`,
  );
  return failed ? 1 : 0;
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  try {
    refuseRetiredFlags(process.argv.slice(2));
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 1;
  }
  return process.argv.includes("--apply") ? apply() : dryRun();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
