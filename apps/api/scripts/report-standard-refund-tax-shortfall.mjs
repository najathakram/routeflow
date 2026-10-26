/**
 * READ-ONLY report (SA-840 section 5, B704 / #1477): what REFUNDED STANDARD returns paid out net-only, against what
 * `refundableProductPoolShare` (@routeflow/pricing, the compiled package, SA-970) says the invoice charged on the returned
 * slice.
 *
 * Per return it fills the returned qty over the order's creditable invoice lines (oldest invoice first, paid lines
 * first, each in row order, like `planProductRefund`), prices each invoice's filled qty as ONE slice of the product's
 * pool on that invoice with `refundableProductPoolShare` (exactly like the mint's `priceProductSlice`), using the
 * credits on the lines EARLIER than `refundedAt` as `prior`, and compares with the stored `Return.refundAmount`
 * (and the linked `CreditNote.amount`; a frozen `creditSubtotal` wins where the claim wrote one).
 *
 * Output: ONE row per (tenantId, YYYY-MM of refundedAt, method) with the columns in COLUMNS below, as CSV to stdout and
 * to local-assets/handoff/ (gitignored). Tenant ids and counts / sums only: no customer, name, slug, document number
 * or line detail. The over-credit column (net paid above the discounted net, on returns whose invoice carries a
 * discount) is its own column and is never netted against the missing-tax columns.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs it, in two steps (the live-target guard): once to see the
 * host it resolves to, then naming that host.
 *
 *   railway run --service postgres node apps/api/scripts/report-standard-refund-tax-shortfall.mjs
 *   railway run --service postgres node apps/api/scripts/report-standard-refund-tax-shortfall.mjs \
 *     --target-host=<the host it printed> [--tenant <tenant id>]
 *
 *   node apps/api/scripts/report-standard-refund-tax-shortfall.mjs --self-test   (no database)
 *
 * SAFETY
 *   - Live-target guard: prints the DB host and database name and refuses BEFORE connecting unless
 *     `--target-host=<host>` equals the resolved host (exit 64 when missing, 65 on a mismatch). No credentials.
 *   - The first statements are the session read-only settings, then BEGIN READ ONLY; it exits 2 unless
 *     SHOW transaction_read_only is `on`. Plain reads only; the transaction ends with ROLLBACK. No write flag exists.
 *   - `--tenant` takes a tenant id (uuid), never a slug. Default scope is all tenants.
 *   - Repair is not automated: a supplementary credit note is the owner's per-tenant decision.
 */
import { createRequire } from "module";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isNsfLine,
  refundableProductPoolShare,
  roundMoney,
  sumInvoiceTotals,
} from "@routeflow/pricing";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const require = createRequire(import.meta.url);
const NAME = "report-standard-refund-tax-shortfall";

export const COLUMNS = [
  "tenantId",
  "month",
  "method",
  "returns",
  "creditNotes",
  "missingRegularTax",
  "missingCategoryTax",
  "netOverCreditUnsharedDiscount",
  "invoicesTaxDiffersFromPools",
  "unpriced",
];

const READ_ONLY_SESSION = [
  "SET default_transaction_read_only = on",
  "SET statement_timeout = '120s'",
  "SET lock_timeout = '5s'",
  "SET idle_in_transaction_session_timeout = '300s'",
];
export const BEGIN_READ_ONLY = "BEGIN READ ONLY";
export const SHOW_READ_ONLY = "SHOW transaction_read_only";
const CHUNK = 2000;

const Q_RETURNS = `SELECT r."id", r."tenantId", r."orderId", r."refundMethod", r."refundAmount", r."refundedAt",
  r."creditNoteId", r."creditSubtotal", r."creditTax", r."creditCategoryTax"
FROM "Return" r
WHERE r."kind" = 'STANDARD' AND r."status" = 'REFUNDED' AND r."refundedAt" IS NOT NULL AND r."tenantId" IS NOT NULL
  AND ($1::text IS NULL OR r."tenantId" = $1)
ORDER BY r."refundedAt", r."id"`;
const Q_RETURN_ITEMS = `SELECT "returnId", "productId", SUM("qty")::text AS "qty" FROM "ReturnItem"
WHERE "returnId" = ANY($1::text[]) GROUP BY "returnId", "productId"`;
const Q_INVOICES = `SELECT "id", "orderId", "taxAmount", "discount", "createdAt" FROM "Invoice"
WHERE "orderId" = ANY($1::text[]) AND "status" NOT IN ('VOID', 'WRITTEN_OFF') ORDER BY "createdAt", "id"`;
const Q_INVOICE_ITEMS = `SELECT "id", "invoiceId", "productId", "qty", "subtotal", "taxRate", "categoryTaxAmount",
  "systemKind", "description" FROM "InvoiceItem" WHERE "invoiceId" = ANY($1::text[]) ORDER BY "createdAt", "id"`;
