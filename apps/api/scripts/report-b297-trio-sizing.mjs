/**
 * READ-ONLY sizing for B297 PR3 / SA-734r2 (R1, R2, R7): how many REGULATED lines still carry no (or a
 * partly missing) category-tax rate snapshot, and how many of those would be re-priced if recomputed at
 * today's category rate. Per line table (OrderItem, InvoiceItem), per tenant and category:
 *
 *   (a) nullTrio     a regulated line (`trackedCategoryId` set) whose `categoryTaxType`, `categoryTaxRate`
 *                    or `categoryPriceIncludesTax` is NULL. ANY one NULL counts as NULL (R4: a partly-NULL
 *                    trio is NULL).
 *   (b) mismatch     of (a), the stored `categoryTaxAmount` differs from the live recompute: the SAME
 *                    `computeCategoryTax` from `@routeflow/pricing`, the line's own piece basis
 *                    (`regulatedUnitBasis`, pack = the line's `unitsPerBox` else the product's) and the
 *                    category's CURRENT type / rate / priceIncludesTax. THIS MUST READ 0 AT THE PR3 MERGE
 *                    (R1), otherwise PR3 waits for PR6 or the owner's ruling on those lines.
 *   (c) noCategory   a line with `trackedCategoryId` NULL and `categoryTaxAmount` <> 0: the B767
 *                    population (also reached when a category is deleted: the FK is ON DELETE SET NULL).
 *                    Counted whatever it reads: PR3 KEEPS those amounts (L1) and PR6 repairs the provable
 *                    ones (L2).
 *
 * A NULL-trio InvoiceItem of a TAX-EXEMPT customer is counted in (a) but NOT in (b): both invoice paths
 * re-zero an exempt customer's levy (A4), so no live recompute would move it. It is reported in its own
 * `exempt` count (NULL-trio, exempt customer) so the number is visible and the (b) gate can read 0.
 *
 * `--since <ISO date>` additionally splits (a) by `createdAt >= since` (`nullTrioSince`): R2's gate on rows
 * created after PR-0 (B835) deploys. It counts every NULL-trio row since the cutoff, including any copied
 * from a NULL source, so it can only over-count (the safe side).
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The fleet lead / owner runs it under warn-then-approve
 * `railway run` authorization, from a checkout of the PR3 branch (the script needs the built
 * `@routeflow/pricing`):
 *
 *   railway run --service postgres node apps/api/scripts/report-b297-trio-sizing.mjs --json [--since 2026-10-11]
 *
 * Output is COUNTS ONLY plus anonymous labels ("tenant A", "category 1"): no tenant id, slug or name, no
 * category id or name, and no line, order or invoice id is printed. Test tenants (scripts/lib/test-tenants.cjs)
 * are counted in a separate `test` block; rows with no tenant are counted under "no tenant".
 *
 * `--self-test` runs the pure checks with no database and exits.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` and
 * `lock_timeout` cap every query; a keyset cursor by id reads 500 lines per page; the connection is closed
 * in `finally`; only SELECT appears below.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
const { computeCategoryTax, regulatedUnitBasis } = require("@routeflow/pricing");

const NAME = "report-b297-trio-sizing";
const PAGE = 500;

/** The two line tables that carry the trio. `table` reaches SQL only from this list, never from input. */
export const TABLES = ["OrderItem", "InvoiceItem"];

/** A regulated line with any of the trio NULL (R4: partly-NULL = NULL), or the B767 no-category shape. */
export const SCOPE_SQL = `((i."trackedCategoryId" IS NOT NULL
        AND (i."categoryTaxType" IS NULL OR i."categoryTaxRate" IS NULL OR i."categoryPriceIncludesTax" IS NULL))
    OR (i."trackedCategoryId" IS NULL AND i."categoryTaxAmount" <> 0))`;

