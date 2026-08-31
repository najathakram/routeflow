/**
 * F03 repair lane — `scripts/repair-f03.mjs`.
 *
 * The code fixes in batch F03 stop the bleeding; they do not heal the rows the bugs already
 * damaged. This script is requirement R10 (`.claude/pipeline/2026-08-31-f03-payment-truth/spec.md`,
 * work package P5): it finds that damage and — only when explicitly told to — repairs it.
 *
 * SAFETY MODEL (copied from `scripts/repair-integrity.mjs`)
 *   • DRY RUN BY DEFAULT. Without flags the session is forced read-only
 *     (`default_transaction_read_only = on`) and the script only prints, per row,
 *     current state → proposed new state.
 *   • Writing requires BOTH `--execute` and `--i-have-a-fresh-backup` (attesting a fresh,
 *     VERIFIED production backup — house method in `scripts/REPAIR-RUNBOOK.md`).
 *   • One transaction per row. Every write is a compare-and-set against the state the dry run
 *     planned against: the row is re-read first and, if it drifted, it is SKIPPED — never
 *     overwritten — and the batch carries on with the remaining rows.
 *   • Every applied repair is appended to `local-assets/repair-f03-<timestamp>.jsonl`
 *     (gitignored) with its before-state; the path is returned to the caller so it can be
 *     filed on the board. That log is what a rollback is reconstructed from.
 *   • Refuses a non-production DATABASE_URL unless `--force-nonprod` is passed — this script
 *     exists to repair PRODUCTION rows, so being pointed at a dev copy would report success
 *     while prod stayed damaged.
 *   • Prints row IDs, amounts and statuses ONLY — never customer or product names.
 *
 * DAMAGE CLASSES
 *   status-drift            (B74) invoice status computed from a `not: VOID` payment sum, so an
 *                                 unconfirmed DRAFT payment flipped it early.
 *   stale-category-tax      (B57) `categoryTaxAmount` left at the value computed against a
 *                                 subtotal that a later price adjustment changed.
 *   stranded-credit         (B85) an explicit OrderCreditNote selection on an order that got
 *                                 invoiced without the settle pass ever running.
 *   qty-conservation-drift  (B84) `OrderItem.invoicedQty` released twice by a non-atomic void,
 *                                 so it no longer matches the live invoice lines.
 *   B81 — a reclassified CREDIT_NOTE/ADVANCE payment method — is REPORTED as unrepairable and
 *   never modified: the evidence that would prove the damage (the original method) is the very
 *   field that was overwritten, so it is unidentifiable post-hoc.
 *
 * DETECTION SCOPE — why the two AUTO-APPLIED sweeps are narrower than "every mismatching row"
 *   Both are scoped to the damage SIGNATURE rather than the whole table, because on a live
 *   database a mismatch has legitimate causes this script must never "repair":
 *     • status-drift only considers invoices that actually carry a DRAFT `InvoicePayment` — the
 *       unconfirmed money B74 folded into the status. Unscoped, the sweep would also demote an
 *       invoice marked PAID by a path that records no payment row at all (the CSV import's
 *       `existing` branch writes {status, dueDate, paidAt} only, and findAll/findOne honour it
 *       through `isSettled`), re-opening a settled receivable and dropping it out of every
 *       PAID+paidAt revenue window — and would mass-rewrite VIEWED/SENT/OVERDUE rows B74 never
 *       touched. `identifyRepairs` additionally refuses to demote a PAID invoice that has no
 *       payment rows at all, whatever store it is handed.
 *     • qty-conservation-drift only considers order lines whose order has NO provenance-less
 *       invoice line. `adjustInvoicedQtyForInvoice` carries a second, legacy
 *       first-match-by-productId path for invoice lines with no `orderItemId`, so an order
 *       billed through it conserves qty the `orderItemId` join cannot see; proposing 0 there
 *       would re-open already-billed goods to a duplicate invoice. Bailing on the whole order is
 *       the same conservative stance InvoicesService's own rebuild paths take (`hasUntracked`);
 *       the legacy path is deliberately NOT re-derived here, because first-match-by-productId is
 *       ambiguous when an order carries two lines for the same product. The conserved value is
 *       also clamped to the order line's qty, the "Capped at qty" invariant (schema.prisma) that
 *       `adjust()` enforces — an unclamped write makes `qty - invoicedQty` negative downstream.
 *
 * WHAT THE PRODUCTION BINDING WILL AND WILL NOT WRITE
 *   The detection half covers all four classes; the dry run reports every one of them with its
 *   exact before→after. The AUTO-APPLY half is deliberately narrower — it writes only the two
 *   classes whose repair is a single self-contained field, with no downstream money cascade:
 *     • status-drift        → `Invoice.status` (+ the paired `paidAt`), derived from rows that
 *                             already exist. Nothing else moves.
 *     • qty-conservation-drift → `OrderItem.invoicedQty`, a fulfilment counter, no money.
 *   `stale-category-tax` and `stranded-credit` are REPORT-ONLY here (the store refuses the
 *   write and the row comes back under `skipped` with a reason). Repairing them correctly also
 *   moves `Invoice.taxAmount`/`total`, the credit-note wallet, the linked order's totals and
 *   the commission accruals — cascades that live in `InvoicesService` / `CreditNotesService` /
 *   `CommissionEngine` and cannot be re-derived in SQL without forking that money math. The
 *   dry run names each damaged row and its dollar delta so an operator can drive the app's own
 *   idempotent paths instead (a re-run price adjustment for B57; `settleOrderCreditsInTx`, e.g.
 *   via an order edit, for B85 — both are no-ops once correct).
 *
 * `assertTestTenant` deliberately does NOT apply here: this script repairs live rows by design
 * (owner's repair-as-we-go decision, build-plan P5).
 *
 * Usage:
 *   railway run --service postgres node scripts/repair-f03.mjs                      # dry run
 *   railway run --service postgres node scripts/repair-f03.mjs \
 *     --execute --i-have-a-fresh-backup
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ─── Money + status mirrors ──────────────────────────────────────────────────
// Local copies so the script carries zero project imports (it runs from the postgres
// service container, where apps/api is not built). Both MUST stay byte-equivalent to
// their originals — this script WRITES what they compute.

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
 * count as collected money. Summing `not: VOID` here would re-create B74's own damage.
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

/**
 * B81's class, documented rather than detected: `updatePayment` overwrote the stored
 * CREDIT_NOTE/ADVANCE method, so no surviving column distinguishes a reclassified row from one
 * that was always CASH. Listing it keeps it visible to the operator without ever touching it.
 */