const Q_CREDITS = `SELECT ci."invoiceItemId", ci."amount", ci."qty", ci."categoryTax", cn."id" AS "creditNoteId",
  cn."createdAt" AS "at" FROM "CreditNoteItem" ci JOIN "CreditNote" cn ON cn."id" = ci."creditNoteId"
WHERE cn."status" <> 'VOID' AND ci."invoiceItemId" = ANY($1::text[])`;
const Q_NOTES = `SELECT "id", "amount" FROM "CreditNote" WHERE "id" = ANY($1::text[])`;

const num = (v) => Number(v ?? 0);

/** The `YYYY-MM` bucket of an instant (UTC, like the database stores it). */
export const monthOf = (d) => new Date(d).toISOString().slice(0, 7);

const round3 = (n) => Math.round(n * 1000) / 1000;
const EPS = 0.001; // the headroom planner's qty tolerance

/**
 * Price ONE return, the way the mint does (`priceProductSlice` + `planProductRefund`, SA-970). A return item names only the
 * PRODUCT, so its qty is filled over the product's invoice lines (oldest invoice first, paid lines first, each in row order),
 * then each invoice's filled qty is priced as ONE slice of that invoice's product POOL with `refundableProductPoolShare`, using
 * the credits on each line EARLIER than `refundedAt` as `prior`. Quantities are on the line's own axis (factor 1).
 * `ctx` is { invoices: [{id, taxAmount, discount, lines:[{id, productId, qty, subtotal, taxRate,
 * categoryTaxAmount, isNsf}]}] oldest first, credits: Map(lineId -> [{qty, amount, categoryTax, at, creditNoteId}]) }.
 * Returns { net, tax, categoryTax, discounted } for the slices the returned items fill, or null when nothing is billed.
 */
export function priceReturn(ret, items, ctx) {
  let net = 0;
  let tax = 0;
  let categoryTax = 0;
  let filled = false;
  for (const { productId, qty } of items) {
    const mine = [];
    for (const inv of ctx.invoices) {
      for (const l of inv.lines) {
        if (l.productId !== productId || !(num(l.qty) > 0)) continue;
        const prior = { qty: 0, net: 0, tax: 0, categoryTax: 0 };
        for (const c of ctx.credits.get(l.id) ?? []) {
          if (c.creditNoteId === ret.creditNoteId || !(new Date(c.at) < new Date(ret.refundedAt)))
            continue;
          prior.qty += num(c.qty);
          prior.net += num(c.amount);
          prior.categoryTax += num(c.categoryTax);
        }
        mine.push({ inv, l, prior, take: 0 });
      }
    }
    // the fill order of `planProductRefund`: paid lines first, $0 lines last (stable), each up to its remaining qty
    mine.sort((a, b) => Number(num(b.l.subtotal) > EPS) - Number(num(a.l.subtotal) > EPS));
    let left = round3(
      Math.min(
        num(qty),
        mine.reduce((t, m) => t + num(m.l.qty), 0),
      ),
    );
    for (const m of mine) {
      if (left <= EPS) break;
      const take = Math.min(left, Math.max(0, round3(num(m.l.qty) - m.prior.qty)));
      if (take <= EPS) continue;
      m.take = round3(take);
      left = round3(left - take);
    }
    const pools = new Map();
    for (const m of mine) pools.set(m.inv, [...(pools.get(m.inv) ?? []), m]);
    for (const [inv, group] of pools) {
      const pool = group.reduce((t, m) => t + num(m.l.qty), 0);
      const priorPieces = group.reduce((t, m) => t + m.prior.qty, 0);
      let returnedPieces = round3(group.reduce((t, m) => t + m.take, 0));
      if (returnedPieces <= 0) continue;
      // the 3-dp round trip of a pieces conversion, never a clip
      const room = Math.max(0, round3(pool - priorPieces));
      if (returnedPieces > room && returnedPieces - room <= 0.002) returnedPieces = room;
      const share = refundableProductPoolShare({
        invoice: { taxAmount: inv.taxAmount, discount: inv.discount, lines: inv.lines },
        lines: group.map((m) => ({ id: m.l.id, pieces: num(m.l.qty), prior: m.prior })),
        returnedPieces,
      });
      if (share.refusal) continue;
      filled = true;
      net += share.net;
      tax += share.tax;
      categoryTax += share.categoryTax;
    }
  }
  if (!filled) return null;
  const discounted = ctx.invoices.some((i) => num(i.discount) > 0);
  return {
    net: roundMoney(net),
    tax: roundMoney(tax),
    categoryTax: roundMoney(categoryTax),
    discounted,
  };
}

