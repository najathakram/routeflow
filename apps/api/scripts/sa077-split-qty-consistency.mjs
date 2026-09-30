// SA-077(2) — READ-ONLY report: InvoiceItems whose stored split disagrees with their own qty.
//
// WHAT IT LOOKS FOR: a line carrying a box/piece split where `qty != boxes * unitsPerBox + pieces`.
// Such a row cannot have been priced from a coherent split, and on the ledger's piece axis it
// files the wrong quantity. Rows are LISTED, never touched — this script issues one SELECT inside
// a READ ONLY transaction and has no write path at all.
//
// THE CODE IS THE TRUTH; THIS SQL IS A STATED MIRROR OF IT. The rule lives in
// `lineAmbiguity` (packages/pricing/src/pricing.ts), which returns
// "qty (…) disagrees with boxes*unitsPerBox+pieces (…)" for exactly this shape. SQL cannot import
// that function, so this file restates the predicate rather than sharing it, and the restatement
// is the thing to re-check if the code ever changes. It is NOT a second definition to reason
// from: if the two ever disagree, `lineAmbiguity` is right and this query is stale.
//
// Deliberately NOT in scope: a split on a line with no pack at all. That shape is refused at the
// API from SA-077(2) onward, and rows predating the refusal carry `unitsPerBox` null, where
// `boxes * unitsPerBox + pieces` is not computable — they are reported separately below as
// "no pack" rather than folded into the disagreement count, because the two need different reads.
//
//   railway run --service postgres node apps/api/scripts/sa077-split-qty-consistency.mjs
//   DATABASE_URL=… node apps/api/scripts/sa077-split-qty-consistency.mjs --local
//
// Exit: 0 always when the query ran (a report, never a gate) · 2 env/connection error.
import pg from "pg";
import { isLocalDbTarget } from "./lib/local-db-target.cjs";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const SPLIT_DISAGREES_SQL = `
  SELECT ii.id, ii."invoiceId", i."invoiceNumber", ii."productId",
         ii.qty, ii.boxes, ii.pieces, ii."unitsPerBox",
         (ii.boxes * ii."unitsPerBox" + ii.pieces) AS implied_qty
  FROM "InvoiceItem" ii
  JOIN "Invoice" i ON i.id = ii."invoiceId"
  WHERE (ii.boxes IS NOT NULL OR ii.pieces IS NOT NULL)
    AND ii."unitsPerBox" IS NOT NULL AND ii."unitsPerBox" > 1
    AND ii.qty <> (COALESCE(ii.boxes, 0) * ii."unitsPerBox" + COALESCE(ii.pieces, 0))
  ORDER BY i."invoiceNumber", ii.id
`;

const SPLIT_WITHOUT_PACK_SQL = `
  SELECT ii.id, ii."invoiceId", i."invoiceNumber", ii."productId", ii.qty, ii.boxes, ii.pieces
  FROM "InvoiceItem" ii
  JOIN "Invoice" i ON i.id = ii."invoiceId"
  WHERE (ii.boxes IS NOT NULL OR ii.pieces IS NOT NULL)
    AND (ii."unitsPerBox" IS NULL OR ii."unitsPerBox" <= 1)
  ORDER BY i."invoiceNumber", ii.id
`;

async function main() {
  const local = process.argv.includes("--local");
  const url = local ? process.env.DATABASE_URL : resolveDatabaseUrl(process.env);
  if (!url) throw new Error("--local requires DATABASE_URL");
  if (local && !isLocalDbTarget(url)) {
    throw new Error(`--local refuses a non-local host (${redactUrl(url)})`);
  }
  console.log(`sa077-split-qty-consistency: target ${redactUrl(url)} READ ONLY`);
  const client = new pg.Client(local ? requireLocalPgConfig(url) : { connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const disagree = (await client.query(SPLIT_DISAGREES_SQL)).rows;
    const noPack = (await client.query(SPLIT_WITHOUT_PACK_SQL)).rows;
    await client.query("ROLLBACK");

    console.log(`\nsplit disagrees with qty: ${disagree.length} row(s)`);
    for (const r of disagree) {
      console.log(
        `  ${r.invoiceNumber} item ${r.id}: qty ${r.qty} vs boxes ${r.boxes} x ${r.unitsPerBox} + pieces ${r.pieces} = ${r.implied_qty}`,
      );
    }
    console.log(
      `\nsplit with no pack (refused at the API since SA-077(2)): ${noPack.length} row(s)`,
    );
    for (const r of noPack) {
      console.log(
        `  ${r.invoiceNumber} item ${r.id}: qty ${r.qty}, boxes ${r.boxes}, pieces ${r.pieces}`,
      );
    }
    console.log("\nReport only — no row was modified.");
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`sa077-split-qty-consistency: ${e.message}`);
    return 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

process.exitCode = await main();