const UNREPAIRABLE = [
  {
    ticket: "B81",
    class: "reclassified-payment-method",
    status: "unrepairable, not modified",
    reason:
      "A payment reclassified away from CREDIT_NOTE/ADVANCE overwrote the only evidence of its " +
      "original method; it cannot be identified post-hoc, so no row is proposed or written.",
  },
];

/**
 * READ-ONLY. Inspects `store` and returns the per-row before→after proposals for the four
 * mechanically repairable damage classes, plus the classes documented as unrepairable. Never
 * calls a store mutator.
 *
 * Each proposal also carries `snapshot` — the canonical form of the row exactly as it was read
 * here. `applyRepairs` compares it against a fresh read before writing, so a row that changed in
 * between is skipped instead of clobbered.
 *
 * @param {unknown} store
 * @returns {Promise<{ proposals: Array<{ class: string, id: string, before: unknown, after: unknown, snapshot: string }>, unrepairable: Array<{ ticket: string, status: string }> }>}
 */
export async function identifyRepairs(store) {
  const proposals = [];

  // REG-B74 — invoice status recomputed from CONFIRMED payments only.
  for (const inv of (await store.listInvoices()) ?? []) {
    const next = recomputeStatus(
      sumConfirmed(inv.payments),
      Number(inv.total),
      inv.dueDate ?? null,
      inv.status,
    );
    if (next === inv.status) continue;
    // An invoice marked PAID with NO payment rows at all was settled by a path that records
    // none (the CSV import's `existing` branch); findAll/findOne honour that status through
    // `isSettled`. Demoting it would re-open a settled receivable — never propose it.
    if (inv.status === "PAID" && next !== "PAID" && (inv.payments ?? []).length === 0) continue;
    proposals.push({
      class: "status-drift",
      id: inv.id,
      before: { status: inv.status },
      after: { status: next },
      snapshot: canonical(inv),
    });
  }

  // REG-B57 — PERCENT_OF_SALE category tax re-derived from the CURRENT subtotal; the invoice's
  // taxAmount header moves by the same delta so the two never disagree.
  for (const line of (await store.listPercentOfSaleLines()) ?? []) {
    const current = roundMoney(line.categoryTaxAmount);
    const correct = roundMoney(Number(line.subtotal) * Number(line.categoryTaxRate ?? 0));
    if (current === correct) continue;
    const header = roundMoney(line.invoiceTaxAmount);
    proposals.push({
      class: "stale-category-tax",
      id: line.id,
      before: { categoryTaxAmount: current, invoiceTaxAmount: header },
      after: {
        categoryTaxAmount: correct,
        invoiceTaxAmount: roundMoney(header - current + correct),
      },
      snapshot: canonical(line),
    });
  }

  // REG-B85 — an explicit credit selection whose order was invoiced but never settled.
  for (const sel of (await store.listCreditSelections()) ?? []) {
    if (!sel.invoiced || sel.settled) continue;
    const amount = roundMoney(sel.explicitAmount);
    if (!(amount > 0.001)) continue;
    proposals.push({
      class: "stranded-credit",
      id: sel.id,
      before: { settled: false },
      after: { settled: true, amountApplied: amount },
      snapshot: canonical(sel),
    });
  }

  // REG-B84 — invoicedQty against the qty the live (non-VOID) invoice lines actually conserve.
  for (const item of (await store.listOrderItems()) ?? []) {
    const current = Number(item.invoicedQty);
    const raw = Number(item.conservedQty);
    if (!Number.isFinite(current) || !Number.isFinite(raw)) continue;
    // Same clamp as adjustInvoicedQtyForInvoice.adjust(): invoicedQty is documented "Capped at
    // qty" (schema.prisma) and `qty - invoicedQty` must never go negative for a line whose
    // invoice lines outgrew a since-reduced order qty.
    const qty = Number(item.qty);
    const conserved = Number.isFinite(qty) ? Math.min(qty, Math.max(0, raw)) : Math.max(0, raw);
    if (current === conserved) continue;
    proposals.push({
      class: "qty-conservation-drift",
      id: item.id,
      before: { invoicedQty: current },
      after: { invoicedQty: conserved },
      snapshot: canonical(item),
    });
  }

  return { proposals, unrepairable: UNREPAIRABLE };
}