/** Does the invoice's stored tax differ from the `sumInvoiceTotals` pools? A stored 0 is an exempt invoice: not counted. */
export function taxDiffersFromPools(inv) {
  const stored = roundMoney(num(inv.taxAmount));
  if (stored === 0) return false;
  const pools = sumInvoiceTotals(
    inv.lines.map((l) => ({
      subtotal: num(l.subtotal),
      taxRate: num(l.taxRate),
      categoryTaxAmount: num(l.categoryTaxAmount),
    })),
    { discount: num(inv.discount) },
  );
  return Math.abs(pools.tax - stored) > 0.005;
}

/** Fold priced returns into the bucket rows. `rows` are { tenantId, month, method, hasNote, paidNet, priced, ... }. */
export function foldBuckets(rows) {
  const out = new Map();
  for (const r of rows) {
    const key = `${r.tenantId}|${r.month}|${r.method}`;
    const b = out.get(key) ?? {
      tenantId: r.tenantId,
      month: r.month,
      method: r.method,
      returns: 0,
      creditNotes: 0,
      missingRegularTax: 0,
      missingCategoryTax: 0,
      netOverCreditUnsharedDiscount: 0,
      invoicesTaxDiffersFromPools: 0,
      unpriced: 0,
      seen: new Set(),
    };
    out.set(key, b);
    b.returns += 1;
    if (r.hasNote) b.creditNotes += 1;
    for (const inv of r.invoices) {
      if (b.seen.has(inv.id)) continue;
      b.seen.add(inv.id);
      if (taxDiffersFromPools(inv)) b.invoicesTaxDiffersFromPools += 1;
    }
    if (!r.priced) {
      b.unpriced += 1;
      continue;
    }
    b.missingRegularTax = roundMoney(b.missingRegularTax + Math.max(0, r.priced.tax - r.frozenTax));
    b.missingCategoryTax = roundMoney(
      b.missingCategoryTax + Math.max(0, r.priced.categoryTax - r.frozenCategoryTax),
    );
    if (r.priced.discounted)
      b.netOverCreditUnsharedDiscount = roundMoney(
        b.netOverCreditUnsharedDiscount + Math.max(0, r.paidNet - r.priced.net),
      );
  }
  return [...out.values()]
    .map(({ seen, ...row }) => row)
    .sort(
      (a, b) =>
        COLUMNS.slice(0, 3)
          .map((k) => String(a[k]).localeCompare(String(b[k])))
          .find(Boolean) ?? 0,
    );
}

export const toCsv = (rows) =>
  [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((k) => r[k]).join(","))].join("\n") + "\n";

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Arguments: `--target-host=<host>`, `--tenant <id>`, `--self-test`. Anything else (a write flag too) is refused. */
export function checkArgs(argv) {
  const hosts = argv.filter((a) => a.startsWith("--target-host="));
  if (hosts.length > 1) return { ok: false, message: "--target-host given more than once" };
  const at = argv.indexOf("--tenant");
  for (const [i, a] of argv.entries()) {
    if (a.startsWith("--target-host=") || a === "--tenant" || a === "--self-test") continue;
    if (i > 0 && i - 1 === at) continue;
    return {
      ok: false,
      message: `unexpected argument ${a} (this report is read-only and has no write mode)`,
    };
  }
  const tenant = at >= 0 ? argv[at + 1] : null;
  if (at >= 0 && !(tenant && TENANT_ID.test(tenant)))
    return { ok: false, message: "--tenant takes a tenant id (uuid), never a slug" };
  return {
    ok: true,
    selfTest: argv.includes("--self-test"),
    tenant,
    targetHost: hosts.length ? hosts[0].slice("--target-host=".length) : null,
  };
}

/** Host and database name of a postgres URL, for the type-back guard. Never the credentials. */
export function targetOf(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "(default)",
  };
}

/** Exit 64 when `--target-host` is missing, 65 when it does not equal the resolved host. */
export function guardTarget(targetHost, target) {
  if (!targetHost)
    return {
      ok: false,
      code: 64,
      message: "refusing: --target-host=<host> is required (run once without it to see the host)",
    };
  if (targetHost !== target.host)
    return {
      ok: false,
      code: 65,
      message: `refusing: --target-host=${targetHost} does not match the resolved host ${target.host}`,
    };
  return { ok: true };
}

