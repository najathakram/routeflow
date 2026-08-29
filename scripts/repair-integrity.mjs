/**
 * repair-integrity.mjs — SURGICAL repair script for the specific production rows
 * found by scripts/data-integrity-report.mjs on 2026-08-28/29.
 *
 * ⚠️ SCOPE IS A HARDCODED ALLOWLIST. This script can only ever touch the rows
 * named in ROWS below (plus, for one repair, the child ReturnItem rows of the
 * one named Return — shown explicitly in the dry run). It will never scan for
 * new damage and never "fix everything it finds".
 *
 * These rows belong to LIVE CLIENT tenants. Under the client-data-protection
 * policy this repair runs only at the owner's explicit request, AFTER a fresh
 * verified backup (house method: railway ssh in-container pg_dump — see
 * scripts/REPAIR-RUNBOOK.md), dry-run first, one row at a time.
 *
 * SAFETY MODEL
 *   • DRY RUN BY DEFAULT. Without flags it connects with the session forced
 *     read-only (`default_transaction_read_only = on`) and prints, per row:
 *     current state → proposed new state → the exact SQL it would run.
 *   • Writing requires ALL of:
 *       --execute                  turn writes on
 *       --i-have-a-fresh-backup    attest a fresh verified backup exists
 *       --confirm <rowId>          opt in EACH row individually (repeatable)
 *     Rows flagged "needs a human decision" ALSO require
 *       --resolution <rowId>=<option>   (see --list for options)
 *     and overpaid-1a8fbb3d's void-duplicate-payment path requires
 *       --payment <InvoicePayment id>
 *   • One transaction per row. Inside the transaction the row is locked
 *     (SELECT … FOR UPDATE), the before-state is RE-READ and byte-compared to
 *     the dry-run snapshot; any drift aborts that row's transaction.
 *   • After each committed repair the corresponding forensic check from
 *     data-integrity-report.mjs is re-run scoped to the row and the result
 *     (now clean / still dirty) is reported.
 *   • Every executed repair is appended to
 *     local-assets/repair-log-<timestamp>.jsonl (ids, before, after, SQL).
 *   • Refuses to run unless current_database() looks like production
 *     ('railway') — pass --force-nonprod to run elsewhere (loud, deliberate).
 *   • Prints row IDs, amounts, statuses and dates ONLY — never customer or
 *     product names, emails or addresses.
 *
 * Usage:
 *   railway run --service postgres node scripts/repair-integrity.mjs            # dry run, all rows
 *   railway run --service postgres node scripts/repair-integrity.mjs --list     # row registry + options
 *   railway run --service postgres node scripts/repair-integrity.mjs \
 *     --execute --i-have-a-fresh-backup --confirm unpaidpay-638eb534
 *   railway run --service postgres node scripts/repair-integrity.mjs \
 *     --execute --i-have-a-fresh-backup \
 *     --confirm hdrmath-1a62c9d9 --resolution hdrmath-1a62c9d9=trust-components
 *
 * Connection resolution mirrors data-integrity-report.mjs (DATABASE_URL, or the
 * Railway TCP proxy assembled from POSTGRES_* / RAILWAY_TCP_PROXY_* vars).
 */
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ─── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const BACKUP_ATTESTED = argv.includes("--i-have-a-fresh-backup");
const FORCE_NONPROD = argv.includes("--force-nonprod");
const LIST = argv.includes("--list");

function collectFlag(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) {
        console.error(`${name} requires an argument`);
        process.exit(2);
      }
      out.push(argv[i + 1]);
    }
  }
  return out;
}
const CONFIRMED = new Set(collectFlag("--confirm"));
const RESOLUTIONS = new Map(
  collectFlag("--resolution").map((s) => {
    const eq = s.indexOf("=");
    if (eq < 0) {
      console.error(`--resolution must be <rowId>=<option>, got: ${s}`);
      process.exit(2);
    }
    return [s.slice(0, eq), s.slice(eq + 1)];
  }),
);
const PAYMENT_ID = collectFlag("--payment")[0] ?? null;

if (EXECUTE && !BACKUP_ATTESTED) {
  console.error(
    "--execute also requires --i-have-a-fresh-backup.\n" +
      "Take and VERIFY a fresh production backup first (see scripts/REPAIR-RUNBOOK.md).",
  );
  process.exit(2);
}
if (EXECUTE && CONFIRMED.size === 0) {
  console.error(
    "--execute requires at least one --confirm <rowId>. There is deliberately no\n" +
      "'fix everything' mode — every row is opted in individually.",
  );
  process.exit(2);
}

// ─── Connection resolution (mirrors data-integrity-report.mjs) ───────────────
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

const url = resolveUrl();
if (!url && !LIST) {
  console.error(
    "No usable connection string. Set DATABASE_URL, or run via:\n" +
      "  railway run --service postgres node scripts/repair-integrity.mjs",
  );
  process.exit(2);
}
const client = url ? new pg.Client({ connectionString: url }) : null;

// ─── Helpers ─────────────────────────────────────────────────────────────────
const roundMoney = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Mirror of InvoicesService.recomputeStatus — byte-for-byte semantics. */
function recomputeStatus(totalPaid, total, dueDate, currentStatus) {
  if (currentStatus === "DRAFT" || currentStatus === "VOID" || currentStatus === "WRITTEN_OFF") {
    return currentStatus;
  }
  if (totalPaid >= total - 0.001) return "PAID";
  if (totalPaid > 0) return "PARTIAL";
  if (dueDate && new Date(dueDate) < new Date()) return "OVERDUE";
  return "SENT";
}

function canonical(obj) {
  // Stable stringify for before-state comparison (sorted keys, recursive).
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort(v[k])]),
      );
    }
    if (v instanceof Date) return v.toISOString();
    return v;
  };
  return JSON.stringify(sort(obj));
}

async function q(db, sql, params = []) {
  return (await db.query(sql, params)).rows;
}