// ─── Application (guarded, one transaction per row) ──────────────────────────

/** Per-class re-read + write binding. Keeps applyRepairs free of any class-specific branching. */
const CLASS_HANDLERS = {
  "status-drift": {
    reread: (store, id) => store.rereadInvoice(id),
    write: (store, p) => store.updateInvoiceStatus(p.id, p.after.status),
  },
  "stale-category-tax": {
    reread: (store, id) => store.rereadPercentOfSaleLine(id),
    write: (store, p) =>
      store.updateLineTax(p.id, p.after.categoryTaxAmount, p.after.invoiceTaxAmount),
  },
  "stranded-credit": {
    reread: (store, id) => store.rereadCreditSelection(id),
    write: (store, p) => store.settleCreditSelection(p.id, p.after.amountApplied),
  },
  "qty-conservation-drift": {
    reread: (store, id) => store.rereadOrderItem(id),
    write: (store, p) => store.updateOrderItemQty(p.id, p.after.invoicedQty),
  },
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

/** A fresh gitignored JSONL path per run — the audit trail a rollback is rebuilt from. */
function newLogPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    repoRoot,
    "local-assets",
    `repair-f03-${stamp}-${randomUUID().slice(0, 8)}.jsonl`,
  );
}

function appendLog(logPath, entry) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

/**
 * Applies `proposals` through `store`, one transaction per row, re-reading each row before
 * writing it and skipping any that drifted since `identifyRepairs` saw it. REJECTS unless both
 * `flags.execute` and `flags.backupAttested` are true.
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
    const handler = CLASS_HANDLERS[proposal.class];
    if (!handler) {
      skipped.push({
        id: proposal.id,
        class: proposal.class,
        reason: "unknown repair class — nothing written",
      });
      continue;
    }

    const current = await handler.reread(store, proposal.id);
    if (current == null) {
      skipped.push({
        id: proposal.id,
        class: proposal.class,
        reason: "row no longer exists — nothing written",
      });
      continue;
    }
    // The guard fires BEFORE the write, not as a rollback after one.
    if (canonical(current) !== proposal.snapshot) {
      skipped.push({
        id: proposal.id,
        class: proposal.class,
        reason: "row drifted since the dry run — left untouched",
      });
      continue;
    }

    try {
      await handler.write(store, proposal);
    } catch (err) {
      // A row the store refuses (a report-only class, or a compare-and-set that lost a race)
      // must never abort the batch — the remaining rows still get repaired.
      skipped.push({
        id: proposal.id,
        class: proposal.class,
        reason: `not written: ${(err && err.message) || err}`,
      });
      continue;
    }

    const record = {
      id: proposal.id,
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
// Only reached from main(); the specs inject their own fake store, so `pg` is imported lazily
// and never loaded by a test process.

/**
 * Connection resolution mirrors scripts/repair-integrity.mjs (DATABASE_URL, or the Railway TCP
 * proxy assembled from POSTGRES_* / RAILWAY_TCP_PROXY_* vars).
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

const REPORT_ONLY = (ticket, remedy) => () => {
  throw new Error(
    `report-only class (${ticket}): repairing it also moves totals the app owns. ${remedy}`,
  );
};

/**
 * The real store. Reads are plain SELECTs; each write is its own transaction whose UPDATE is a
 * compare-and-set against the state the dry run read (`WHERE id = $1 AND <col> = <before>`), so
 * a row that moved between the two passes updates 0 rows and is reported as skipped.
 */
