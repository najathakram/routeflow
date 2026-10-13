// T6 remediation — stamp `tenantId` on SPECIFIC, ID-PINNED rows that the T6 census found NULL.
// It is deliberately narrow: only StockLot and CreditNote (the two tables the prod census flagged),
// only rows you name by id, only rows that are STILL NULL, only when the tenant their foreign keys
// name is UNAMBIGUOUS. It never runs a table-wide UPDATE and never picks a tenant for you.
//
// DRY-RUN IS THE DEFAULT (and the only thing --ids-less runs do): it writes nothing, lists every NULL
// row of the table with its FK-derived tenant + slug, and prints the exact --apply command for the
// rows that are safe to stamp (ids filled in, absolute script path).
//
//   railway run --service postgres node <this script> --table StockLot
//   railway run --service postgres node <this script> --table StockLot --ids ID1,ID2 --apply
//   ... a row owned by a LIVE (non-test) tenant additionally needs
//       --live-tenant-override --confirm "STAMP <n> ROWS"
//   DATABASE_URL=postgresql://…@localhost:5432/<db> node <this script> --local --table StockLot …
//
// Apply is ONE transaction: every named id must be currently NULL and derive exactly one tenant, or
// nothing is written. Post-apply it prints the remaining NULL count for the table.
// Exit: 0 ok / dry-run printed · 1 refused (nothing written) · 2 env/connection error.
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";
import guard from "./lib/live-target-guard.cjs";
import protectedSlugsLib from "./lib/protected-slugs.cjs";

// Row 195: --apply never stamps a row into a PROTECTED tenant (paying | stripe-linked |
// PROTECTED_TENANT_SLUGS), with or without --live-tenant-override. The tenant is the one the row's
// FK parents derive, so it is excluded by that derived id. Ids and counts only.
const { protectedTenantIds } = guard;
const { loadProtectedSlugs } = protectedSlugsLib;

const SELF = resolve(dirname(fileURLToPath(import.meta.url)), "t6-stamp-null-rows.mjs");

/** Per table: the rows still NULL (optionally pinned to ids) + every tenant their FKs name. */
const TABLES = {
  StockLot: (ids) => ({
    text: `SELECT s.id, s."createdAt", ARRAY[p."tenantId"]::text[] AS tenants
             FROM "StockLot" s LEFT JOIN "Product" p ON p.id = s."productId"
            WHERE s."tenantId" IS NULL ${ids ? "AND s.id = ANY($1::text[])" : ""} ORDER BY s."createdAt"`,
    values: ids ? [ids] : [],
  }),
  CreditNote: (ids) => ({
    text: `SELECT c.id, c."createdAt",
                  ARRAY[cu."tenantId", i."tenantId"]::text[]
                    || COALESCE((SELECT array_agg(DISTINCT ci."tenantId") FROM "CreditNoteItem" ci
                                  WHERE ci."creditNoteId" = c.id), ARRAY[]::text[]) AS tenants
             FROM "CreditNote" c LEFT JOIN "Customer" cu ON cu.id = c."customerId"
             LEFT JOIN "Invoice" i ON i.id = c."invoiceId"
            WHERE c."tenantId" IS NULL ${ids ? "AND c.id = ANY($1::text[])" : ""} ORDER BY c."createdAt"`,
    values: ids ? [ids] : [],
  }),
};

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** The single tenant a row's FK parents agree on, or null (none / ambiguous). */
function derivedTenant(row) {
  const t = new Set((row.tenants ?? []).filter(Boolean));
  return t.size === 1 ? [...t][0] : null;
}

