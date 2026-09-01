/**
 * F17 repair lane — `scripts/repair-f17.mjs`.
 *
 * F17's code fix (R2 / P1, `apps/api/src/import/import.service.ts`) stops FUTURE payment
 * re-uploads from double-recording, but it does nothing for the rows B99 already damaged
 * before the fix landed: a re-uploaded payments file with no `zohoPaymentId` on a row created a
 * second, indistinguishable `InvoicePayment` and could flip the invoice PAID early. This script
 * is build-plan work package P3 — it finds those live duplicate-payment PAIRS and, only when
 * explicitly told to, VOIDs the later twin and recomputes the invoice's status/paidAt from the
 * surviving CONFIRMED rows.
 *
 * SAFETY MODEL (copied from `scripts/repair-f03.mjs` / `scripts/repair-integrity.mjs`)
 *   • DRY RUN BY DEFAULT. Without flags the session is forced read-only
 *     (`default_transaction_read_only = on`) and the script only prints, per row,
 *     current state → proposed new state.
 *   • Writing requires BOTH `--execute` and `--i-have-a-fresh-backup` (attesting a fresh,
 *     VERIFIED production backup — house method in `scripts/REPAIR-RUNBOOK.md`).
 *   • One transaction per row. Every write is a compare-and-set against the state the dry run
 *     planned against: the row is re-read first and, if it drifted, it is SKIPPED — never
 *     overwritten — and the batch carries on with the remaining rows. "The state" is not only the
 *     invoice's status/paidAt but the INPUTS the proposed status was derived from — the invoice
 *     total and its payment rows — which are re-read and the after-status RE-DERIVED from them,
 *     both before the write and again inside the transaction. A payment recorded between the two
 *     passes moves the correct answer while leaving status and paidAt untouched, so a guard that
 *     checked only those would write a status the fresh data no longer supports.
 *   • Every applied repair is appended to `local-assets/repair-f17-<timestamp>.jsonl`
 *     (gitignored) with its before-state; the path is returned to the caller so it can be filed
 *     on the board. That log is what a rollback is reconstructed from.
 *   • Refuses a non-production DATABASE_URL unless `--force-nonprod` is passed — this script
 *     exists to repair PRODUCTION rows, so being pointed at a dev copy would report success
 *     while prod stayed damaged.
 *   • Prints row IDs, amounts and statuses ONLY — never customer or product names.
 *
 * DAMAGE SIGNATURE (build-plan P3)
 *   Per invoice, a payment PAIR is the true B99 duplicate iff both rows share a cent-equal
 *   amount (`Math.abs(a - b) < 0.005`), the same method, `createdAt` within ±1 day
 *   (86_400_000 ms) of each other, and NEITHER carries a reference that would distinguish
 *   them — a real `zohoPaymentId` (stored in `InvoicePayment.reference`) proves the two rows are
 *   NOT duplicates, because the import's own reference-based check already caught that case
 *   (`import.service.ts` `importPayments`, `:890-897` — the `if (zohoPaymentId) { … findFirst
 *   where reference: zohoPaymentId … }` block that skips a row whose reference is already on the
 *   invoice). NOT `:857-864`, which is the pre-run snapshot's `zoho-import`/VOID filter — a
 *   different guard entirely. The synthetic `"zoho-import"` placeholder reference is not a real
 *   external reference either and does not distinguish a row.
 *
 *   A pair whose rows are more than a day apart is not proposed (same amount/method on
 *   different days is legitimate: e.g. a partial payment followed by a top-up). A cluster of
 *   MORE than two mutually-matching rows is ambiguous — which N-1 of them are the true
 *   duplicates cannot be determined from the signature alone — and is REPORT-ONLY, returned
 *   under `unrepairable`, never auto-voided.
 *
 * WHAT GETS WRITTEN
 *   Exactly two things, together, in one write per repaired pair: the later twin's
 *   `InvoicePayment.status` → `VOID`, and that invoice's `status`/`paidAt` recomputed from its
 *   surviving payments under ONE rule: only CONFIRMED rows count as collected money
 *   (`InvoicePayment.status === 'PAID'` — the predicate in
 *   `apps/api/src/invoices/payment-predicates.ts`), and the invoice reads PAID once that confirmed
 *   sum reaches `total - 0.001` (the threshold in `InvoicesService.recomputeStatus`). Those two are
 *   the sources the `sumConfirmed`/`recomputeStatus` mirrors below copy. `import.service.ts`'s
 *   post-import status recalc (`importPayments`) was aligned to the same predicate and the same
 *   threshold in this batch — so if the two ever diverge again, a later payments import can
 *   silently recompute an invoice back to the status a run of this script removed. Nothing else
 *   moves: no amounts are edited, no other invoice is touched. An invoice carrying MORE THAN ONE
 *   pair is repaired one pair at a time in `createdAt` order, each write recomputing the status
 *   from the twins voided so far — so the invoice never carries a status that assumes a VOID that
 *   has not happened yet.
 *
 * `assertTestTenant` deliberately does NOT apply here: this script repairs live rows by design
 * (owner's repair-as-we-go decision, build-plan non-goals).
 *
 * Usage:
 *   railway run --service postgres node scripts/repair-f17.mjs                      # dry run
 *   railway run --service postgres node scripts/repair-f17.mjs \
 *     --execute --i-have-a-fresh-backup
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ─── Money + status mirrors ──────────────────────────────────────────────────
// Local copies so the script carries zero project imports (it runs from the postgres service
// container, where apps/api is not built). What MUST hold is that they keep returning the SAME
// ANSWER as their originals for the rows this script reads — it WRITES what they compute — not
// that they are character-for-character copies. So any change to the PAID threshold, the terminal
// status list, or the CONFIRMED predicate has to be mirrored here; a refactor that cannot move an
// answer does not.
//
// One such divergence already exists and is deliberate: the local `sumConfirmed` wraps its reduce
// in `roundMoney`, while `apps/api/src/invoices/payment-predicates.ts#sumConfirmed` returns the
// raw sum. It cannot change an outcome here — every amount summed comes from a `Decimal(10, 2)`
// column, so the true sum is cent-exact and the only thing rounding removes is float
// representation error, orders of magnitude below the 0.001 slack in `recomputeStatus`'s PAID
// comparison. Both places this script derives a status (`identifyRepairs` and `deriveAfterStatus`,
// plus the in-transaction re-derivation in `createPgStore`) go through this same local copy, so
// the script also stays self-consistent with itself.

/** Mirrors apps/api/src/common/pricing.ts#roundMoney — half-away-from-zero at the cent. */
const roundMoney = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const sign = v < 0 ? -1 : 1;
  return (sign * Math.round(Number((Math.abs(v) * 100).toFixed(4)))) / 100;
};