/** One keyset page of in-scope lines, with what the live recompute needs. No input reaches the SQL. */
export function pageSql(table) {
  if (!TABLES.includes(table)) throw new Error(`unknown table ${table}`);
  // The order path ignores tax-exempt (A4); an invoice line of an exempt customer is re-zeroed by both invoice paths.
  const exempt =
    table === "InvoiceItem" ? `COALESCE(cu."isTaxExempt", false) AS "exempt"` : `false AS "exempt"`;
  const exemptJoin =
    table === "InvoiceItem"
      ? `LEFT JOIN "Invoice" iv ON iv.id = i."invoiceId"
  LEFT JOIN "Customer" cu ON cu.id = iv."customerId"`
      : ``;
  return `SELECT i.id, i."tenantId", i."trackedCategoryId", i."createdAt",
       i."categoryTaxType", i."categoryTaxRate"::text AS "categoryTaxRate", i."categoryPriceIncludesTax",
       i.qty::text AS qty, i.boxes, i.pieces, i."unitsPerBox", i."unitLabel",
       i.subtotal::text AS subtotal, i."categoryTaxAmount"::text AS "categoryTaxAmount",
       p."unitsPerBox" AS "productUnitsPerBox",
       c."taxType" AS "liveTaxType", c.rate::text AS "liveRate", c."priceIncludesTax" AS "livePriceIncludesTax",
       ${exempt},
       t.slug
  FROM "${table}" i
  LEFT JOIN "Product" p ON p.id = i."productId"
  LEFT JOIN "TrackedCategory" c ON c.id = i."trackedCategoryId"
  LEFT JOIN "Tenant" t ON t.id = i."tenantId"
  ${exemptJoin}
 WHERE ${SCOPE_SQL}
   AND i.id > $1::text
 ORDER BY i.id
 LIMIT ${PAGE}`;
}

const cents = (n) => Math.round((Number(n) || 0) * 100);

/**
 * Classify one in-scope line. `row`: the page columns above. Returns { nullTrio, mismatch, noCategory }.
 * The recompute is production's own arithmetic: same helper, same basis conversion.
 */
export function classifyLine(row) {
  if (row.trackedCategoryId == null) {
    return {
      nullTrio: false,
      mismatch: false,
      noCategory: cents(row.categoryTaxAmount) !== 0,
      exempt: false,
    };
  }
  const nullTrio =
    row.categoryTaxType == null ||
    row.categoryTaxRate == null ||
    row.categoryPriceIncludesTax == null;
  if (!nullTrio) return { nullTrio: false, mismatch: false, noCategory: false, exempt: false };
  // The page SQL only returns lines whose trio has a NULL, but a fixture may hand a full trio in.
  const pack =
    row.unitsPerBox != null ? Number(row.unitsPerBox) : Number(row.productUnitsPerBox ?? 0);
  const unitBasisQty = regulatedUnitBasis(
    {
      qty: Number(row.qty) || 0,
      boxes: row.boxes,
      pieces: row.pieces,
      unitLabel: row.unitLabel,
    },
    pack,
  ).unitBasisQty;
  const live =
    row.liveTaxType == null
      ? null
      : computeCategoryTax({
          taxType: row.liveTaxType,
          rate: Number(row.liveRate),
          unitBasisQty,
          lineSubtotal: Number(row.subtotal),
          priceIncludesTax: !!row.livePriceIncludesTax,
        });
  // A category that no longer resolves cannot be priced: count it as a mismatch (the PR3 helper keeps the stored amount).
  const differs = live == null ? true : cents(row.categoryTaxAmount) !== cents(live);
  // An exempt customer's invoice line is re-zeroed by both invoice paths, so it is never re-priced: not (b).
  if (row.exempt) return { nullTrio: true, mismatch: false, noCategory: false, exempt: true };
  return { nullTrio: true, mismatch: differs, noCategory: false, exempt: false };
}

const zeroBlock = () => ({ nullTrio: 0, nullTrioSince: 0, mismatch: 0, noCategory: 0, exempt: 0 });

/** Accumulator: { live|test: Map<table, Map<tenantId|null, { totals, cats: Map<categoryId, block> }>> }. */
export function newAccumulator() {
  return { live: new Map(), test: new Map() };
}

/** Fold one classified line into the accumulator. `since` is a Date or null. */
export function addLine(
  acc,
  table,
  { tenantId, isTest, categoryId, createdAt },
  result,
  since = null,
) {
  const side = acc[isTest ? "test" : "live"];
  if (!side.has(table)) side.set(table, new Map());
  const tenants = side.get(table);
  const key = tenantId ?? null;
  if (!tenants.has(key)) tenants.set(key, { totals: zeroBlock(), cats: new Map() });
  const t = tenants.get(key);
  const blocks = [t.totals];
  if (categoryId != null) {
    if (!t.cats.has(categoryId)) t.cats.set(categoryId, zeroBlock());
    blocks.push(t.cats.get(categoryId));
  }
  for (const b of blocks) {
    if (result.nullTrio) {
      b.nullTrio += 1;
      if (since && createdAt && new Date(createdAt) >= since) b.nullTrioSince += 1;
    }
    if (result.mismatch) b.mismatch += 1;
    if (result.noCategory) b.noCategory += 1;
    if (result.exempt) b.exempt += 1;
  }
}