/** Full invoice money state: header, non-VOID paid sum, payment rows (ids/amounts only). */
async function invoiceState(db, id, { lock = false } = {}) {
  const inv = (
    await q(
      db,
      `SELECT id, status::text, total::float8, subtotal::float8, discount::float8,
              "taxAmount"::float8 AS tax, "shippingFee"::float8 AS shipping,
              "dueDate", "paidAt", "customerId", "orderId", "tenantId", "invoiceNumber"
       FROM "Invoice" WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    )
  )[0];
  if (!inv) return null;
  const payments = await q(
    db,
    `SELECT id, amount::float8, method::text, status::text, "paidAt", "createdAt",
            "creditNoteId", "advancePaymentId"
     FROM "InvoicePayment" WHERE "invoiceId" = $1 ORDER BY "createdAt", id`,
    [id],
  );
  const paid = roundMoney(
    payments.filter((p) => p.status !== "VOID").reduce((s, p) => s + Number(p.amount), 0),
  );
  return { ...inv, payments, paid };
}

function fmtPayments(payments) {
  return payments
    .map(
      (p) =>
        `      payment ${p.id}  ${Number(p.amount).toFixed(2)}  ${p.method}  ${p.status}  paidAt=${
          p.paidAt ? new Date(p.paidAt).toISOString().slice(0, 10) : "-"
        }`,
    )
    .join("\n");
}

/** SQL for an Invoice status/paidAt update derived from a recompute. */
function invoiceStatusActions(invoiceId, newStatus, latestPaidAt) {
  return [
    {
      label: `Invoice ${invoiceId}: status → ${newStatus}`,
      sql: `UPDATE "Invoice" SET status = $2::"InvoiceStatus",
              "paidAt" = ${newStatus === "PAID" ? "COALESCE($3, now())" : "NULL"},
              "updatedAt" = now()
            WHERE id = $1`,
      params: newStatus === "PAID" ? [invoiceId, newStatus, latestPaidAt] : [invoiceId, newStatus],
    },
  ];
}

// ─── Scoped forensic verifiers (SQL semantics copied from data-integrity-report.mjs) ─
const VERIFY = {
  "invoice-overpaid": {
    sql: `SELECT i.id FROM "Invoice" i
          JOIN (SELECT "invoiceId", SUM(amount) AS paid
                FROM "InvoicePayment" WHERE status <> 'VOID' GROUP BY 1) p ON p."invoiceId" = i.id
          WHERE i.status <> 'VOID' AND p.paid > i.total + 0.01 AND i.id = $1`,
  },
  "invoice-paid-with-balance": {
    sql: `SELECT i.id FROM "Invoice" i
          LEFT JOIN (SELECT "invoiceId", SUM(amount) AS paid
                     FROM "InvoicePayment" WHERE status <> 'VOID' GROUP BY 1) p ON p."invoiceId" = i.id
          WHERE i.status = 'PAID' AND COALESCE(p.paid, 0) < i.total - 0.01 AND i.id = $1`,
  },
  "invoice-unpaid-with-payments": {
    sql: `SELECT i.id FROM "Invoice" i
          JOIN (SELECT "invoiceId", SUM(amount) AS paid
                FROM "InvoicePayment" WHERE status <> 'VOID' GROUP BY 1) p ON p."invoiceId" = i.id
          WHERE i.status IN ('SENT','VIEWED','OVERDUE') AND p.paid > 0.01 AND i.id = $1`,
  },
  "payment-on-dead-invoice": {
    sql: `SELECT x.id FROM "InvoicePayment" x
          JOIN "Invoice" i ON i.id = x."invoiceId"
          WHERE x.status <> 'VOID' AND x.method IN ('CREDIT_NOTE','ADVANCE')
            AND i.status IN ('VOID','WRITTEN_OFF') AND x.id = $1`,
  },
  "invoice-header-math": {
    sql: `SELECT i.id FROM "Invoice" i
          WHERE i.status <> 'VOID' AND i.id = $1
            AND abs(i.total - (i.subtotal - i.discount + i."taxAmount" + i."shippingFee")) > 0.02`,
  },
  "invoice-lines-vs-subtotal": {
    sql: `SELECT i.id FROM "Invoice" i
          JOIN (SELECT "invoiceId", SUM(subtotal) AS line_sum FROM "InvoiceItem" GROUP BY 1) s
            ON s."invoiceId" = i.id
          WHERE i.status <> 'VOID' AND i.id = $1 AND abs(i.subtotal - s.line_sum) > 0.02`,
  },
  "orderitem-overbilled": {
    sql: `SELECT x.id FROM "OrderItem" x WHERE x."invoicedQty" > x.qty + 0.001 AND x.id = $1`,
  },
  "return-exceeds-delivered": {
    // params: [orderId, productId]
    sql: `WITH ret AS (
            SELECT r."orderId", ri."productId", SUM(ri.qty) AS returned
            FROM "ReturnItem" ri JOIN "Return" r ON r.id = ri."returnId"
            WHERE r.status NOT IN ('CANCELLED','REJECTED') AND r."orderId" = $1 AND ri."productId" = $2
            GROUP BY 1, 2),
          del AS (
            SELECT oi."orderId", oi."productId",
                   SUM(oi."deliveredQty") AS delivered, SUM(oi.qty) AS ordered
            FROM "OrderItem" oi WHERE oi."orderId" = $1 AND oi."productId" = $2 GROUP BY 1, 2)
          SELECT ret."orderId" FROM ret
          JOIN del USING ("orderId", "productId")
          WHERE ret.returned > del.delivered + 0.001`,
  },
  "tenant-drift-return": {
    sql: `SELECT c.id FROM "Return" c JOIN "Order" p ON p.id = c."orderId"
          WHERE p."tenantId" IS NOT NULL
            AND (c."tenantId" IS NULL OR c."tenantId" <> p."tenantId") AND c.id = $1`,
  },
};

// ─── Row registry (THE allowlist — nothing outside this list is ever touched) ─
//
// Each row: { rowId, check, severity, needsHuman, options?, plan(db, ctx) }.
// plan() returns:
//   { before, proposal, actions: [{label, sql, params}], lockRows: [{table, id}],
//     verify: {check, params} | {custom}, blocked?: "reason", notes: [] }
// plan() runs twice: once read-only for the dry run, once INSIDE the row's
// transaction (after locks) — the two `before` snapshots must match exactly.

const ROWS = [
  // ── CRITICAL ───────────────────────────────────────────────────────────────
  {
    rowId: "overpaid-1a8fbb3d",
    check: "invoice-overpaid",
    severity: "critical",
    needsHuman: true,
    target: { invoiceId: "1a8fbb3d-2a43-4b5f-88e5-a88254a5e97a" },
    options: [
      "void-duplicate-payment   (requires --payment <id>): the overpayment is a double-recorded payment — VOID that one payment (wallet-restoring for ADVANCE/CREDIT_NOTE) and recompute the invoice status. Mirrors InvoicesService.voidPayment.",
      "convert-excess-to-advance: the customer genuinely overpaid — shave the excess off the most recent payment and mint an AdvancePayment (customer wallet credit) for the excess. Money is preserved, invoice lands exactly PAID.",
    ],
    async plan(db, ctx) {
      const t = this.target.invoiceId;
      const inv = await invoiceState(db, t, { lock: ctx.inTx });
      if (!inv) return { blocked: `Invoice ${t} not found` };
      const excess = roundMoney(inv.paid - inv.total);
      const before = {
        invoice: { id: inv.id, status: inv.status, total: inv.total, paid: inv.paid },
        payments: inv.payments.map((p) => ({
          id: p.id,
          amount: p.amount,
          method: p.method,
          status: p.status,
        })),
      };
      const base = {
        before,
        lockRows: [{ table: "Invoice", id: t }],
        verify: { check: "invoice-overpaid", params: [t] },
        notes: [
          `Current: total=${inv.total.toFixed(2)}, non-VOID paid=${inv.paid.toFixed(2)}, excess=${excess.toFixed(2)}`,
          "Payments on this invoice:",
          fmtPayments(inv.payments),
        ],
      };
      if (excess <= 0.01)
        return { ...base, blocked: "No longer overpaid — nothing to do (already repaired?)" };

      const resolution = ctx.resolution;
      if (!resolution) {
        return {
          ...base,
          proposal:
            "NEEDS A HUMAN DECISION — pass --resolution overpaid-1a8fbb3d=<option>. See --list / REPAIR-RUNBOOK.md.",
          actions: [],
          blocked:
            EXECUTE && ctx.confirmed ? "No --resolution given for a needs-human row" : undefined,
        };
      }

      if (resolution === "void-duplicate-payment") {
        if (!ctx.paymentId)
          return {
            ...base,
            blocked: "void-duplicate-payment requires --payment <InvoicePayment id>",
          };
        const p = inv.payments.find((x) => x.id === ctx.paymentId);
        if (!p)
          return {
            ...base,
            blocked: `--payment ${ctx.paymentId} is not a payment on this invoice`,
          };
        if (p.status === "VOID") return { ...base, blocked: "That payment is already VOID" };
        const actions = [];
        if (p.method === "ADVANCE" && p.advancePaymentId) {
          actions.push({
            label: `Restore ${Number(p.amount).toFixed(2)} to AdvancePayment ${p.advancePaymentId}`,
            sql: `UPDATE "AdvancePayment" SET balance = balance + $2, "updatedAt" = now() WHERE id = $1`,
            params: [p.advancePaymentId, roundMoney(p.amount)],
          });
        }
        if (p.method === "CREDIT_NOTE" && p.creditNoteId) {
          actions.push({
            label: `Restore ${Number(p.amount).toFixed(2)} to CreditNote ${p.creditNoteId} (amountUsed down, status per wallet rules)`,
            sql: `UPDATE "CreditNote" SET
                    "amountUsed" = GREATEST(0, "amountUsed" - $2),
                    status = CASE WHEN GREATEST(0, "amountUsed" - $2) >= amount - 0.001 AND status <> 'VOID'
                                  THEN 'APPLIED'::"CreditNoteStatus" ELSE 'ISSUED'::"CreditNoteStatus" END,
                    "appliedToInvoiceId" = CASE WHEN GREATEST(0, "amountUsed" - $2) >= amount - 0.001
                                                THEN "appliedToInvoiceId" ELSE NULL END,
                    "appliedAt" = CASE WHEN GREATEST(0, "amountUsed" - $2) <= 0.001 THEN NULL ELSE "appliedAt" END,
                    "autoApplied" = CASE WHEN GREATEST(0, "amountUsed" - $2) <= 0.001 THEN false ELSE "autoApplied" END,
                    "expiresAt" = CASE WHEN "expiresAt" IS NOT NULL AND "expiresAt" <= now() THEN NULL ELSE "expiresAt" END,
                    "updatedAt" = now()
                  WHERE id = $1`,
            params: [p.creditNoteId, roundMoney(p.amount)],
          });
        }
        actions.push({
          label: `VOID payment ${p.id} (${Number(p.amount).toFixed(2)} ${p.method})`,
          sql: `UPDATE "InvoicePayment" SET status = 'VOID' WHERE id = $1 AND status <> 'VOID'`,
          params: [p.id],
        });
        const newPaid = roundMoney(inv.paid - Number(p.amount));
        const newStatus = recomputeStatus(newPaid, inv.total, inv.dueDate, inv.status);
        const latestPaidAt = inv.payments
          .filter((x) => x.status !== "VOID" && x.id !== p.id)
          .reduce((m, x) => (m && m > x.paidAt ? m : x.paidAt), null);
        actions.push(...invoiceStatusActions(t, newStatus, latestPaidAt));
        return {
          ...base,
          proposal: `VOID payment ${p.id} (${Number(p.amount).toFixed(2)}); paid ${inv.paid.toFixed(2)} → ${newPaid.toFixed(2)}; status ${inv.status} → ${newStatus}`,
          actions,
        };
      }

      if (resolution === "convert-excess-to-advance") {
        const live = inv.payments.filter((x) => x.status !== "VOID");
        const src = [...live].reverse().find((x) => Number(x.amount) >= excess - 0.001);
        if (!src)
          return {
            ...base,
            blocked: `No single non-VOID payment covers the ${excess.toFixed(2)} excess — resolve manually (split across payments needs a human).`,
          };
        if (src.method === "CREDIT_NOTE" || src.method === "ADVANCE")
          return {
            ...base,
            blocked: `The candidate payment ${src.id} is ${src.method} (wallet money) — shrinking it without a wallet restore would corrupt the wallet. Use void-duplicate-payment on the true duplicate instead.`,
          };
        const advId = ctx.mintedAdvanceId; // stable across the two plan() runs
        const newAmount = roundMoney(Number(src.amount) - excess);
        const actions = [
          newAmount <= 0.001
            ? {
                label: `VOID payment ${src.id} entirely (its full ${Number(src.amount).toFixed(2)} is the excess — a 0.00 payment row would be left otherwise)`,
                sql: `UPDATE "InvoicePayment" SET status = 'VOID' WHERE id = $1 AND status <> 'VOID'`,
                params: [src.id],
              }
            : {
                label: `Shrink payment ${src.id}: ${Number(src.amount).toFixed(2)} → ${newAmount.toFixed(2)}`,
                sql: `UPDATE "InvoicePayment" SET amount = $2 WHERE id = $1`,
                params: [src.id, newAmount],
              },
          {
            label: `Mint AdvancePayment ${advId} of ${excess.toFixed(2)} for customer ${inv.customerId}`,
            sql: `INSERT INTO "AdvancePayment"
                    (id, "customerId", amount, balance, method, reference, notes,
                     "receivedAt", "createdAt", "updatedAt", "tenantId")
                  VALUES ($1, $2, $3, $3, $4::"PaymentMethod", NULL,
                          $5, $6, now(), now(), $7)`,
            params: [
              advId,
              inv.customerId,
              excess,
              src.method,
              `Data repair 2026-08: overpayment on invoice ${inv.invoiceNumber} (${t}) converted to advance`,
              src.paidAt,
              inv.tenantId,
            ],
          },
        ];
        const newStatus = recomputeStatus(inv.total, inv.total, inv.dueDate, inv.status);
        const latestPaidAt = live.reduce((m, x) => (m && m > x.paidAt ? m : x.paidAt), null);
        actions.push(...invoiceStatusActions(t, newStatus, latestPaidAt));
        return {
          ...base,
          proposal: `Move the ${excess.toFixed(2)} excess off payment ${src.id} into a new customer advance; invoice lands exactly PAID`,
          actions,
        };
      }
      return { ...base, blocked: `Unknown resolution "${resolution}"` };
    },
  },

  {
    rowId: "paidbal-882e3615",
    check: "invoice-paid-with-balance",
    severity: "critical",
    needsHuman: true,
    target: { invoiceId: "882e3615-e79b-43f8-aa7d-4193483ce55a" },
    options: [
      "recompute-status: the recorded payments (834 of 1834) are the truth — the PAID flag is the lie (B74/B84 family). Flip status via the recomputeStatus mirror (→ PARTIAL), clear paidAt. The invoice returns to AR aging with a 1000.00 balance due.",
      "record-missing-payment (NOT run by this script): the customer really did pay the remaining 1000 and the payment row was lost/voided by a bug. Record it through the app UI (proper payment numbering, commissions, cash-basis reporting) — the forensic check then self-heals.",
    ],
    async plan(db, ctx) {
      const t = this.target.invoiceId;
      const inv = await invoiceState(db, t, { lock: ctx.inTx });
      if (!inv) return { blocked: `Invoice ${t} not found` };
      const before = {
        invoice: { id: inv.id, status: inv.status, total: inv.total, paid: inv.paid },
        payments: inv.payments.map((p) => ({
          id: p.id,
          amount: p.amount,
          method: p.method,
          status: p.status,
        })),
      };
      const base = {
        before,
        lockRows: [{ table: "Invoice", id: t }],
        verify: { check: "invoice-paid-with-balance", params: [t] },
        notes: [
          `Current: status=${inv.status}, total=${inv.total.toFixed(2)}, non-VOID paid=${inv.paid.toFixed(2)} (short ${(inv.total - inv.paid).toFixed(2)})`,
          "Payments on this invoice (VOID rows may be the lost money — check for a B84 double-void):",
          fmtPayments(inv.payments),
        ],
      };
      if (!(inv.status === "PAID" && inv.paid < inv.total - 0.01))
        return {
          ...base,
          blocked: "No longer PAID-with-balance — nothing to do (already repaired?)",
        };
      if (ctx.resolution !== "recompute-status") {
        return {
          ...base,
          proposal:
            "NEEDS A HUMAN DECISION — was the missing 1000.00 actually received? If yes: record it in the app. If no: --resolution paidbal-882e3615=recompute-status",
          actions: [],
          blocked:
            EXECUTE && ctx.confirmed ? "No --resolution given for a needs-human row" : undefined,
        };
      }
      // recomputeStatus treats PAID as recomputable (only DRAFT/VOID/WRITTEN_OFF are terminal).
      const newStatus = recomputeStatus(inv.paid, inv.total, inv.dueDate, inv.status);
      return {
        ...base,
        proposal: `status PAID → ${newStatus}; paidAt → NULL; balance due becomes ${(inv.total - inv.paid).toFixed(2)}`,
        actions: invoiceStatusActions(t, newStatus, null),
      };
    },
  },

  {
    rowId: "deadpay-cf082424",
    check: "payment-on-dead-invoice",
    severity: "critical",
    needsHuman: false,
    target: { paymentId: "cf082424-0a8c-47ec-8f7b-6e63e964f192" },
    async plan(db, ctx) {
      const t = this.target.paymentId;
      const p = (
        await q(
          db,
          `SELECT p.id, p.amount::float8, p.method::text, p.status::text,
                  p."creditNoteId", p."advancePaymentId", p."invoiceId",
                  i.status::text AS invoice_status
           FROM "InvoicePayment" p JOIN "Invoice" i ON i.id = p."invoiceId"
           WHERE p.id = $1 ${ctx.inTx ? "FOR UPDATE OF p" : ""}`,
          [t],
        )
      )[0];
      if (!p) return { blocked: `InvoicePayment ${t} not found` };
      const before = {
        payment: { id: p.id, amount: p.amount, method: p.method, status: p.status },
        invoice: { id: p.invoiceId, status: p.invoice_status },
      };
      const base = {
        before,
        lockRows: [{ table: "InvoicePayment", id: t }],
        verify: { check: "payment-on-dead-invoice", params: [t] },
        notes: [
          `Payment ${p.id}: ${p.amount.toFixed(2)} ${p.method} (${p.status}) on ${p.invoice_status} invoice ${p.invoiceId}`,
        ],
      };
      if (p.status === "VOID" || !["VOID", "WRITTEN_OFF"].includes(p.invoice_status))
        return {
          ...base,
          blocked: "Condition no longer holds — nothing to do (already repaired?)",
        };
      if (p.invoice_status === "WRITTEN_OFF")
        return {
          ...base,
          blocked:
            "Invoice is WRITTEN_OFF, not VOID — releasing wallet money from a written-off debt is a business call, not a mechanical repair. Escalate to a human.",
        };

      // Mirrors InvoicesService.releaseWalletPaymentsInTx — the step voidInvoice
      // should have run: delete the application, restore the wallet.
      const actions = [];
      if (p.method === "ADVANCE" && p.advancePaymentId) {
        actions.push({
          label: `Restore ${p.amount.toFixed(2)} to AdvancePayment ${p.advancePaymentId}`,
          sql: `UPDATE "AdvancePayment" SET balance = balance + $2, "updatedAt" = now() WHERE id = $1`,
          params: [p.advancePaymentId, roundMoney(p.amount)],
        });
      } else if (p.method === "CREDIT_NOTE" && p.creditNoteId) {
        actions.push({
          label: `Restore ${p.amount.toFixed(2)} to CreditNote ${p.creditNoteId} (restoreCreditFromPaymentInTx semantics incl. REVIVE of a past expiry)`,
          sql: `UPDATE "CreditNote" SET
                  "amountUsed" = GREATEST(0, "amountUsed" - $2),
                  status = CASE WHEN GREATEST(0, "amountUsed" - $2) >= amount - 0.001 AND status <> 'VOID'
                                THEN 'APPLIED'::"CreditNoteStatus" ELSE 'ISSUED'::"CreditNoteStatus" END,
                  "appliedToInvoiceId" = CASE WHEN GREATEST(0, "amountUsed" - $2) >= amount - 0.001
                                              THEN "appliedToInvoiceId" ELSE NULL END,
                  "appliedAt" = CASE WHEN GREATEST(0, "amountUsed" - $2) <= 0.001 THEN NULL ELSE "appliedAt" END,
                  "autoApplied" = CASE WHEN GREATEST(0, "amountUsed" - $2) <= 0.001 THEN false ELSE "autoApplied" END,
                  "expiresAt" = CASE WHEN "expiresAt" IS NOT NULL AND "expiresAt" <= now() THEN NULL ELSE "expiresAt" END,
                  "updatedAt" = now()
                WHERE id = $1`,
          params: [p.creditNoteId, roundMoney(p.amount)],
        });
      } else {
        return {
          ...base,
          blocked: `Payment method ${p.method} has no wallet pointer (creditNoteId/advancePaymentId NULL) — cannot restore mechanically; escalate.`,
        };
      }
      actions.push({
        label: `Delete payment ${p.id} (mirrors releaseWalletPaymentsInTx, which DELETES released applications)`,
        sql: `DELETE FROM "InvoicePayment" WHERE id = $1`,
        params: [t],
      });
      return {
        ...base,
        proposal: `Release the ${p.amount.toFixed(2)} ${p.method} application stranded on VOID invoice ${p.invoiceId} back to the customer wallet (the exact step voidInvoice's releaseWalletPaymentsInTx should have performed)`,
        actions,
      };
    },
  },

  {
    rowId: "overbill-6edd8f20",
    check: "orderitem-overbilled",
    severity: "critical",
    needsHuman: false,
    target: { orderItemId: "6edd8f20-b0d1-4404-be6d-954eb7aacd14" },
    async plan(db, ctx) {
      const t = this.target.orderItemId;
      const oi = (
        await q(
          db,
          `SELECT id, "orderId", "productId", qty::float8, "invoicedQty"::float8, "deliveredQty"::float8
           FROM "OrderItem" WHERE id = $1 ${ctx.inTx ? "FOR UPDATE" : ""}`,
          [t],
        )
      )[0];
      if (!oi) return { blocked: `OrderItem ${t} not found` };
      // Live billed = Σ non-VOID invoice-line qty with provenance to this line,
      // plus legacy (no-provenance) lines on this ORDER's invoices matching the product
      // — the same match adjustInvoicedQtyForInvoice uses.
      const [prov] = await q(
        db,
        `SELECT COALESCE(SUM(ii.qty), 0)::float8 AS s
         FROM "InvoiceItem" ii JOIN "Invoice" iv ON iv.id = ii."invoiceId"
         WHERE ii."orderItemId" = $1 AND iv.status <> 'VOID'`,
        [t],
      );
      const [legacy] = await q(
        db,
        `SELECT COALESCE(SUM(ii.qty), 0)::float8 AS s
         FROM "InvoiceItem" ii JOIN "Invoice" iv ON iv.id = ii."invoiceId"
         WHERE ii."orderItemId" IS NULL AND ii."productId" = $1
           AND iv."orderId" = $2 AND iv.status <> 'VOID'`,
        [oi.productId, oi.orderId],
      );
      const [siblingCount] = await q(
        db,
        `SELECT COUNT(*)::int AS n FROM "OrderItem" WHERE "orderId" = $1 AND "productId" = $2`,
        [oi.orderId, oi.productId],
      );
      const liveBilled = roundMoney(Number(prov.s) + Number(legacy.s));
      const before = {
        orderItem: { id: oi.id, qty: oi.qty, invoicedQty: oi.invoicedQty },
        liveBilled,
      };
      const base = {
        before,
        lockRows: [{ table: "OrderItem", id: t }],
        verify: { check: "orderitem-overbilled", params: [t] },
        notes: [
          `Current: ordered=${oi.qty}, invoicedQty=${oi.invoicedQty}, live non-VOID invoice lines actually bill=${liveBilled} (provenance ${prov.s} + legacy ${legacy.s})`,
        ],
      };
      if (oi.invoicedQty <= oi.qty + 0.001)
        return { ...base, blocked: "No longer overbilled — nothing to do (already repaired?)" };
      if (Number(legacy.s) > 0.001 && siblingCount.n > 1)
        return {
          ...base,
          blocked:
            "Order has multiple lines for the same product AND legacy no-provenance invoice lines — the product-match is ambiguous; escalate to a human.",
        };
      if (liveBilled > oi.qty + 0.001)
        return {
          ...base,
          blocked: `Live invoices genuinely bill ${liveBilled} > ordered ${oi.qty} — the INVOICES over-bill, not just the counter. Clamping the counter would hide real over-billing; escalate to a human (see runbook).`,
        };
      const next = Math.min(oi.qty, Math.max(0, liveBilled));
      return {
        ...base,
        proposal: `Reset invoicedQty ${oi.invoicedQty} → ${next} (recomputed from live non-VOID invoice lines, clamped to [0, qty] exactly like adjustInvoicedQtyForInvoice)`,
        actions: [
          {
            label: `OrderItem ${t}: invoicedQty → ${next}`,
            sql: `UPDATE "OrderItem" SET "invoicedQty" = $2, "updatedAt" = now() WHERE id = $1`,
            params: [t, next],
          },
        ],
      };
    },
  },

  // ── HIGH ───────────────────────────────────────────────────────────────────
  ...[
    { rowId: "unpaidpay-638eb534", invoiceId: "638eb534-d10c-43e5-b2b6-f1acb54fd2d0" },
    { rowId: "unpaidpay-bc48a97b", invoiceId: "bc48a97b-a849-4c5b-8ad7-a559781806ef" },
  ].map(({ rowId, invoiceId }) => ({
    rowId,
    check: "invoice-unpaid-with-payments",
    severity: "high",
    needsHuman: false,
    target: { invoiceId },
    async plan(db, ctx) {
      const inv = await invoiceState(db, invoiceId, { lock: ctx.inTx });
      if (!inv) return { blocked: `Invoice ${invoiceId} not found` };
      const before = {
        invoice: { id: inv.id, status: inv.status, total: inv.total, paid: inv.paid },
      };
      const base = {
        before,
        lockRows: [{ table: "Invoice", id: invoiceId }],
        verify: { check: "invoice-unpaid-with-payments", params: [invoiceId] },
        notes: [
          `Current: status=${inv.status}, total=${inv.total.toFixed(2)}, non-VOID paid=${inv.paid.toFixed(2)}`,
          fmtPayments(inv.payments),
        ],
      };
      if (!(["SENT", "VIEWED", "OVERDUE"].includes(inv.status) && inv.paid > 0.01))
        return {
          ...base,
          blocked: "Condition no longer holds — nothing to do (already repaired?)",
        };
      const newStatus = recomputeStatus(inv.paid, inv.total, inv.dueDate, inv.status);
      if (newStatus === inv.status)
        return {
          ...base,
          blocked: "recomputeStatus returns the current status — nothing to change",
        };
      const latestPaidAt = inv.payments
        .filter((x) => x.status !== "VOID")
        .reduce((m, x) => (m && m > x.paidAt ? m : x.paidAt), null);
      return {
        ...base,
        proposal: `status ${inv.status} → ${newStatus} (pure recomputeStatus mirror over the recorded payments — the fix B74/B76 should have applied)`,
        actions: invoiceStatusActions(invoiceId, newStatus, latestPaidAt),
      };
    },
  })),

  {
    rowId: "hdrmath-1a62c9d9",
    check: "invoice-header-math",
    severity: "high",
    needsHuman: true,
    target: { invoiceId: "1a62c9d9-0c49-42df-bfa5-a701fd13a4db" },
    options: [
      "trust-components: subtotal/discount/tax/shipping are right, the stored total is stale — set total = subtotal − discount + tax + shipping (50.00) and recompute the payment status against the new total. Consequence: the customer owes 50 less; if payments already cover 50 the invoice flips PAID.",
      "trust-total (NOT run by this script): the 100.00 total is what was actually billed/collected and one of the components is wrong (e.g. a phantom 50.00 discount). Identify and fix the bad component in the app / by hand, then re-run the forensic check.",
    ],
    async plan(db, ctx) {
      const t = this.target.invoiceId;
      const inv = await invoiceState(db, t, { lock: ctx.inTx });
      if (!inv) return { blocked: `Invoice ${t} not found` };
      const computed = roundMoney(inv.subtotal - inv.discount + inv.tax + inv.shipping);
      const before = {
        invoice: {
          id: inv.id,
          status: inv.status,
          total: inv.total,
          subtotal: inv.subtotal,
          discount: inv.discount,
          tax: inv.tax,
          shipping: inv.shipping,
          paid: inv.paid,
        },
      };
      const base = {
        before,
        lockRows: [{ table: "Invoice", id: t }],
        verify: { check: "invoice-header-math", params: [t] },
        notes: [
          `Current: total=${inv.total.toFixed(2)} but subtotal ${inv.subtotal.toFixed(2)} − discount ${inv.discount.toFixed(2)} + tax ${inv.tax.toFixed(2)} + shipping ${inv.shipping.toFixed(2)} = ${computed.toFixed(2)}; status=${inv.status}, paid=${inv.paid.toFixed(2)}`,
        ],
      };
      if (Math.abs(inv.total - computed) <= 0.02)
        return {
          ...base,
          blocked: "Header math now consistent — nothing to do (already repaired?)",
        };
      if (ctx.resolution !== "trust-components") {
        return {
          ...base,
          proposal:
            "NEEDS A HUMAN DECISION — is the total wrong, or a component? Executable option: --resolution hdrmath-1a62c9d9=trust-components",
          actions: [],
          blocked:
            EXECUTE && ctx.confirmed ? "No --resolution given for a needs-human row" : undefined,
        };
      }
      const newStatus = recomputeStatus(inv.paid, computed, inv.dueDate, inv.status);
      const latestPaidAt = inv.payments
        .filter((x) => x.status !== "VOID")
        .reduce((m, x) => (m && m > x.paidAt ? m : x.paidAt), null);
      return {
        ...base,
        proposal: `total ${inv.total.toFixed(2)} → ${computed.toFixed(2)}; status ${inv.status} → ${newStatus}`,
        actions: [
          {
            label: `Invoice ${t}: total → ${computed.toFixed(2)}`,
            sql: `UPDATE "Invoice" SET total = $2, "updatedAt" = now() WHERE id = $1`,
            params: [t, computed],
          },
          ...invoiceStatusActions(t, newStatus, latestPaidAt),
        ],
      };
    },
  },

  {
    rowId: "linesum-ea63fb65",
    check: "invoice-lines-vs-subtotal",
    severity: "high",
    needsHuman: true,
    target: { invoiceId: "ea63fb65-f883-4a02-97ce-b93316f6284f" },
    options: [
      "resum-header: the LINES are right (a line edit never re-summed the header) — set subtotal = Σ line subtotals (554.50), total = subtotal − discount + tax + shipping, recompute status. Consequence: the customer owes ~257 MORE than the header said; check the customer was actually billed for those lines before choosing this.",
      "dedupe-lines (NOT run by this script): the HEADER is right and the line list carries duplicates (e.g. a re-fire/edit appended lines). Inspect the line list in the dry run, delete the duplicate lines in the app, then run resum-header (it becomes a no-op if the header already matches).",
    ],
    async plan(db, ctx) {
      const t = this.target.invoiceId;
      const inv = await invoiceState(db, t, { lock: ctx.inTx });
      if (!inv) return { blocked: `Invoice ${t} not found` };
      const lines = await q(
        db,
        `SELECT id, "productId", qty::float8, "unitPrice"::float8, subtotal::float8, "createdAt"
         FROM "InvoiceItem" WHERE "invoiceId" = $1 ORDER BY "createdAt", id`,
        [t],
      );
      const lineSum = roundMoney(lines.reduce((s, l) => s + l.subtotal, 0));
      const before = {
        invoice: {
          id: inv.id,
          status: inv.status,
          subtotal: inv.subtotal,
          total: inv.total,
          paid: inv.paid,
        },
        lineSum,
        lines: lines.map((l) => ({ id: l.id, subtotal: l.subtotal })),
      };
      const base = {
        before,
        lockRows: [{ table: "Invoice", id: t }],
        verify: { check: "invoice-lines-vs-subtotal", params: [t] },
        notes: [
          `Current: header subtotal=${inv.subtotal.toFixed(2)}, Σ line subtotals=${lineSum.toFixed(2)}, total=${inv.total.toFixed(2)}, status=${inv.status}, paid=${inv.paid.toFixed(2)}`,
          "Lines (inspect for duplicates before choosing a resolution):",
          ...lines.map(
            (l) =>
              `      line ${l.id}  product=${l.productId ?? "-"}  qty=${l.qty}  unit=${l.unitPrice.toFixed(2)}  subtotal=${l.subtotal.toFixed(2)}  ${new Date(l.createdAt).toISOString()}`,
          ),
        ],
      };
      if (Math.abs(inv.subtotal - lineSum) <= 0.02)
        return { ...base, blocked: "Header now matches lines — nothing to do (already repaired?)" };
      if (ctx.resolution !== "resum-header") {
        return {
          ...base,
          proposal:
            "NEEDS A HUMAN DECISION — are the lines duplicated, or is the header stale? Executable option: --resolution linesum-ea63fb65=resum-header",
          actions: [],
          blocked:
            EXECUTE && ctx.confirmed ? "No --resolution given for a needs-human row" : undefined,
        };
      }
      const newTotal = roundMoney(lineSum - inv.discount + inv.tax + inv.shipping);
      const newStatus = recomputeStatus(inv.paid, newTotal, inv.dueDate, inv.status);
      const latestPaidAt = inv.payments
        .filter((x) => x.status !== "VOID")
        .reduce((m, x) => (m && m > x.paidAt ? m : x.paidAt), null);
      return {
        ...base,
        proposal: `subtotal ${inv.subtotal.toFixed(2)} → ${lineSum.toFixed(2)}; total ${inv.total.toFixed(2)} → ${newTotal.toFixed(2)}; status ${inv.status} → ${newStatus}`,
        actions: [
          {
            label: `Invoice ${t}: subtotal → ${lineSum.toFixed(2)}, total → ${newTotal.toFixed(2)}`,
            sql: `UPDATE "Invoice" SET subtotal = $2, total = $3, "updatedAt" = now() WHERE id = $1`,
            params: [t, lineSum, newTotal],
          },
          ...invoiceStatusActions(t, newStatus, latestPaidAt),
        ],
      };
    },
  },

  ...[
    { rowId: "retdel-36c21079", orderPrefix: "36c21079", productPrefix: "38ff073a" },
    { rowId: "retdel-aa79cb93", orderPrefix: "aa79cb93", productPrefix: "7a337aba" },
    { rowId: "retdel-2ef317f6", orderPrefix: "2ef317f6", productPrefix: "9a898a59" },
  ].map(({ rowId, orderPrefix, productPrefix }) => ({
    rowId,
    check: "return-exceeds-delivered",
    severity: "high",
    needsHuman: true,
    target: { orderPrefix, productPrefix },
    options: [
      "mark-delivered-full: the goods WERE handed over but the driver flow never recorded delivery — set the order line's deliveredQty = ordered qty. Consequence: delivery analytics/fulfillment now claim a full delivery for this line.",
      "mark-delivered-returned-only: record only the minimum delivery that makes the return legal — set deliveredQty = returned qty. Choose when partial delivery is plausible but unverifiable.",
      "cancel-return (NOT run by this script): the return was recorded in error (goods never delivered). Cancel/reject it in the app so its stock restock and any credit note are reversed through the service paths.",
    ],
    async plan(db, ctx) {
      // Resolve the truncated forensic pair (orderId:productId prefixes) to exactly one real pair.
      const pairs = await q(
        db,
        `SELECT DISTINCT r."orderId", ri."productId"
         FROM "ReturnItem" ri JOIN "Return" r ON r.id = ri."returnId"
         WHERE r."orderId"::text LIKE $1 || '%' AND ri."productId"::text LIKE $2 || '%'`,
        [orderPrefix, productPrefix],
      );
      if (pairs.length !== 1)
        return {
          blocked: `Prefix ${orderPrefix}…:${productPrefix}… resolves to ${pairs.length} (order, product) pairs — must be exactly 1. Aborting this row.`,
        };
      const { orderId, productId } = pairs[0];
      const lines = await q(
        db,
        `SELECT id, qty::float8, "deliveredQty"::float8, "invoicedQty"::float8
         FROM "OrderItem" WHERE "orderId" = $1 AND "productId" = $2 ${ctx.inTx ? "FOR UPDATE" : ""}`,
        [orderId, productId],
      );
      const [ret] = await q(
        db,
        `SELECT COALESCE(SUM(ri.qty), 0)::float8 AS returned,
                array_agg(DISTINCT r.id) AS return_ids,
                array_agg(DISTINCT r.status::text) AS statuses
         FROM "ReturnItem" ri JOIN "Return" r ON r.id = ri."returnId"
         WHERE r."orderId" = $1 AND ri."productId" = $2
           AND r.status NOT IN ('CANCELLED','REJECTED')`,
        [orderId, productId],
      );
      const ordered = lines.reduce((s, l) => s + l.qty, 0);
      const delivered = lines.reduce((s, l) => s + l.deliveredQty, 0);
      const before = {
        orderId,
        productId,
        lines: lines.map((l) => ({ id: l.id, qty: l.qty, deliveredQty: l.deliveredQty })),
        returned: ret.returned,
      };
      const base = {
        before,
        lockRows: lines.map((l) => ({ table: "OrderItem", id: l.id })),
        verify: { check: "return-exceeds-delivered", params: [orderId, productId] },
        notes: [
          `Order ${orderId} / product ${productId}: ordered=${ordered}, delivered=${delivered}, returned=${ret.returned} (returns: ${(ret.return_ids ?? []).join(", ")}; statuses: ${(ret.statuses ?? []).join(", ")})`,
        ],
      };
      if (ret.returned <= delivered + 0.001)
        return {
          ...base,
          blocked: "Return no longer exceeds delivered — nothing to do (already repaired?)",
        };
      if (lines.length !== 1)
        return {
          ...base,
          blocked: `Order has ${lines.length} lines for this product — distributing deliveredQty across them is a human call.`,
        };
      const line = lines[0];
      const res = ctx.resolution;
      if (res !== "mark-delivered-full" && res !== "mark-delivered-returned-only") {
        return {
          ...base,
          proposal: `NEEDS A HUMAN DECISION — were the goods actually delivered? Executable options: --resolution ${rowId}=mark-delivered-full | mark-delivered-returned-only; or cancel the return in the app.`,
          actions: [],
          blocked:
            EXECUTE && ctx.confirmed ? "No --resolution given for a needs-human row" : undefined,
        };
      }
      const newDelivered =
        res === "mark-delivered-full" ? line.qty : Math.min(line.qty, ret.returned);
      if (newDelivered <= line.deliveredQty + 0.001)
        return {
          ...base,
          blocked: "Chosen resolution would not increase deliveredQty — nothing to do",
        };
      return {
        ...base,
        proposal: `OrderItem ${line.id}: deliveredQty ${line.deliveredQty} → ${newDelivered} (${res})`,
        actions: [
          {
            label: `OrderItem ${line.id}: deliveredQty → ${newDelivered}`,
            sql: `UPDATE "OrderItem" SET "deliveredQty" = $2, "updatedAt" = now() WHERE id = $1`,
            params: [line.id, newDelivered],
          },
        ],
      };
    },
  })),

  {
    rowId: "tenantdrift-23fae434",
    check: "tenant-drift-return",
    severity: "high",
    needsHuman: false,
    target: { returnId: "23fae434-d2a6-465f-a8fd-ac0d52cffa3a" },
    async plan(db, ctx) {
      const t = this.target.returnId;
      const r = (
        await q(
          db,
          `SELECT r.id, r."tenantId" AS return_tenant, o."tenantId" AS order_tenant, r."orderId"
           FROM "Return" r JOIN "Order" o ON o.id = r."orderId"
           WHERE r.id = $1 ${ctx.inTx ? "FOR UPDATE OF r" : ""}`,
          [t],
        )
      )[0];
      if (!r) return { blocked: `Return ${t} not found` };
      const items = await q(
        db,
        `SELECT id, "tenantId" FROM "ReturnItem" WHERE "returnId" = $1 ORDER BY id`,
        [t],
      );
      const driftedItems = items.filter((i) => i.tenantId !== r.order_tenant);
      const before = {
        return: { id: r.id, tenantId: r.return_tenant },
        orderTenant: r.order_tenant,
        driftedItemIds: driftedItems.map((i) => i.id),
      };
      const base = {
        before,
        lockRows: [{ table: "Return", id: t }],
        verify: { check: "tenant-drift-return", params: [t] },
        notes: [
          `Return ${t}: tenantId=${r.return_tenant ?? "NULL"} vs its Order ${r.orderId} tenantId=${r.order_tenant}`,
          `Child ReturnItems with drifted tenantId (repaired together, else the tenant-drift-returnitem check fires next): ${driftedItems.map((i) => i.id).join(", ") || "none"}`,
        ],
      };
      if (!r.order_tenant)
        return { ...base, blocked: "Order has NULL tenantId — cannot derive; escalate." };
      if (r.return_tenant === r.order_tenant && driftedItems.length === 0)
        return { ...base, blocked: "No drift — nothing to do (already repaired?)" };
      const actions = [
        {
          label: `Return ${t}: tenantId → ${r.order_tenant} (its Order's tenant)`,
          sql: `UPDATE "Return" SET "tenantId" = $2, "updatedAt" = now() WHERE id = $1`,
          params: [t, r.order_tenant],
        },
      ];
      for (const i of driftedItems) {
        actions.push({
          label: `ReturnItem ${i.id}: tenantId → ${r.order_tenant}`,
          sql: `UPDATE "ReturnItem" SET "tenantId" = $2 WHERE id = $1`,
          params: [i.id, r.order_tenant],
        });
      }
      return {
        ...base,
        proposal: `Stamp Return + its ${driftedItems.length} drifted child item(s) with the Order's tenantId so forTenant() scoping sees them again`,
        actions,
      };
    },
  },

  // ── OPTIONAL HYGIENE ───────────────────────────────────────────────────────
  {
    rowId: "orphantpl-15e9d9f1",
    check: "orphaned-recurring-template",
    severity: "hygiene",
    needsHuman: false,
    target: { templateId: "15e9d9f1-f333-40ec-8ac2-cecd840fe668" },
    async plan(db, ctx) {
      const t = this.target.templateId;
      const row = (
        await q(
          db,
          `SELECT r.id, r."isActive", r."tenantId", r."nextRunAt", r."lastRunAt",
                  (t.id IS NOT NULL) AS tenant_exists
           FROM "RecurringInvoice" r LEFT JOIN "Tenant" t ON t.id = r."tenantId"
           WHERE r.id = $1 ${ctx.inTx ? "FOR UPDATE OF r" : ""}`,
          [t],
        )
      )[0];
      if (!row) return { blocked: `RecurringInvoice ${t} not found` };
      const before = {
        template: { id: row.id, isActive: row.isActive, tenantExists: row.tenant_exists },
      };
      const base = {
        before,
        lockRows: [{ table: "RecurringInvoice", id: t }],
        verify: {
          customSql: `SELECT id FROM "RecurringInvoice" WHERE id = $1 AND "isActive" = true`,
          params: [t],
          cleanWhenEmpty: true,
        },
        notes: [
          `Template ${t}: isActive=${row.isActive}, tenantId=${row.tenantId ?? "NULL"}, tenant row exists=${row.tenant_exists}`,
        ],
      };
      if (row.tenant_exists)
        return {
          ...base,
          blocked: "Tenant row exists after all — this is not an orphan; escalate.",
        };
      if (!row.isActive) return { ...base, blocked: "Already inactive — nothing to do" };
      return {
        ...base,
        proposal:
          "Deactivate (isActive → false). Reversible; deleting the template + items outright is documented in the runbook as the alternative once the owner confirms the tenant is gone for good.",
        actions: [
          {
            label: `RecurringInvoice ${t}: isActive → false`,
            sql: `UPDATE "RecurringInvoice" SET "isActive" = false, "updatedAt" = now() WHERE id = $1`,
            params: [t],
          },
        ],
      };
    },
  },

  {
    rowId: "stalledtpl-61bc82ba",
    check: "stalled-recurring-template",
    severity: "hygiene",
    needsHuman: false,
    target: { templateId: "61bc82ba-eb23-47cd-802f-10715352fd92" },
    async plan(db, ctx) {
      const t = this.target.templateId;
      const row = (
        await q(
          db,
          `SELECT id, "isActive", "nextRunAt", "lastRunAt", frequency::text
           FROM "RecurringInvoice" WHERE id = $1 ${ctx.inTx ? "FOR UPDATE" : ""}`,
          [t],
        )
      )[0];
      if (!row) return { blocked: `RecurringInvoice ${t} not found` };
      const before = {
        template: {
          id: row.id,
          isActive: row.isActive,
          nextRunAt: row.nextRunAt?.toISOString?.() ?? String(row.nextRunAt),
          lastRunAt: row.lastRunAt?.toISOString?.() ?? String(row.lastRunAt),
        },
      };
      const base = {
        before,
        lockRows: [{ table: "RecurringInvoice", id: t }],
        verify: {
          customSql: `SELECT id FROM "RecurringInvoice" WHERE id = $1 AND "isActive" = true AND "nextRunAt" < now()`,
          params: [t],
          cleanWhenEmpty: true,
        },
        notes: [
          `Template ${t}: isActive=${row.isActive}, frequency=${row.frequency}, lastRunAt=${before.template.lastRunAt}, nextRunAt=${before.template.nextRunAt} (B46 dead-advance fingerprint: lastRunAt == nextRunAt, months in the past)`,
        ],
      };
      if (!row.isActive) return { ...base, blocked: "Already inactive — nothing to do" };
      return {
        ...base,
        proposal:
          "Deactivate (isActive → false) so a tenant reactivation cannot trigger nightly duplicate invoicing off the stuck nextRunAt. If the client returns, re-enable it from the app AFTER setting a future nextRunAt (see runbook).",
        actions: [
          {
            label: `RecurringInvoice ${t}: isActive → false`,
            sql: `UPDATE "RecurringInvoice" SET "isActive" = false, "updatedAt" = now() WHERE id = $1`,
            params: [t],
          },
        ],
      };
    },
  },
];