/** Mirrors InvoicesService.recomputeStatus — DRAFT/VOID/WRITTEN_OFF are terminal. */
function recomputeStatus(totalPaid, total, dueDate, currentStatus) {
  if (currentStatus === "DRAFT" || currentStatus === "VOID" || currentStatus === "WRITTEN_OFF") {
    return currentStatus;
  }
  if (totalPaid >= total - 0.001) return "PAID";
  if (totalPaid > 0) return "PARTIAL";
  if (dueDate && new Date(dueDate) < new Date()) return "OVERDUE";
  return "SENT";
}

/**
 * Mirrors apps/api/src/invoices/payment-predicates.ts — only CONFIRMED (status "PAID") rows
 * count as collected money.
 */
const CONFIRMED_PAYMENT_STATUS = "PAID";
function sumConfirmed(payments) {
  return roundMoney(
    (payments ?? [])
      .filter((p) => p.status === CONFIRMED_PAYMENT_STATUS)
      .reduce((s, p) => s + Number(p.amount), 0),
  );
}

/** Stable stringify (sorted keys, recursive) for before-state comparison. */
function canonical(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort(v[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

// ─── Flags + entry guard ─────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {{ execute: boolean, backupAttested: boolean, forceNonprod: boolean }}
 */
export function parseFlags(argv) {
  const args = Array.isArray(argv) ? argv : [];
  return {
    execute: args.includes("--execute"),
    backupAttested: args.includes("--i-have-a-fresh-backup"),
    forceNonprod: args.includes("--force-nonprod"),
  };
}

// Railway's Postgres is reachable either on the private network or through the TCP proxy;
// anything else (localhost, a docker-compose box, a laptop tunnel) is not production.
const PROD_HOST_SUFFIXES = [".railway.internal", ".rlwy.net", ".railway.app"];

/**
 * Entry guard: throw when `databaseUrl` does not point at the production database and the
 * operator has not explicitly opted in with `--force-nonprod`.
 *
 * @param {string} databaseUrl
 * @param {{ forceNonprod?: boolean }} flags
 * @returns {void}
 */
export function assertRepairTarget(databaseUrl, flags) {
  if (flags?.forceNonprod) return;
  let host = "";
  let db = "";
  try {
    const parsed = new URL(String(databaseUrl ?? ""));
    host = parsed.hostname.toLowerCase();
    db = decodeURIComponent(parsed.pathname.replace(/^\//, "")).toLowerCase();
  } catch {
    host = "";
  }
  const looksProd =
    host !== "" &&
    PROD_HOST_SUFFIXES.some((s) => host.endsWith(s)) &&
    !/test|local|dev|qa|e2e/i.test(db);
  if (!looksProd) {
    throw new Error(
      `Refusing to run against "${host || "(unparseable DATABASE_URL)"}${db ? `/${db}` : ""}", ` +
        "which does not look like the production database. This script repairs PRODUCTION " +
        "rows; running it elsewhere reports success while prod stays damaged. " +
        "Pass --force-nonprod to proceed anyway.",
    );
  }
}

// ─── Detection (READ-ONLY) ───────────────────────────────────────────────────

/** A reference that does not distinguish a payment from a duplicate (see DAMAGE SIGNATURE). */
function isDistinguishingReference(reference) {
  return !!reference && reference !== "zoho-import";
}

/** True iff two payments share the B99 damage signature (amount + method + ±1 day). */
function isMatchingPair(a, b) {
  return (
    Math.abs(Number(a.amount) - Number(b.amount)) < 0.005 &&
    a.method === b.method &&
    Math.abs(new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) <= 86_400_000
  );
}

/**
 * Groups `payments` into connected components under `isMatchingPair` (mutual, transitive
 * matching — the same shape a >2-row cluster naturally forms when every row matches every
 * other). Isolated payments come back as their own size-1 component.
 */
function groupMatchingPayments(payments) {
  const parent = payments.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < payments.length; i++) {
    for (let j = i + 1; j < payments.length; j++) {
      if (isMatchingPair(payments[i], payments[j])) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < payments.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(payments[i]);
  }
  return [...groups.values()];
}

/**
 * READ-ONLY. Inspects `store` and returns, per invoice, the true B99 duplicate-payment PAIRS
 * (proposed for VOID + invoice status/paidAt recompute) and any >2-row ambiguous clusters
 * (report-only). Never calls a store mutator.
 *
 * When one invoice carries several pairs, its proposals are ordered by the voided twin's
 * `createdAt` and each one's before/after is the incremental state of that single write — see the
 * comment on the loop below.
 *
 * @param {unknown} store
 * @returns {Promise<{
 *   proposals: Array<{ class: "duplicate-payment", id: string, invoiceId: string, amount: number,
 *     method: string, createdAt: string, survivorId: string, survivorCreatedAt: string,
 *     before: unknown, after: unknown }>,
 *   unrepairable: Array<{ class: string, invoiceId: string, paymentIds: string[], reason: string }>,
 * }>}
 */
export async function identifyRepairs(store) {
  const proposals = [];
  const unrepairable = [];

  for (const inv of (await store.listInvoices()) ?? []) {
    const eligible = (inv.payments ?? []).filter(
      (p) => p.status !== "VOID" && !isDistinguishingReference(p.reference),
    );
    const components = groupMatchingPayments(eligible).filter((group) => group.length >= 2);
    if (components.length === 0) continue;

    // Clusters of more than two are ambiguous — report, never propose. Only pairs (exactly two
    // mutually matching rows) are voidable.
    const pairs = [];
    for (const group of components) {
      if (group.length > 2) {
        unrepairable.push({
          class: "duplicate-payment-cluster",
          invoiceId: inv.id,
          paymentIds: group.map((p) => p.id).sort(),
          reason:
            `cluster of ${group.length} mutually-matching payments — ambiguous which ` +
            `${group.length - 1} are the true duplicates, report-only`,
        });
        continue;
      }
      pairs.push(group);
    }
    if (pairs.length === 0) continue;

    // Each twin is voided by its OWN write, so an invoice carrying more than one pair is
    // repaired STEP BY STEP: proposal n's before/after describe the state that write starts
    // from and leaves behind, recomputed against the twins voided so far — never against all of
    // them at once. Applied in createdAt order, each proposal's `before` is exactly what the
    // previous write wrote, so the pre-write compare-and-set in applyRepairs still holds for
    // proposals 2..n instead of mistaking this script's own write for outside drift.
    const twins = pairs
      .map((pair) => {
        // A pair is exactly two rows (bigger clusters were reported above): the later one is
        // voided, the earlier one survives.
        const [earlier, later] = [...pair].sort(
          (x, y) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime(),
        );
        return { earlier, later };
      })
      .sort(
        (x, y) => new Date(x.later.createdAt).getTime() - new Date(y.later.createdAt).getTime(),
      );

    const voidedSoFar = new Set();
    let runningStatus = inv.status;
    let runningPaidAt = inv.paidAt ?? null;

    for (const { earlier, later } of twins) {
      voidedSoFar.add(later.id);
      const afterSum = sumConfirmed(
        (inv.payments ?? []).filter((p) => p.status === "PAID" && !voidedSoFar.has(p.id)),
      );
      const nextStatus = recomputeStatus(
        afterSum,
        Number(inv.total),
        inv.dueDate ?? null,
        runningStatus,
      );
      const nextPaidAt = nextStatus === "PAID" ? (runningPaidAt ?? new Date().toISOString()) : null;

      proposals.push({
        class: "duplicate-payment",
        id: later.id,
        invoiceId: inv.id,
        // Carried so the dry-run report can show WHAT is being voided — the operator's only
        // chance to tell a B99 duplicate from two legitimately identical payments.
        amount: Number(later.amount),
        method: later.method,
        createdAt: later.createdAt,
        survivorId: earlier.id,
        survivorCreatedAt: earlier.createdAt,
        before: {
          paymentStatus: later.status,
          invoiceStatus: runningStatus,
          paidAt: runningPaidAt,
        },
        after: {
          paymentStatus: "VOID",
          invoiceStatus: nextStatus,
          paidAt: nextPaidAt,
        },
      });

      runningStatus = nextStatus;
      runningPaidAt = nextPaidAt;
    }
  }

  return { proposals, unrepairable };
}

// ─── Application (guarded, one transaction per row) ──────────────────────────

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

/** A fresh gitignored JSONL path per run — the audit trail a rollback is rebuilt from. */
function newLogPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    repoRoot,
    "local-assets",
    `repair-f17-${stamp}-${randomUUID().slice(0, 8)}.jsonl`,
  );
}

function appendLog(logPath, entry) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

/**
 * Re-derives the invoice status a proposal would leave behind, from a FRESH read of the invoice
 * (total, dueDate, current status) and its live payment rows, excluding `voidedPaymentId` —
 * exactly the computation `identifyRepairs` ran against the dry-run snapshot. Returns `null` when
 * the read carries no re-derivable inputs, which is itself a reason to refuse the write.
 *
 * The exclusion here is deliberately NARROWER than `identifyRepairs`'s and must stay that way:
 * that function plans a whole invoice off ONE stale snapshot, so it subtracts every twin voided so
 * far; this one reads LIVE rows, where the earlier twins of a multi-pair invoice are already
 * `VOID` in the database and `sumConfirmed` drops them on their own status. Excluding only the
 * twin about to be voided is therefore strictly stronger — it validates the proposal against what
 * the database actually holds. "Fixing" the asymmetry by tracking voided ids here would re-import
 * the stale snapshot into the guard and break the multi-pair flow.
 */
function deriveAfterStatus(current, voidedPaymentId) {
  if (!current || !Array.isArray(current.payments)) return null;
  const total = Number(current.total);
  if (!Number.isFinite(total)) return null;
  const surviving = sumConfirmed(current.payments.filter((p) => p.id !== voidedPaymentId));
  return recomputeStatus(surviving, total, current.dueDate ?? null, current.invoiceStatus);
}

/**
 * Applies `proposals` through `store`, one transaction per row, re-reading each payment/invoice
 * pair before writing it and skipping any that drifted since `identifyRepairs` saw it — where
 * "drifted" covers both the invoice's status/paidAt AND the total + payment rows the proposed
 * after-status was derived from. REJECTS unless both `flags.execute` and `flags.backupAttested`
 * are true.
 *
 * @param {unknown} store
 * @param {unknown[]} proposals
 * @param {{ execute?: boolean, backupAttested?: boolean }} flags
 * @returns {Promise<{ applied: Array<{ id: string }>, skipped: Array<{ id: string }>, logPath: string }>}
 */
export async function applyRepairs(store, proposals, flags) {
  if (!flags?.execute) {
    throw new Error(
      "Refusing to write: this script is read-only unless --execute is passed " +
        "(together with --i-have-a-fresh-backup).",
    );
  }
  if (!flags?.backupAttested) {
    throw new Error(
      "--execute also requires --i-have-a-fresh-backup. Take and VERIFY a fresh production " +
        "backup first (see scripts/REPAIR-RUNBOOK.md).",
    );
  }

  const logPath = newLogPath();
  const applied = [];
  const skipped = [];

  for (const proposal of proposals ?? []) {
    const current = await store.rereadPair(proposal.id, proposal.invoiceId);
    if (current == null) {
      skipped.push({
        id: proposal.id,
        invoiceId: proposal.invoiceId,
        class: proposal.class,
        reason: "row no longer exists — nothing written",
      });
      continue;
    }
    // The guard fires BEFORE the write, not as a rollback after one.
    const currentState = {
      paymentStatus: current.paymentStatus,
      invoiceStatus: current.invoiceStatus,
      paidAt: current.paidAt ?? null,
    };
    if (canonical(currentState) !== canonical(proposal.before)) {
      skipped.push({
        id: proposal.id,
        invoiceId: proposal.invoiceId,
        class: proposal.class,
        reason: "row drifted since the dry run — left untouched",
      });
      continue;
    }
    // Status and paidAt say nothing about the numbers the proposed after-status was COMPUTED
    // from. A customer payment recorded between the two passes moves the invoice's confirmed
    // total while leaving both of them exactly as the dry run found them — and writing the stale
    // proposal there would leave a fully-paid invoice showing an outstanding balance. Re-derive
    // from the freshly read total + payment rows and refuse anything the current data no longer
    // supports.
    const freshStatus = deriveAfterStatus(current, proposal.id);
    if (freshStatus == null) {
      skipped.push({
        id: proposal.id,
        invoiceId: proposal.invoiceId,
        class: proposal.class,
        reason:
          "re-read carried no total/payment rows to re-derive the proposed status against — " +
          "left untouched",
      });
      continue;
    }
    if (freshStatus !== proposal.after.invoiceStatus) {
      skipped.push({
        id: proposal.id,
        invoiceId: proposal.invoiceId,
        class: proposal.class,
        reason:
          `invoice payments/total drifted since the dry run — recomputing now yields ` +
          `${freshStatus}, not the proposed ${proposal.after.invoiceStatus}; left untouched`,
      });
      continue;
    }

    try {
      await store.voidDuplicatePayment(
        proposal.id,
        proposal.invoiceId,
        proposal.after.invoiceStatus,
        proposal.after.paidAt,
      );
    } catch (err) {
      // A compare-and-set that lost a race inside the store must never abort the batch — the
      // remaining rows still get repaired.
      skipped.push({
        id: proposal.id,
        invoiceId: proposal.invoiceId,
        class: proposal.class,
        reason: `not written: ${(err && err.message) || err}`,
      });
      continue;
    }

    const record = {
      id: proposal.id,
      invoiceId: proposal.invoiceId,
      class: proposal.class,
      before: proposal.before,
      after: proposal.after,
    };
    applied.push(record);
    appendLog(logPath, { at: new Date().toISOString(), ...record });
  }

  return { applied, skipped, logPath };
}

// ─── Production store (Postgres) ─────────────────────────────────────────────
// Only reached from main(); the spec injects its own fake store, so `pg` is imported lazily and
// never loaded by a test process.

/**
 * Connection resolution mirrors scripts/repair-f03.mjs / scripts/repair-integrity.mjs
 * (DATABASE_URL, or the Railway TCP proxy assembled from POSTGRES_* / RAILWAY_TCP_PROXY_* vars).
 */
function resolveUrl() {
  const direct = process.env.DATABASE_URL;
  if (direct && !direct.includes(".railway.internal")) return direct;
  const {
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_DB,
    RAILWAY_TCP_PROXY_DOMAIN,
    RAILWAY_TCP_PROXY_PORT,
  } = process.env;
  if (RAILWAY_TCP_PROXY_DOMAIN && POSTGRES_USER && POSTGRES_PASSWORD) {
    const db = POSTGRES_DB || "railway";
    const port = RAILWAY_TCP_PROXY_PORT || "5432";
    return `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(
      POSTGRES_PASSWORD,
    )}@${RAILWAY_TCP_PROXY_DOMAIN}:${port}/${db}`;
  }
  return direct || null;
}

/**
 * The real store. Reads are plain SELECTs; the write is one transaction that first re-derives the
 * status it is about to write from the invoice's own fresh total + payment rows, and whose two
 * UPDATEs are each a compare-and-set against the state `rereadPair` read (`WHERE id = $1 AND
 * status = ...`), so a row that moved between the dry run and the execute pass updates 0 rows and
 * the whole transaction rolls back — `applyRepairs`'s own pre-write reread already catches most
 * drift, this is the belt-and-braces close of the same-transaction race.
 */
export function createPgStore(client) {
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;
  // Payment/invoice status seen by the most recent rereadPair, keyed by paymentId — consumed by
  // the compare-and-set inside voidDuplicatePayment.
  const seen = new Map();

  return {
    // Scoped to invoices that have at least two non-VOID payments with no distinguishing
    // reference — the only rows that could possibly form a B99 pair. The full payment list
    // (every reference, including VOID ones) is fetched per candidate invoice so the status
    // recompute in identifyRepairs sees the invoice's true confirmed total, not just the
    // eligible subset.
    async listInvoices() {
      const candidateIds = (
        await q(`
        SELECT i.id
        FROM "Invoice" i
        JOIN "InvoicePayment" p ON p."invoiceId" = i.id
        WHERE i.status NOT IN ('DRAFT', 'VOID', 'WRITTEN_OFF')
          AND p.status <> 'VOID'
          AND (p.reference IS NULL OR p.reference = '' OR p.reference = 'zoho-import')
        GROUP BY i.id
        HAVING COUNT(*) >= 2
      `)
      ).map((r) => r.id);
      if (candidateIds.length === 0) return [];

      const rows = await q(
        `
        SELECT i.id AS "invoiceId",
               i.status::text AS "invoiceStatus",
               i.total::float8 AS total,
               i."paidAt",
               i."dueDate",
               p.id AS "paymentId",
               p.amount::float8 AS amount,
               p.method::text AS method,
               p.reference,
               p."createdAt",
               p.status::text AS "paymentStatus"
        FROM "Invoice" i
        JOIN "InvoicePayment" p ON p."invoiceId" = i.id
        WHERE i.id = ANY($1::text[])
        ORDER BY i.id, p."createdAt"
      `,
        [candidateIds],
      );

      const byInvoice = new Map();
      for (const r of rows) {
        if (!byInvoice.has(r.invoiceId)) {
          byInvoice.set(r.invoiceId, {
            id: r.invoiceId,
            status: r.invoiceStatus,
            total: r.total,
            paidAt: r.paidAt ? new Date(r.paidAt).toISOString() : null,
            dueDate: r.dueDate ? new Date(r.dueDate).toISOString() : null,
            payments: [],
          });
        }
        byInvoice.get(r.invoiceId).payments.push({
          id: r.paymentId,
          amount: r.amount,
          method: r.method,
          reference: r.reference,
          createdAt: new Date(r.createdAt).toISOString(),
          status: r.paymentStatus,
        });
      }
      return [...byInvoice.values()];
    },

    // Carries the invoice's total, dueDate and LIVE payment rows alongside the two statuses:
    // applyRepairs re-derives the proposed after-status from them before writing, so a payment
    // recorded since the dry run cannot slip past a status/paidAt-only comparison.
    async rereadPair(paymentId, invoiceId) {
      const rows = await q(
        `
        SELECT p.status::text AS "paymentStatus",
               i.status::text AS "invoiceStatus",
               i."paidAt",
               i.total::float8 AS total,
               i."dueDate",
               COALESCE(
                 (
                   SELECT json_agg(
                            json_build_object(
                              'id', ap.id,
                              'amount', ap.amount::float8,
                              'status', ap.status::text
                            )
                          )
                   FROM "InvoicePayment" ap
                   WHERE ap."invoiceId" = i.id
                 ),
                 '[]'::json
               ) AS payments
        FROM "InvoicePayment" p
        JOIN "Invoice" i ON i.id = p."invoiceId"
        WHERE p.id = $1 AND p."invoiceId" = $2
      `,
        [paymentId, invoiceId],
      );
      if (!rows.length) return null;
      const r = rows[0];
      const result = {
        paymentStatus: r.paymentStatus,
        invoiceStatus: r.invoiceStatus,
        paidAt: r.paidAt ? new Date(r.paidAt).toISOString() : null,
        total: r.total,
        dueDate: r.dueDate ? new Date(r.dueDate).toISOString() : null,
        payments: (r.payments ?? []).map((ap) => ({
          id: ap.id,
          amount: Number(ap.amount),
          status: ap.status,
        })),
      };
      seen.set(paymentId, result);
      return result;
    },

    async voidDuplicatePayment(paymentId, invoiceId, nextInvoiceStatus, nextPaidAt) {
      const before = seen.get(paymentId);
      if (!before) {
        throw new Error("voidDuplicatePayment called without a prior rereadPair — refusing");
      }
      await client.query("BEGIN");
      try {
        // The two compare-and-sets below pin only what the invoice SAYS (its status/paidAt); the
        // status being written was computed from what it is OWED and what has been PAID. Re-read
        // both inside the transaction and re-derive, so a payment recorded since the dry run
        // rolls the write back instead of being overwritten by a status it no longer supports.
        const fresh = (
          await client.query(
            `SELECT i.status::text AS "invoiceStatus",
                    i.total::float8 AS total,
                    i."dueDate",
                    p.id AS "paymentId",
                    p.amount::float8 AS amount,
                    p.status::text AS status
               FROM "Invoice" i
               LEFT JOIN "InvoicePayment" p ON p."invoiceId" = i.id
              WHERE i.id = $1`,
            [invoiceId],
          )
        ).rows;
        if (!fresh.length) {
          throw new Error("invoice disappeared inside the transaction — nothing written");
        }
        const derived = recomputeStatus(
          sumConfirmed(
            fresh
              .filter((r) => r.paymentId && r.paymentId !== paymentId)
              .map((r) => ({ amount: r.amount, status: r.status })),
          ),
          Number(fresh[0].total),
          fresh[0].dueDate ?? null,
          fresh[0].invoiceStatus,
        );
        if (derived !== nextInvoiceStatus) {
          throw new Error(
            `invoice payments/total drifted inside the transaction — recomputing yields ` +
              `${derived}, not ${nextInvoiceStatus}; rolled back, nothing written`,
          );
        }
        const payRes = await client.query(
          // NOTE: InvoicePayment has NO "updatedAt" column (see apps/api/prisma/schema.prisma) —
          // setting one here makes every write fail with 42703, which applyRepairs would report as
          // a harmless per-row skip. scripts/repair-integrity.mjs omits it for the same reason.
          `UPDATE "InvoicePayment"
              SET status = 'VOID'
            WHERE id = $1 AND "invoiceId" = $2 AND status = $3::text::"PaymentStatus"`,
          [paymentId, invoiceId, before.paymentStatus],
        );
        if (payRes.rowCount !== 1) {
          throw new Error(
            "payment row drifted inside the transaction — rolled back, nothing written",
          );
        }
        const invRes = await client.query(
          `UPDATE "Invoice"
              SET status = $2::text::"InvoiceStatus", "paidAt" = $3, "updatedAt" = now()
            WHERE id = $1 AND status = $4::text::"InvoiceStatus"`,
          [invoiceId, nextInvoiceStatus, nextPaidAt, before.invoiceStatus],
        );
        if (invRes.rowCount !== 1) {
          throw new Error(
            "invoice row drifted inside the transaction — rolled back, nothing written",
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    },
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function printReport(proposals, unrepairable) {
  if (!proposals.length) console.log("\nNo repairable duplicate-payment pairs found.");
  for (const p of proposals) {
    // The dry run is the ONLY human gate before money is voided, so it has to show what the row
    // IS — amount, method and both twins' timestamps — not just its status transition: two
    // identical same-day cash payments are also a legitimate shape, and only the operator can
    // tell the two apart.
    console.log(
      `\n[${p.class}] invoice ${p.invoiceId} — void payment ${p.id} ` +
        `(${Number(p.amount).toFixed(2)} ${p.method}, created ${p.createdAt}), ` +
        `keeping twin ${p.survivorId} (created ${p.survivorCreatedAt}): ` +
        `${JSON.stringify(p.before)} → ${JSON.stringify(p.after)}`,
    );
  }
  if (unrepairable.length) {
    console.log("\n━━━ unrepairable (reported, never modified) ━━━");
    for (const u of unrepairable) {
      console.log(`  invoice ${u.invoiceId} [${u.paymentIds.join(", ")}]: ${u.reason}`);
    }
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const url = resolveUrl();
  if (!url) {
    console.error(
      "No usable connection string. Set DATABASE_URL, or run via:\n" +
        "  railway run --service postgres node scripts/repair-f17.mjs",
    );
    process.exit(2);
  }
  try {
    assertRepairTarget(url, flags);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SET statement_timeout = '120s'");
    // Dry run: the server itself refuses any write that might slip in.
    if (!flags.execute) await client.query("SET default_transaction_read_only = on");

    console.log(
      `\n=== F17 REPAIR LANE (B99 duplicate payments) — ${
        flags.execute ? "EXECUTE" : "DRY RUN (read-only session)"
      } ===`,
    );
    console.log(`    ${new Date().toISOString()}`);

    const store = createPgStore(client);
    const { proposals, unrepairable } = await identifyRepairs(store);
    printReport(proposals, unrepairable);

    if (!flags.execute) {
      console.log(
        "\nDry run only — nothing was written. Re-run with " +
          "--execute --i-have-a-fresh-backup to apply.",
      );
      return;
    }

    const { applied, skipped, logPath } = await applyRepairs(store, proposals, flags);
    console.log(`\nApplied ${applied.length} · skipped ${skipped.length}`);
    for (const s of skipped) console.log(`  SKIPPED ${s.class} ${s.id}: ${s.reason}`);
    console.log(`\nAudit log: ${applied.length ? logPath : "(no repairs applied — none written)"}`);
  } finally {
    await client.end();
  }
}

// `node -e`/`import` never sets argv[1] to this file, so the spec's driver only gets the exports.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  });
}
