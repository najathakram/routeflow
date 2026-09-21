// T6 — renumber-then-stamp ONE NULL-tenant CreditNote that collides on number with a DIFFERENT credit
// note already on its tenant (unique key tenantId + creditNoteNumber). It never deletes anything.
// Test tenants only (scripts/lib/test-tenants.cjs): a live tenant is refused outright.
//
// Everything that identifies the row arrives as a CLI argument, and the script checks each against
// the database before it will write:
//   --id            the NULL row's id, or a unique prefix of at least 8 characters
//   --tenant        the tenant id you EXPECT the row's customer to belong to (must match)
//   --expect-number the number you EXPECT it to be renumbered to (must match the computed next free)
//   --apply         write (default is a read-only dry-run that prints before/after)
//   --confirm       must be exactly "RESOLVE 1 CREDIT NOTE" with --apply
//   --local         DATABASE_URL on localhost instead of the Railway proxy
//
// The new number is the tenant's highest number in the same "PREFIX-NNNN" series + 1 (same width).
// One UPDATE sets number and tenant together (so the T6 CHECK is satisfied) and must change exactly
// one row that is STILL NULL. Exit: 0 ok / dry-run · 1 refused (nothing written) · 2 env error.
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const SELF = resolve(dirname(fileURLToPath(import.meta.url)), "t6-creditnote-resolve.mjs");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);
const PHRASE = "RESOLVE 1 CREDIT NOTE";
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const refuse = (msg) => Object.assign(new Error(msg), { refuse: true });

async function main() {
  const idArg = argOf("--id");
  const tenantArg = argOf("--tenant");
  const expectNumber = argOf("--expect-number");
  const apply = process.argv.includes("--apply");
  if (!idArg || idArg.length < 8 || !tenantArg || !expectNumber) {
    console.error("t6-creditnote-resolve: needs --id (>= 8 chars), --tenant and --expect-number");
    return 1;
  }
  if (apply && argOf("--confirm") !== PHRASE) {
    console.error(`t6-creditnote-resolve: --apply needs --confirm "${PHRASE}"`);
    return 1;
  }
  const local = process.argv.includes("--local");
  let url;
  try {
    url = local ? process.env.DATABASE_URL : resolveDatabaseUrl(process.env);
    if (!url) throw new Error("--local requires DATABASE_URL");
    if (local && !LOCAL_HOSTS.has(new URL(url).hostname.replace(/^\[|\]$/g, ""))) {
      throw new Error("--local refuses a non-local host");
    }
  } catch (e) {
    console.error(`t6-creditnote-resolve: ${e.message}`);
    return 2;
  }
  console.log(`t6-creditnote-resolve: target ${redactUrl(url)} ${apply ? "APPLY" : "DRY-RUN"}`);
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
    const { rows } = await client.query(
      `SELECT c.*, cu."tenantId" AS customer_tenant FROM "CreditNote" c
         LEFT JOIN "Customer" cu ON cu.id = c."customerId"
        WHERE c."tenantId" IS NULL AND c.id LIKE $1 ${apply ? "FOR UPDATE OF c" : ""}`,
      [`${idArg.replace(/[\\%_]/g, "\\$&")}%`],
    );
    if (rows.length !== 1)
      throw refuse(`--id matches ${rows.length} NULL-tenant credit notes (need exactly 1)`);
    const row = rows[0];
    if (row.customer_tenant !== tenantArg) {
      throw refuse(
        `the row's customer belongs to a different tenant than --tenant (${row.customer_tenant ?? "none"})`,
      );
    }
    const slug = (await client.query(`SELECT slug FROM "Tenant" WHERE id = $1`, [tenantArg]))
      .rows[0]?.slug;
    if (!isTestTenant(slug))
      throw refuse("that tenant is not an approved test tenant: refused, no override exists");
    const m = /^(.*?)(\d+)$/.exec(row.creditNoteNumber);
    if (!m) throw refuse(`cannot read a numeric series from ${row.creditNoteNumber}`);
    const [, prefix, digits] = m;
    const { rows: existing } = await client.query(
      `SELECT "creditNoteNumber" FROM "CreditNote" WHERE "tenantId" = $1`,
      [tenantArg],
    );
    const nums = existing
      .map((r) => /^(.*?)(\d+)$/.exec(r.creditNoteNumber))
      .filter((x) => x && x[1] === prefix)
      .map((x) => Number(x[2]));
    if (nums.length === 0)
      throw refuse(`the tenant has no number in the ${prefix}NNNN series to continue`);
    const next = `${prefix}${String(Math.max(...nums) + 1).padStart(digits.length, "0")}`;
    if (next !== expectNumber)
      throw refuse(`the next free number is ${next}, not --expect-number ${expectNumber}`);
    if (existing.some((r) => r.creditNoteNumber === next))
      throw refuse(`${next} is already taken on that tenant`);
    console.log(
      `  BEFORE: id ${row.id}  number ${row.creditNoteNumber}  tenant NULL  status ${row.status}  amount ${row.amount}`,
    );
    console.log(`  AFTER : id ${row.id}  number ${next}  tenant ${tenantArg} (${slug})`);
    const seq = (
      await client.query(`SELECT * FROM "NumberingSequence" WHERE "tenantId" = $1`, [tenantArg])
    ).rows;
    console.log(`  numbering sequences on this tenant: ${JSON.stringify(seq)}`);
    if (!apply) {
      await client.query("ROLLBACK");
      console.log(
        `t6-creditnote-resolve: OK. To write: railway run --service postgres node ${SELF.replace(/\\/g, "/")} --id ${row.id} --tenant ${tenantArg} --expect-number ${next} --apply --confirm "${PHRASE}"`,
      );
      return 0;
    }
    const r = await client.query(
      `UPDATE "CreditNote" SET "tenantId" = $2, "creditNoteNumber" = $3 WHERE id = $1 AND "tenantId" IS NULL`,
      [row.id, tenantArg, next],
    );
    if (r.rowCount !== 1) throw refuse(`expected exactly one row changed, got ${r.rowCount}`);
    const left = (
      await client.query(`SELECT count(*)::int AS n FROM "CreditNote" WHERE "tenantId" IS NULL`)
    ).rows[0].n;
    await client.query("COMMIT");
    console.log(`t6-creditnote-resolve: done; ${left} NULL-tenant credit note(s) remain`);
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`t6-creditnote-resolve: ${e.message}${e.refuse ? " — nothing was written" : ""}`);
    return e.refuse ? 1 : 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