// ─── Audit log ───────────────────────────────────────────────────────────────
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const LOG_PATH = path.join(
  repoRoot,
  "local-assets",
  `repair-log-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
);
function auditLog(entry) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
}

// ─── Runner ──────────────────────────────────────────────────────────────────
function printPlan(row, plan) {
  const tag = row.needsHuman ? "HUMAN-DECISION" : "auto";
  console.log(`\n━━━ ${row.rowId}  [${row.check} · ${row.severity} · ${tag}] ━━━`);
  for (const n of plan.notes ?? []) console.log(`  ${n}`);
  if (plan.blocked) {
    console.log(`  ⛔ ${plan.blocked}`);
  }
  if (plan.proposal) console.log(`  → PROPOSAL: ${plan.proposal}`);
  if (row.options?.length) {
    console.log("  Options:");
    for (const o of row.options) console.log(`    • ${o}`);
  }
  if (plan.actions?.length) {
    console.log("  SQL it would run (one transaction, in order):");
    for (const a of plan.actions) {
      console.log(`    -- ${a.label}`);
      console.log(
        "    " +
          a.sql.replace(/\s+/g, " ").trim() +
          "   -- params: " +
          JSON.stringify(a.params.map((p) => (p instanceof Date ? p.toISOString() : p))),
      );
    }
  }
}

async function runVerify(plan) {
  const v = plan.verify;
  if (!v) return { skipped: true };
  const sql = v.customSql ?? VERIFY[v.check].sql;
  const rows = await q(client, sql, v.params);
  return { clean: rows.length === 0, remaining: rows.length };
}

async function executeRow(row, dryPlan) {
  const ctx = {
    inTx: true,
    confirmed: true,
    resolution: RESOLUTIONS.get(row.rowId) ?? null,
    paymentId: PAYMENT_ID,
    mintedAdvanceId: dryPlan.ctxMintedAdvanceId,
  };
  await client.query("BEGIN");
  try {
    // Lock every row the plan touches, then re-plan INSIDE the transaction.
    for (const l of dryPlan.lockRows ?? []) {
      await client.query(`SELECT id FROM "${l.table}" WHERE id = $1 FOR UPDATE`, [l.id]);
    }
    const fresh = await row.plan.call(row, client, ctx);
    if (fresh.blocked) {
      await client.query("ROLLBACK");
      console.log(`  ⛔ ABORTED (in-tx): ${fresh.blocked}`);
      return { rowId: row.rowId, status: "aborted", reason: fresh.blocked };
    }
    if (canonical(fresh.before) !== canonical(dryPlan.before)) {
      await client.query("ROLLBACK");
      console.log("  ⛔ ABORTED: the row CHANGED between the dry-run read and the transaction.");
      console.log(`     dry-run: ${canonical(dryPlan.before)}`);
      console.log(`     now:     ${canonical(fresh.before)}`);
      return { rowId: row.rowId, status: "aborted", reason: "row changed since dry run" };
    }
    for (const a of fresh.actions) {
      const res = await client.query(a.sql, a.params);
      console.log(`  ✔ ${a.label}  (${res.rowCount} row${res.rowCount === 1 ? "" : "s"})`);
    }
    await client.query("COMMIT");
    const verify = await runVerify(fresh);
    console.log(
      verify.skipped
        ? "  verify: (no forensic check for this row)"
        : verify.clean
          ? "  ✅ forensic re-check: CLEAN (0 rows)"
          : `  ❌ forensic re-check: STILL DIRTY (${verify.remaining} rows) — investigate before touching anything else`,
    );
    auditLog({
      ts: new Date().toISOString(),
      rowId: row.rowId,
      check: row.check,
      resolution: ctx.resolution,
      before: fresh.before,
      proposal: fresh.proposal,
      sql: fresh.actions.map((a) => ({
        label: a.label,
        sql: a.sql.replace(/\s+/g, " ").trim(),
        params: a.params.map((p) => (p instanceof Date ? p.toISOString() : p)),
      })),
      verify,
    });
    return { rowId: row.rowId, status: "executed", verify };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.log(`  ⛔ ERROR — rolled back: ${err.message}`);
    return { rowId: row.rowId, status: "error", reason: err.message };
  }
}

async function main() {
  if (LIST) {
    console.log("Row registry (use these ids with --confirm / --resolution):\n");
    for (const r of ROWS) {
      console.log(
        `  ${r.rowId}  [${r.check} · ${r.severity}]  ${r.needsHuman ? "NEEDS-HUMAN" : "auto"}`,
      );
      for (const o of r.options ?? []) console.log(`      • ${o}`);
    }
    return;
  }

  await client.connect();
  await client.query("SET statement_timeout = '60s'");
  if (!EXECUTE) {
    // Dry run: the server itself refuses any write that might slip in.
    await client.query("SET default_transaction_read_only = on");
  }

  const [{ db }] = await q(client, "SELECT current_database() AS db");
  // Railway names this project's prod DB "routeflow"; "railway" is the platform default.
  const PROD_DB_NAMES = new Set(["railway", "routeflow"]);
  const looksProd = PROD_DB_NAMES.has(db) && !/test|local|dev|qa|e2e/i.test(db);
  if (!looksProd && !FORCE_NONPROD) {
    console.error(
      `Connected to database "${db}", which does not look like production (expected "routeflow" or "railway").\n` +
        "This script repairs SPECIFIC production rows; running it elsewhere is almost\n" +
        "certainly a mistake. Pass --force-nonprod to proceed anyway.",
    );
    process.exit(2);
  }

  const unknownConfirms = [...CONFIRMED].filter((c) => !ROWS.some((r) => r.rowId === c));
  if (unknownConfirms.length) {
    console.error(`Unknown --confirm row id(s): ${unknownConfirms.join(", ")} — see --list`);
    process.exit(2);
  }
  for (const rid of RESOLUTIONS.keys()) {
    if (!ROWS.some((r) => r.rowId === rid)) {
      console.error(`--resolution names unknown row id: ${rid} — see --list`);
      process.exit(2);
    }
  }

  console.log(
    `\n=== ROUTEFLOW INTEGRITY REPAIR — ${EXECUTE ? "EXECUTE" : "DRY RUN (read-only session)"} ===`,
  );
  console.log(`    database: ${db}${looksProd ? " (production)" : " (NON-PROD, forced)"}`);
  console.log(`    ${new Date().toISOString()}`);
  if (EXECUTE) console.log(`    audit log: ${LOG_PATH}`);

  const results = [];
  for (const row of ROWS) {
    const willExecute = EXECUTE && CONFIRMED.has(row.rowId);
    const ctx = {
      inTx: false,
      confirmed: willExecute,
      resolution: RESOLUTIONS.get(row.rowId) ?? null,
      paymentId: PAYMENT_ID,
      // Minted ids must be identical between the dry plan and the in-tx plan.
      mintedAdvanceId: randomUUID(),
    };
    let plan;
    try {
      plan = await row.plan.call(row, client, ctx);
      plan.ctxMintedAdvanceId = ctx.mintedAdvanceId;
    } catch (err) {
      plan = { blocked: `plan failed: ${err.message}` };
    }
    printPlan(row, plan);

    if (!willExecute) {
      if (EXECUTE)
        console.log("  (not confirmed — skipped; add --confirm " + row.rowId + " to run it)");
      results.push({ rowId: row.rowId, status: plan.blocked ? "blocked" : "planned" });
      continue;
    }
    if (plan.blocked) {
      results.push({ rowId: row.rowId, status: "blocked", reason: plan.blocked });
      continue;
    }
    if (row.needsHuman && !RESOLUTIONS.has(row.rowId)) {
      console.log("  ⛔ Refusing to execute a needs-human row without --resolution.");
      results.push({ rowId: row.rowId, status: "blocked", reason: "needs --resolution" });
      continue;
    }
    if (!plan.actions?.length) {
      results.push({ rowId: row.rowId, status: "noop" });
      continue;
    }
    console.log("  EXECUTING (one transaction, before-state re-verified inside)…");
    results.push(await executeRow(row, plan));
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(`  ${r.rowId.padEnd(24)} ${r.status}${r.reason ? `  (${r.reason})` : ""}`);
  }
  if (!EXECUTE) {
    console.log(
      "\nDry run only — nothing was written. To repair a row:\n" +
        "  1. Take + VERIFY a fresh backup (runbook §2).\n" +
        "  2. Re-run with --execute --i-have-a-fresh-backup --confirm <rowId>\n" +
        "     (+ --resolution <rowId>=<option> for needs-human rows).\n" +
        "  3. Re-run scripts/data-integrity-report.mjs --verbose afterwards.",
    );
  } else {
    console.log(
      `\nAudit log: ${fs.existsSync(LOG_PATH) ? LOG_PATH : "(no repairs executed — no log written)"}`,
    );
  }
  const failed = results.some(
    (r) =>
      r.status === "error" ||
      (r.status === "executed" && r.verify && !r.verify.clean && !r.verify.skipped),
  );
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("Repair run failed:", err.message);
    process.exitCode = 2;
  })
  .finally(() => client?.end());