/** Pure paging step shared by main() and the self-test: classify one page into the accumulator. */
export function foldPage(acc, table, rows, since = null) {
  for (const row of rows) {
    addLine(
      acc,
      table,
      {
        tenantId: row.tenantId ?? null,
        isTest: !!(row.slug && isTestTenant(row.slug)),
        categoryId: row.trackedCategoryId ?? null,
        createdAt: row.createdAt,
      },
      classifyLine(row),
      since,
    );
  }
}

const tenantLabel = (n) =>
  `tenant ${String.fromCharCode(65 + (n % 26))}${n >= 26 ? Math.floor(n / 26) : ""}`;

/**
 * Anonymous summary, one block at a time. Tenant labels (A, B, ...) are assigned in tenantId order ACROSS
 * tables within the block, so "tenant A" names the same tenant in both tables; category labels
 * ("category 1", ...) are assigned per tenant in categoryId order. Ids and slugs never leave this function.
 */
export function summarize(acc) {
  const out = {};
  for (const [blockName, side] of Object.entries(acc)) {
    const tenantIds = new Set();
    const catIdsByTenant = new Map();
    for (const tenants of side.values())
      for (const [tid, t] of tenants) {
        if (tid != null) tenantIds.add(tid);
        const set = catIdsByTenant.get(tid) ?? new Set();
        for (const cid of t.cats.keys()) set.add(cid);
        catIdsByTenant.set(tid, set);
      }
    const tlabel = new Map([...tenantIds].sort().map((id, n) => [id, tenantLabel(n)]));
    const clabel = (tid, cid) =>
      `category ${[...(catIdsByTenant.get(tid) ?? [])].sort().indexOf(cid) + 1}`;
    out[blockName] = {};
    for (const table of TABLES) {
      const tenants = side.get(table) ?? new Map();
      const total = zeroBlock();
      const detail = [...tenants.entries()]
        .sort(([a], [b]) => (a == null ? -1 : b == null ? 1 : a < b ? -1 : 1))
        .map(([tid, t]) => {
          for (const k of Object.keys(total)) total[k] += t.totals[k];
          return {
            tenant: tid == null ? "no tenant" : tlabel.get(tid),
            ...t.totals,
            categories: [...t.cats.entries()]
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([cid, b]) => ({ category: clabel(tid, cid), ...b })),
          };
        });
      out[blockName][table] = { ...total, tenants: detail.length, detail };
    }
  }
  return out;
}