/** Session read-only settings, BEGIN READ ONLY, proof it is on (exit 2 otherwise), `fn`, then ROLLBACK. */
export async function withReadOnlyTx(client, fn) {
  for (const sql of READ_ONLY_SESSION) await client.query(sql);
  await client.query(BEGIN_READ_ONLY);
  try {
    const flag = (await client.query(SHOW_READ_ONLY)).rows?.[0]?.transaction_read_only;
    if (flag !== "on") {
      const e = new Error(`aborting: transaction_read_only is "${flag}", expected "on"`);
      e.exitCode = 2;
      throw e;
    }
    return await fn();
  } finally {
    await client.query("ROLLBACK");
  }
}

const chunks = (ids) =>
  Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) =>
    ids.slice(i * CHUNK, (i + 1) * CHUNK),
  );
async function readAll(client, sql, ids) {
  const out = [];
  for (const c of chunks(ids)) out.push(...(await client.query(sql, [c])).rows);
  return out;
}

/** The whole report, inside the caller's READ ONLY transaction. Returns the bucket rows. */
export async function buildReport(client, { tenant = null } = {}) {
  const returns = (await client.query(Q_RETURNS, [tenant])).rows;
  const ids = returns.map((r) => r.id);
  const orderIds = [...new Set(returns.map((r) => r.orderId))];
  const itemsOf = new Map();
  for (const it of await readAll(client, Q_RETURN_ITEMS, ids))
    itemsOf.set(it.returnId, [
      ...(itemsOf.get(it.returnId) ?? []),
      { productId: it.productId, qty: it.qty },
    ]);
  const invoiceRows = await readAll(client, Q_INVOICES, orderIds);
  const lineRows = await readAll(
    client,
    Q_INVOICE_ITEMS,
    invoiceRows.map((i) => i.id),
  );
  const invoicesOfOrder = new Map();
  const linesOf = new Map();
  for (const l of lineRows)
    linesOf.set(l.invoiceId, [...(linesOf.get(l.invoiceId) ?? []), { ...l, isNsf: isNsfLine(l) }]);
  for (const i of invoiceRows)
    invoicesOfOrder.set(i.orderId, [
      ...(invoicesOfOrder.get(i.orderId) ?? []),
      { ...i, lines: linesOf.get(i.id) ?? [] },
    ]);
  const credits = new Map();
  for (const c of await readAll(
    client,
    Q_CREDITS,
    lineRows.map((l) => l.id),
  ))
    credits.set(c.invoiceItemId, [...(credits.get(c.invoiceItemId) ?? []), c]);
  const noteAmount = new Map(
    (await readAll(client, Q_NOTES, returns.map((r) => r.creditNoteId).filter(Boolean))).map(
      (n) => [n.id, num(n.amount)],
    ),
  );

  const rows = returns.map((r) => {
    const invoices = invoicesOfOrder.get(r.orderId) ?? [];
    const paidGross =
      r.refundMethod === "CREDIT_NOTE"
        ? (noteAmount.get(r.creditNoteId) ?? num(r.refundAmount))
        : num(r.refundAmount);
    return {
      tenantId: r.tenantId,
      month: monthOf(r.refundedAt),
      method: r.refundMethod ?? "UNKNOWN",
      hasNote: !!r.creditNoteId,
      invoices,
      paidNet: r.creditSubtotal != null ? num(r.creditSubtotal) : paidGross,
      frozenTax: num(r.creditTax),
      frozenCategoryTax: num(r.creditCategoryTax),
      priced: priceReturn(r, itemsOf.get(r.id) ?? [], { invoices, credits }),
    };
  });
  return foldBuckets(rows);
}