export function createPgStore(client) {
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;
  // before-state per id, captured by the reread pass and consumed by the compare-and-set.
  const seen = new Map();

  const casUpdate = async (sql, params) => {
    await client.query("BEGIN");
    try {
      const res = await client.query(sql, params);
      if (res.rowCount !== 1) {
        await client.query("ROLLBACK");
        throw new Error("row drifted inside the transaction — rolled back, nothing written");
      }
      await client.query("COMMIT");
    } catch (err) {
      // ROLLBACK on an already-rolled-back tx is a no-op warning; swallow it so the real
      // cause reaches the caller.
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  };

  // The CONFIRMED sum is folded into a single synthetic payment row so the shared detector
  // (sumConfirmed) is the exact same code the fake store exercises. An invoice with NO payment
  // rows at all keeps an EMPTY array instead — that is what lets identifyRepairs tell "nothing
  // was ever recorded here" (an import-settled invoice) from "0 of what is recorded is
  // confirmed", and refuse to demote the former.
  const toInvoiceRow = (r) => ({
    id: r.id,
    status: r.status,
    total: r.total,
    dueDate: r.dueDate,
    payments:
      Number(r.paymentRows) > 0
        ? [{ amount: r.confirmedPaid, status: CONFIRMED_PAYMENT_STATUS }]
        : [],
  });

  return {
    // ── status drift (B74) ──
    async listInvoices() {
      // Scoped to B74's damage signature: only an invoice that actually carries a DRAFT payment
      // could have had its status computed off unconfirmed money. See DETECTION SCOPE (header) —
      // a blanket sweep demotes import-settled PAID invoices and rewrites VIEWED/SENT/OVERDUE
      // rows this batch never damaged.
      const rows = await q(`
        SELECT i.id,
               i.status::text AS status,
               i.total::float8 AS total,
               i."dueDate",
               COUNT(p.id)::int AS "paymentRows",
               COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'PAID'), 0)::float8 AS "confirmedPaid"
        FROM "Invoice" i
        LEFT JOIN "InvoicePayment" p ON p."invoiceId" = i.id
        WHERE i.status NOT IN ('DRAFT', 'VOID', 'WRITTEN_OFF')
          AND EXISTS (
            SELECT 1 FROM "InvoicePayment" d
             WHERE d."invoiceId" = i.id AND d.status = 'DRAFT'
          )
        GROUP BY i.id
      `);
      return rows.map(toInvoiceRow);
    },
    async rereadInvoice(id) {
      const rows = await q(
        `
        SELECT i.id,
               i.status::text AS status,
               i.total::float8 AS total,
               i."dueDate",
               COUNT(p.id)::int AS "paymentRows",
               COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'PAID'), 0)::float8 AS "confirmedPaid"
        FROM "Invoice" i
        LEFT JOIN "InvoicePayment" p ON p."invoiceId" = i.id
        WHERE i.id = $1
        GROUP BY i.id
      `,
        [id],
      );
      if (!rows.length) return null;
      const r = rows[0];
      seen.set(`invoice:${id}`, r.status);
      return toInvoiceRow(r);
    },
    async updateInvoiceStatus(id, status) {
      // paidAt is paired with status at every writer in InvoicesService — an invoice this
      // demotes out of PAID must not keep a paidAt that revenue windows read. A recompute that
      // RE-AFFIRMS PAID keeps the settlement date it already had (COALESCE): restamping now()
      // would silently move the invoice into the current revenue window.
      await casUpdate(
        `UPDATE "Invoice"
            SET status = $2::text::"InvoiceStatus",
                "paidAt" = CASE WHEN $2::text = 'PAID' THEN COALESCE("paidAt", now()) ELSE NULL END,
                "updatedAt" = now()
          WHERE id = $1 AND status = $3::text::"InvoiceStatus"`,
        [id, status, seen.get(`invoice:${id}`)],
      );
    },

    // ── stale category tax (B57) — detected here, applied by the app (see header) ──
    async listPercentOfSaleLines() {
      // `categoryTaxRate` is the EFFECTIVE multiplier: a price-inclusive category's levy is
      // rate/(1+rate) of the line subtotal (apps/api/src/common/pricing.ts#computeCategoryTax).
      // Tax-exempt customers are excluded — their zeroes are correct and must be preserved.
      return q(`
        SELECT ii.id,
               ii."invoiceId",
               ii.subtotal::float8 AS subtotal,
               (CASE WHEN tc."priceIncludesTax" THEN tc.rate / (1 + tc.rate) ELSE tc.rate END)::float8
                 AS "categoryTaxRate",
               ii."categoryTaxAmount"::float8 AS "categoryTaxAmount",
               i."taxAmount"::float8 AS "invoiceTaxAmount"
        FROM "InvoiceItem" ii
        JOIN "Invoice" i ON i.id = ii."invoiceId"
        JOIN "TrackedCategory" tc ON tc.id = ii."trackedCategoryId"
        LEFT JOIN "Customer" c ON c.id = i."customerId"
        WHERE tc."taxType" = 'PERCENT_OF_SALE'
          AND i.status <> 'VOID'
          AND COALESCE(c."isTaxExempt", false) = false
      `);
    },
    async rereadPercentOfSaleLine(id) {
      const rows = await q(
        `
        SELECT ii.id,
               ii."invoiceId",
               ii.subtotal::float8 AS subtotal,
               (CASE WHEN tc."priceIncludesTax" THEN tc.rate / (1 + tc.rate) ELSE tc.rate END)::float8
                 AS "categoryTaxRate",
               ii."categoryTaxAmount"::float8 AS "categoryTaxAmount",
               i."taxAmount"::float8 AS "invoiceTaxAmount"
        FROM "InvoiceItem" ii
        JOIN "Invoice" i ON i.id = ii."invoiceId"
        JOIN "TrackedCategory" tc ON tc.id = ii."trackedCategoryId"
        WHERE ii.id = $1
      `,
        [id],
      );
      return rows[0] ?? null;
    },
    updateLineTax: REPORT_ONLY(
      "B57",
      "Re-run the invoice's price adjustment (or any recompute) in the app — post-F03 it writes " +
        "the correct categoryTaxAmount, taxAmount, total, status and order/commission sync.",
    ),

    // ── stranded credit selection (B85) — detected here, applied by the app (see header) ──
    async listCreditSelections() {
      // `explicitAmount` is the UNMET remainder of the selection: a partially applied intent
      // proposes only what is still stranded.
      const rows = await q(`
        SELECT ocn.id,
               ocn."orderId",
               ocn.amount::float8 AS amount,
               EXISTS (
                 SELECT 1 FROM "Invoice" i
                  WHERE i."orderId" = ocn."orderId" AND i.status <> 'VOID'
               ) AS invoiced,
               COALESCE((
                 SELECT SUM(p.amount)
                   FROM "InvoicePayment" p
                   JOIN "Invoice" i2 ON i2.id = p."invoiceId"
                  WHERE i2."orderId" = ocn."orderId"
                    AND p."creditNoteId" = ocn."creditNoteId"
                    AND p.status <> 'VOID'
               ), 0)::float8 AS "appliedForPair"
        FROM "OrderCreditNote" ocn
        WHERE ocn.amount IS NOT NULL
      `);
      return rows.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        invoiced: r.invoiced,
        settled: r.appliedForPair >= r.amount - 0.001,
        explicitAmount: roundMoney(r.amount - r.appliedForPair),
      }));
    },
    async rereadCreditSelection(id) {
      const rows = await this.listCreditSelections();
      return rows.find((r) => r.id === id) ?? null;
    },
    settleCreditSelection: REPORT_ONLY(
      "B85",
      "Settle it through the app (an order edit re-runs settleOrderCreditsInTx, which is " +
        "idempotent) so the credit-note wallet, invoice status and commissions move together.",
    ),

    // ── invoicedQty conservation drift (B84) ──
    async listOrderItems() {
      // Scoped to B84's damage signature. An order billed by a provenance-less invoice line
      // still had its invoicedQty bumped, via adjustInvoicedQtyForInvoice's byProduct fallback,
      // by a line this orderItemId join cannot see — so a 0 conserved sum there is missing
      // evidence, not damage, and writing it would re-open billed goods. Bail on the whole
      // order, as InvoicesService's rebuild paths do (`hasUntracked`). `provenanceComplete` is
      // carried through so the pre-write re-read notices such a line appearing in between.
      return q(`
        SELECT oi.id,
               oi.qty::float8 AS qty,
               oi."invoicedQty"::float8 AS "invoicedQty",
               NOT EXISTS (
                 SELECT 1
                   FROM "InvoiceItem" u
                   JOIN "Invoice" ui ON ui.id = u."invoiceId"
                  WHERE ui."orderId" = oi."orderId"
                    AND ui.status <> 'VOID'
                    AND u."orderItemId" IS NULL
               ) AS "provenanceComplete",
               LEAST(oi.qty, COALESCE(SUM(ii.qty) FILTER (WHERE inv.status <> 'VOID'), 0))::float8
                 AS "conservedQty"
        FROM "OrderItem" oi
        LEFT JOIN "InvoiceItem" ii ON ii."orderItemId" = oi.id
        LEFT JOIN "Invoice" inv ON inv.id = ii."invoiceId"
        WHERE NOT EXISTS (
                SELECT 1
                  FROM "InvoiceItem" u
                  JOIN "Invoice" ui ON ui.id = u."invoiceId"
                 WHERE ui."orderId" = oi."orderId"
                   AND ui.status <> 'VOID'
                   AND u."orderItemId" IS NULL
              )
        GROUP BY oi.id
        HAVING oi."invoicedQty"
            <> LEAST(oi.qty, COALESCE(SUM(ii.qty) FILTER (WHERE inv.status <> 'VOID'), 0))
      `);
    },
    async rereadOrderItem(id) {
      const rows = await q(
        `
        SELECT oi.id,
               oi.qty::float8 AS qty,
               oi."invoicedQty"::float8 AS "invoicedQty",
               NOT EXISTS (
                 SELECT 1
                   FROM "InvoiceItem" u
                   JOIN "Invoice" ui ON ui.id = u."invoiceId"
                  WHERE ui."orderId" = oi."orderId"
                    AND ui.status <> 'VOID'
                    AND u."orderItemId" IS NULL
               ) AS "provenanceComplete",
               LEAST(oi.qty, COALESCE(SUM(ii.qty) FILTER (WHERE inv.status <> 'VOID'), 0))::float8
                 AS "conservedQty"
        FROM "OrderItem" oi
        LEFT JOIN "InvoiceItem" ii ON ii."orderItemId" = oi.id
        LEFT JOIN "Invoice" inv ON inv.id = ii."invoiceId"
        WHERE oi.id = $1
        GROUP BY oi.id
      `,
        [id],
      );
      if (!rows.length) return null;
      seen.set(`orderItem:${id}`, rows[0].invoicedQty);
      return rows[0];
    },
    async updateOrderItemQty(id, qty) {
      await casUpdate(
        `UPDATE "OrderItem"
            SET "invoicedQty" = $2, "updatedAt" = now()
          WHERE id = $1 AND "invoicedQty" = $3`,
        [id, qty, seen.get(`orderItem:${id}`)],
      );
    },
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function printReport(proposals, unrepairable) {
  const byClass = new Map();
  for (const p of proposals) byClass.set(p.class, [...(byClass.get(p.class) ?? []), p]);
  if (!proposals.length) console.log("\nNo repairable damage found.");
  for (const [cls, rows] of byClass) {
    console.log(`\n━━━ ${cls} — ${rows.length} row(s) ━━━`);
    for (const r of rows) {
      console.log(`  ${r.id}: ${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}`);
    }
  }
  console.log("\n━━━ unrepairable (reported, never modified) ━━━");
  for (const u of unrepairable) console.log(`  ${u.ticket} [${u.class}]: ${u.status}`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const url = resolveUrl();
  if (!url) {
    console.error(
      "No usable connection string. Set DATABASE_URL, or run via:\n" +
        "  railway run --service postgres node scripts/repair-f03.mjs",
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
      `\n=== F03 REPAIR LANE — ${flags.execute ? "EXECUTE" : "DRY RUN (read-only session)"} ===`,
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

// `node -e`/`import` never sets argv[1] to this file, so the specs' driver only gets the exports.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  });
}