/** No-DB checks of the pure parts (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const base = {
    tenantId: "t-b",
    slug: "acme-b",
    trackedCategoryId: "cat-2",
    createdAt: "2026-10-20T00:00:00Z",
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
  };
  // NULL trio, stored 0.60 = 12 x 0.05: consistent with today's rate.
  eq(
    classifyLine({ ...base }),
    { nullTrio: true, mismatch: false, noCategory: false, exempt: false },
    "consistent",
  );
  // Same line after the category rate moved: would be re-priced.
  eq(
    classifyLine({ ...base, liveRate: "0.0700" }),
    { nullTrio: true, mismatch: true, noCategory: false, exempt: false },
    "rate moved",
  );
  // A partly-NULL trio is NULL (R4).
  eq(
    classifyLine({
      ...base,
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryTaxRate: "0.05",
      categoryPriceIncludesTax: null,
    }),
    { nullTrio: true, mismatch: false, noCategory: false, exempt: false },
    "partly null is null",
  );
  // PERCENT_OF_SALE reads the subtotal, not the quantity.
  eq(
    classifyLine({
      ...base,
      liveTaxType: "PERCENT_OF_SALE",
      liveRate: "0.0600",
      categoryTaxAmount: "6.00",
    }),
    { nullTrio: true, mismatch: false, noCategory: false, exempt: false },
    "percent of sale",
  );
  // The B767 shape: no category and a non-zero amount; zero amount is not counted.
  eq(
    classifyLine({ ...base, trackedCategoryId: null, categoryTaxAmount: "4.20" }),
    { nullTrio: false, mismatch: false, noCategory: true, exempt: false },
    "no category",
  );
  eq(
    classifyLine({ ...base, trackedCategoryId: null, categoryTaxAmount: "0.00" }),
    { nullTrio: false, mismatch: false, noCategory: false, exempt: false },
    "no category, zero amount",
  );
  // A category that no longer resolves cannot be priced.
  eq(
    classifyLine({ ...base, liveTaxType: null, liveRate: null, livePriceIncludesTax: null })
      .mismatch,
    true,
    "unresolvable category",
  );

  // An exempt customer's NULL-trio invoice line: counted as NULL-trio and as exempt, never as a mismatch.
  eq(
    classifyLine({ ...base, liveRate: "0.0700", categoryTaxAmount: "0.00", exempt: true }),
    { nullTrio: true, mismatch: false, noCategory: false, exempt: true },
    "exempt customer",
  );
  const acc = newAccumulator();
  const since = new Date("2026-10-11T00:00:00Z");
  foldPage(
    acc,
    "OrderItem",
    [
      { ...base },
      { ...base, liveRate: "0.0700" },
      {
        ...base,
        tenantId: "t-a",
        slug: "acme-a",
        trackedCategoryId: "cat-1",
        createdAt: "2026-01-01T00:00:00Z",
      },
      { ...base, tenantId: null, slug: null, trackedCategoryId: null, categoryTaxAmount: "4.20" },
      { ...base, tenantId: "e2e-t", slug: "e2e-routeflow" },
    ],
    since,
  );
  foldPage(
    acc,
    "InvoiceItem",
    [{ ...base, tenantId: "t-a", slug: "acme-a", trackedCategoryId: "cat-9" }],
    since,
  );
  const s = summarize(acc);
  eq(
    [
      s.live.OrderItem.nullTrio,
      s.live.OrderItem.nullTrioSince,
      s.live.OrderItem.mismatch,
      s.live.OrderItem.noCategory,
    ],
    [3, 2, 1, 1],
    "order totals",
  );
  eq(s.test.OrderItem.nullTrio, 1, "test tenants are their own block");
  eq(
    s.live.OrderItem.detail.map((d) => d.tenant),
    ["no tenant", "tenant A", "tenant B"],
    "labels",
  );
  eq(
    s.live.InvoiceItem.detail.map((d) => [d.tenant, d.categories.map((c) => c.category)]),
    [["tenant A", ["category 2"]]],
    "category labels are per tenant, stable across tables",
  );
  const text = JSON.stringify(s);
  if (/acme|t-a|t-b|cat-|e2e/.test(text)) throw new Error("summary leaked an id or slug");
  if (!pageSql("OrderItem").includes(SCOPE_SQL)) throw new Error("page sql lost the scope");
  let threw = false;
  try {
    pageSql('OrderItem"; SELECT 1; --');
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("pageSql accepted a table outside TABLES");
  return "self-test ok";
}

function printBlock(name, byTable) {
  for (const [table, s] of Object.entries(byTable)) {
    console.log(
      `${name} ${table}: NULL-trio ${s.nullTrio} (since cutoff ${s.nullTrioSince}), would-reprice ${s.mismatch}, ` +
        `NULL-trio exempt (not re-priced) ${s.exempt}, no-category with amount ${s.noCategory} in ${s.tenants} tenant bucket(s)`,
    );
    for (const d of s.detail) {
      console.log(
        `  ${d.tenant}  NULL-trio ${d.nullTrio} (since ${d.nullTrioSince}), would-reprice ${d.mismatch}, no-category ${d.noCategory}`,
      );
      for (const c of d.categories)
        console.log(
          `    ${c.category}  NULL-trio ${c.nullTrio} (since ${c.nullTrioSince}), would-reprice ${c.mismatch}`,
        );
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const sinceArg = argv.indexOf("--since");
  let since = null;
  if (sinceArg >= 0) {
    since = new Date(argv[sinceArg + 1] ?? "");
    if (Number.isNaN(since.getTime())) {
      console.error(`${NAME}: --since needs an ISO date, e.g. 2026-10-11`);
      process.exit(2);
    }
  }
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);

  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    // A zero-result scan (the outcome the gate wants) walks the whole table once on the id index.
    await client.query("SET statement_timeout = '120s'");
    await client.query("SET lock_timeout = '5s'");

    const acc = newAccumulator();
    for (const table of TABLES) {
      let cursor = "";
      for (;;) {
        const { rows } = await client.query(pageSql(table), [cursor]);
        if (rows.length === 0) break;
        foldPage(acc, table, rows, since);
        cursor = rows[rows.length - 1].id;
        if (rows.length < PAGE) break;
      }
    }
    const report = { since: since ? since.toISOString() : null, ...summarize(acc) };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`since: ${report.since ?? "n/a"}`);
      console.log("gate R1: live would-reprice (b) must read 0 at the PR3 merge");
      printBlock("live", report.live);
      printBlock("test", report.test);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Run only when invoked directly: importing this module (for `classifyLine` / `selfTest`) must never
 * start a report. Paths are compared after realpath, case-insensitively on Windows; when only the
 * file NAMES match it warns and runs anyway, because a silent exit 0 reads as "nothing found"
 * (the report-b673 pattern).
 */
export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    let r = p;
    try {
      r = realpathSync(p);
    } catch {
      // keep the path as given
    }
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  if (norm(entry) === norm(self)) return true;
  if (basename(entry).toLowerCase() === basename(self).toLowerCase()) {
    console.error(
      `${NAME}: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(1);
  });
}