/** No-DB checks of the pure part (`--self-test`). Throws on the first failure. */
export async function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`self-test ${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  // one 100.00 / 10-unit line, rate 8%, 10.00 levy: invoice tax 18.00. Returning 5 units charged 50 + 4 tax + 5 levy.
  const line = {
    id: "l1",
    productId: "p",
    qty: "10",
    subtotal: "100",
    taxRate: "0.08",
    categoryTaxAmount: "10",
    isNsf: false,
  };
  const inv = (discount) => ({ id: "i1", taxAmount: "18", discount, lines: [line] });
  const ret = { creditNoteId: null, refundedAt: "2026-09-10T00:00:00Z" };
  const price = (discount) =>
    priceReturn(ret, [{ productId: "p", qty: "5" }], {
      invoices: [inv(discount)],
      credits: new Map(),
    });
  eq(price("0"), { net: 50, tax: 4, categoryTax: 5, discounted: false }, "undiscounted slice");
  eq(price("10").net, 45, "discounted net");
  // SA-970: a cheap and a dear line of one product, 1 of 2 pieces, is priced over the POOL (75 + 6), not the dear line
  const lv = { ...line, categoryTaxAmount: "0", qty: "1" };
  const pooled = priceReturn(ret, [{ productId: "p", qty: "1" }], {
    invoices: [
      {
        id: "i2",
        taxAmount: "12",
        discount: "0",
        lines: [
          { ...lv, id: "dear", subtotal: "100" },
          { ...lv, id: "cheap", subtotal: "50" },
        ],
      },
    ],
    credits: new Map(),
  });
  eq([pooled.net, pooled.tax], [75, 6], "pooled slice");
  const row = (discount, paidNet) => ({
    tenantId: "t1",
    month: "2026-09",
    method: "CREDIT_NOTE",
    hasNote: true,
    invoices: [inv(discount)],
    paidNet,
    frozenTax: 0,
    frozenCategoryTax: 0,
    priced: price(discount),
  });
  const [plain] = foldBuckets([row("0", 50)]);
  eq(
    [plain.missingRegularTax, plain.missingCategoryTax, plain.netOverCreditUnsharedDiscount],
    [4, 5, 0],
    "net-only refund",
  );
  const [disc] = foldBuckets([row("10", 50)]);
  eq(
    [disc.missingRegularTax, disc.netOverCreditUnsharedDiscount, disc.creditNotes],
    [4, 5, 1],
    "own over-credit column",
  );
  const fixed = { ...row("0", 50), frozenTax: 4, frozenCategoryTax: 5 };
  eq(foldBuckets([fixed])[0].missingRegularTax, 0, "a frozen split is not missing");
  eq(taxDiffersFromPools({ ...inv("0"), taxAmount: "17" }), true, "census differs");
  eq(taxDiffersFromPools(inv("0")), false, "census agrees");
  eq(toCsv([plain]).split("\n")[0], COLUMNS.join(","), "csv header");
  // the READ ONLY wrapper: settings first, ROLLBACK last, exit 2 when not read-only
  const seen = [];
  const client = {
    query: async (sql) => (
      seen.push(sql),
      sql === SHOW_READ_ONLY ? { rows: [{ transaction_read_only: "on" }] } : { rows: [] }
    ),
  };
  await withReadOnlyTx(client, async () => {});
  eq(
    [seen[0], seen.includes(BEGIN_READ_ONLY), seen.at(-1)],
    ["SET default_transaction_read_only = on", true, "ROLLBACK"],
    "tx",
  );
  const off = {
    query: async (sql) =>
      sql === SHOW_READ_ONLY ? { rows: [{ transaction_read_only: "off" }] } : { rows: [] },
  };
  const err = await withReadOnlyTx(off, async () => {}).catch((e) => e);
  eq(err.exitCode, 2, "not read-only exits 2");
  // guard + args
  const t = targetOf("postgresql://u:p%40ss@db.example.test:5432/railway");
  eq([t.host, t.database], ["db.example.test", "railway"], "targetOf");
  eq(
    [
      guardTarget(null, t).code,
      guardTarget("x.example.test", t).code,
      guardTarget("db.example.test", t).ok,
    ],
    [64, 65, true],
    "guard",
  );
  for (const bad of [["--apply"], ["--tenant", "acme"], ["--fix"]])
    if (checkArgs(bad).ok) throw new Error(`self-test: ${bad} accepted`);
  eq(
    checkArgs(["--tenant", "0b0e8a8e-1111-4222-8333-444455556666"]).ok,
    true,
    "tenant id accepted",
  );
  return "self-test ok";
}

async function main() {
  const args = checkArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`${NAME}: ${args.message}`);
    process.exit(2);
  }
  if (args.selfTest) {
    console.log(await selfTest());
    return;
  }
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);
  const target = targetOf(databaseUrl);
  console.error(`${NAME}: DB host ${target.host} · database ${target.database}`);
  const guard = guardTarget(args.targetHost, target);
  if (!guard.ok) {
    console.error(`${NAME}: ${guard.message}`);
    process.exit(guard.code);
  }
  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const rows = await withReadOnlyTx(client, () => buildReport(client, { tenant: args.tenant }));
    const csv = toCsv(rows);
    const dir = join(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
      "local-assets",
      "handoff",
    );
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${NAME}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
    writeFileSync(file, csv);
    console.error(`${NAME}: wrote ${rows.length} rows to local-assets/handoff/${basename(file)}`);
    process.stdout.write(csv);
  } finally {
    await client.end().catch(() => {});
  }
}

export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return norm(entry) === norm(self) || basename(entry) === basename(self);
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(e.exitCode ?? 1);
  });
}
