// T6 — READ-ONLY forensics for the NULL-tenant CreditNote the stamp tool refused to stamp because its
// tenant already holds a credit note with the same number (unique key tenantId + creditNoteNumber).
// For every CreditNote with a NULL tenantId it prints, side by side with its same-numbered twin on
// the tenant its FKs name: every column, the invoice(s) it points at, and EVERY child/reference row
// (items, payments/allocations, order links, regulated-ledger rows, returns), plus the tenant's
// other credit-note numbers (to pick the next free one). It ends with a per-pair VERDICT line.
// One READ ONLY transaction, SELECTs only. Output contains tenant ids and document numbers: keep it
// off public issues.
//
//   railway run --service postgres node C:/ClaudeCode/routeflow/apps/api/scripts/t6-creditnote-compare.mjs
//   DATABASE_URL=postgresql://…@localhost:5432/<db> node apps/api/scripts/t6-creditnote-compare.mjs --local
//
// Exit: 0 printed · 2 env/connection error.
import { pathToFileURL } from "node:url";
import pg from "pg";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);
const j = (o) => JSON.stringify(o);

/** Everything that points at one credit note id. */
async function references(client, id) {
  const q = async (text) => (await client.query(text, [id])).rows;
  return {
    items: await q(
      `SELECT id, "tenantId", "invoiceItemId", amount, qty, "categoryTax", "createdAt" FROM "CreditNoteItem" WHERE "creditNoteId" = $1`,
    ),
    payments: await q(
      `SELECT id, "tenantId", "invoiceId", amount, method::text AS method, status::text AS status, "createdAt" FROM "InvoicePayment" WHERE "creditNoteId" = $1`,
    ),
    orderLinks: await q(
      `SELECT id, "tenantId", "orderId", amount, "createdAt" FROM "OrderCreditNote" WHERE "creditNoteId" = $1`,
    ),
    regulatedLedger: await q(
      `SELECT id, "tenantId" FROM "RegulatedSalesLedger" WHERE "creditNoteId" = $1`,
    ),
    returns: await q(`SELECT id, "tenantId" FROM "Return" WHERE "creditNoteId" = $1`),
  };
}

async function invoiceOf(client, invoiceId) {
  if (!invoiceId) return null;
  const { rows } = await client.query(
    `SELECT id, "invoiceNumber", status::text AS status, total, "tenantId", "customerId" FROM "Invoice" WHERE id = $1`,
    [invoiceId],
  );
  return rows[0] ?? null;
}

async function main() {
  const local = process.argv.includes("--local");
  let url;
  try {
    url = local ? process.env.DATABASE_URL : resolveDatabaseUrl(process.env);
    if (!url) throw new Error("--local requires DATABASE_URL");
    if (local) {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
      if (!LOCAL_HOSTS.has(host)) throw new Error(`--local refuses non-local host ${host}`);
    }
  } catch (e) {
    console.error(`t6-creditnote-compare: ${e.message}`);
    return 2;
  }
  console.log(
    `t6-creditnote-compare: target ${redactUrl(url)} (READ ONLY; contains tenant ids and numbers: keep private)`,
  );
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const { rows: nulls } = await client.query(
      `SELECT c.*, cu."tenantId" AS customer_tenant FROM "CreditNote" c
         LEFT JOIN "Customer" cu ON cu.id = c."customerId" WHERE c."tenantId" IS NULL ORDER BY c."createdAt"`,
    );
    if (nulls.length === 0) console.log("no NULL-tenant credit notes");
    for (const n of nulls) {
      const tenant = n.customer_tenant;
      console.log(
        `\n================ NULL-tenant credit note ${n.id} (number ${n.creditNoteNumber}, customer tenant ${tenant ?? "NONE"})`,
      );
      const { customer_tenant: _ct, ...nullRow } = n;
      console.log("NULL ROW :", j(nullRow));
      console.log("  invoice:", j(await invoiceOf(client, n.invoiceId)));
      console.log("  appliedToInvoice:", j(await invoiceOf(client, n.appliedToInvoiceId)));
      console.log("  references:", j(await references(client, n.id)));
      if (!tenant) {
        console.log("VERDICT: no tenant derivable from the customer — cannot look for a twin");
        continue;
      }
      const { rows: twins } = await client.query(
        `SELECT * FROM "CreditNote" WHERE "tenantId" = $1 AND "creditNoteNumber" = $2`,
        [tenant, n.creditNoteNumber],
      );
      for (const t of twins) {
        console.log(`STAMPED TWIN ${t.id}:`, j(t));
        console.log("  invoice:", j(await invoiceOf(client, t.invoiceId)));
        console.log("  appliedToInvoice:", j(await invoiceOf(client, t.appliedToInvoiceId)));
        console.log("  references:", j(await references(client, t.id)));
        const secs = Math.round((new Date(n.createdAt) - new Date(t.createdAt)) / 1000);
        const sameAmount = String(n.amount) === String(t.amount);
        const sameInvoice = n.invoiceId === t.invoiceId;
        const sameCustomer = n.customerId === t.customerId;
        console.log(
          `VERDICT ${n.id} vs ${t.id}: sameCustomer=${sameCustomer} sameInvoice=${sameInvoice} sameAmount=${sameAmount} createdAtDeltaSeconds=${secs} status(null/twin)=${n.status}/${t.status}`,
        );
      }
      if (twins.length === 0)
        console.log(
          "VERDICT: no same-numbered twin on that tenant (the stamp should not have collided)",
        );
      const { rows: nums } = await client.query(
        `SELECT "creditNoteNumber", id, status::text AS status, "createdAt" FROM "CreditNote" WHERE "tenantId" = $1 ORDER BY "creditNoteNumber"`,
        [tenant],
      );
      console.log(`  all credit notes on that tenant (${nums.length}):`, j(nums));
    }
    await client.query("ROLLBACK");
    return 0;
  } catch (e) {
    console.error(`t6-creditnote-compare: ${e.message}`);
    return 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