async function main() {
  const table = argOf("--table");
  const apply = process.argv.includes("--apply");
  const ids = argOf("--ids")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!table || !TABLES[table]) {
    console.error(`t6-stamp-null-rows: --table must be one of ${Object.keys(TABLES).join(", ")}`);
    return 1;
  }
  if (apply && !ids?.length) {
    console.error(
      "t6-stamp-null-rows: --apply needs --ids (id-pinned only; never a table-wide update)",
    );
    return 1;
  }
  const local = process.argv.includes("--local");
  let url;
  let localCfg = null; // --local: the vetted explicit fields are the ones dialled
  try {
    url = local ? process.env.DATABASE_URL : resolveDatabaseUrl(process.env);
    if (!url) throw new Error("--local requires DATABASE_URL");
    if (local) {
      localCfg = requireLocalPgConfig(url);
    }
  } catch (e) {
    console.error(`t6-stamp-null-rows: ${e.message}`);
    return 2;
  }
  console.log(
    `t6-stamp-null-rows: target ${redactUrl(url)} table ${table} ${apply ? "APPLY" : "DRY-RUN"}`,
  );
  // Loaded ONCE, against the URL dialled, before connecting (only the write path needs it).
  let protectedSlugs = null;
  if (apply) {
    try {
      protectedSlugs = loadProtectedSlugs(process.env, url);
    } catch (e) {
      console.error(`t6-stamp-null-rows: ${e.message}`);
      return 1;
    }
  }
  const client = new pg.Client(localCfg ?? { connectionString: url });
  try {
    await client.connect();
    await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
    const q = TABLES[table](apply ? ids : undefined);
    const { rows } = await client.query(q.text, q.values);
    const slugs = new Map();
    const slugOf = async (tenantId) => {
      if (!slugs.has(tenantId)) {
        const r = await client.query(`SELECT slug FROM "Tenant" WHERE id = $1`, [tenantId]);
        slugs.set(tenantId, r.rows[0]?.slug ?? null);
      }
      return slugs.get(tenantId);
    };
    const plan = [];
    for (const r of rows) {
      const tenant = derivedTenant(r);
      const slug = tenant ? await slugOf(tenant) : null;
      plan.push({
        id: r.id,
        createdAt: r.createdAt,
        tenant,
        slug,
        test: slug ? isTestTenant(slug) : false,
      });
      console.log(
        `  ${r.id}  ${new Date(r.createdAt).toISOString()}  ` +
          (tenant
            ? `-> ${tenant} (${slug ?? "no slug"}, ${isTestTenant(slug) ? "TEST" : "LIVE"})`
            : "NO UNAMBIGUOUS OWNER"),
      );
    }
    if (!apply) {
      await client.query("ROLLBACK");
      const safe = plan.filter((p) => p.tenant);
      const live = safe.filter((p) => !p.test);
      if (safe.length === 0) console.log("t6-stamp-null-rows: nothing safely stampable");
      else {
        const base = `railway run --service postgres node ${SELF.replace(/\\/g, "/")} --table ${table} --ids ${safe.map((p) => p.id).join(",")} --apply`;
        console.log(
          live.length
            ? `t6-stamp-null-rows: ${live.length} row(s) belong to a LIVE tenant. To stamp: ${base} --live-tenant-override --confirm "STAMP ${safe.length} ROWS"`
            : `t6-stamp-null-rows: all ${safe.length} row(s) belong to TEST tenants. To stamp: ${base}`,
        );
      }
      const stuck = plan.filter((p) => !p.tenant);
      if (stuck.length)
        console.log(
          `t6-stamp-null-rows: ${stuck.length} row(s) have NO unambiguous owner: they are NOT stampable (delete only with a written decision)`,
        );
      return 0;
    }
    // ── APPLY ───────────────────────────────────────────────────────────────────────────────
    const missing = ids.filter((id) => !plan.some((p) => p.id === id));
    if (missing.length)
      throw Object.assign(new Error(`id(s) not found or no longer NULL: ${missing.join(", ")}`), {
        refuse: true,
      });
    const ambiguous = plan.filter((p) => !p.tenant);
    if (ambiguous.length)
      throw Object.assign(
        new Error(`no unambiguous owner for: ${ambiguous.map((p) => p.id).join(", ")}`),
        { refuse: true },
      );
    const protectedIds = await protectedTenantIds(client, protectedSlugs);
    const protectedRows = plan.filter((p) => protectedIds.includes(p.tenant));
    if (protectedRows.length)
      throw Object.assign(
        new Error(`${protectedRows.length} row(s) derive a PROTECTED tenant: refused`),
        { refuse: true },
      );
    const live = plan.filter((p) => !p.test);
    if (live.length) {
      const phrase = `STAMP ${plan.length} ROWS`;
      if (!process.argv.includes("--live-tenant-override") || argOf("--confirm") !== phrase) {
        throw Object.assign(
          new Error(
            `${live.length} row(s) belong to a LIVE tenant: pass --live-tenant-override --confirm "${phrase}"`,
          ),
          { refuse: true },
        );
      }
    }
    for (const p of plan) {
      const r = await client.query(
        `UPDATE "${table}" SET "tenantId" = $1 WHERE id = $2 AND "tenantId" IS NULL
            AND $1::text <> ALL($3::text[])`,
        [p.tenant, p.id, protectedIds],
      );
      if (r.rowCount !== 1)
        throw Object.assign(new Error(`row ${p.id} was not updated exactly once`), {
          refuse: true,
        });
    }
    const left = await client.query(
      `SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" IS NULL`,
    );
    await client.query("COMMIT");
    console.log(
      `t6-stamp-null-rows: stamped ${plan.length} row(s); ${left.rows[0].n} NULL-tenant row(s) remain in ${table}`,
    );
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`t6-stamp-null-rows: ${e.message}${e.refuse ? " — nothing was written" : ""}`);
    return e.refuse ? 1 : 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
