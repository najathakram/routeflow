// SA-693 remediation — stamp `isComp = true` on SPECIFIC, ID-PINNED TenantAddon rows the owner decided
// are platform grants (see report-addon-comp-candidates.mjs for the candidate list). Deliberately
// narrow: only rows you name by id, only rows that are STILL active, item-less (stripeItemId NULL),
// $0 and not already comp. It never runs a table-wide UPDATE and never picks a row for you.
//
// DRY-RUN IS THE DEFAULT: it writes nothing, lists every named row with its verdict (stampable or the
// reason it is refused) and prints the exact --apply command.
//
//   railway run --service postgres node <this script> --ids ID1,ID2
//   railway run --service postgres node <this script> --ids ID1,ID2 --apply
//   ... a row owned by a LIVE (non-test) tenant additionally needs
//       --live-tenant-override --confirm "STAMP <n> ROWS"
//   DATABASE_URL=postgresql://…@localhost:5432/<db> node <this script> --local --ids ID1 [--apply]
//
// Apply is ONE transaction: every named id must pass every check or NOTHING is written. Each stamped
// row also gets an AuditLog row, action ADDON_COMPED, actor "owner-stamp" (meta.actor; userId is NULL
// because the owner runs this from a shell, not as a platform-admin user).
// Output is row ids and tenant UUIDs only: never a name or slug.
// Exit: 0 ok / dry-run printed · 1 refused (nothing written) · 2 env/connection error.
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const SELF = resolve(dirname(fileURLToPath(import.meta.url)), "stamp-addon-comp.mjs");
const ACTOR = "owner-stamp";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Why a row may NOT be stamped, or null when it may. Pure: pinned by addon-comp-scripts.sa693.spec.ts. */
export function refusalFor(row) {
  if (!row) return "not found";
  if (!row.active) return "inactive";
  if (row.stripeItemId) return "has a Stripe item (billed)";
  if (row.isComp) return "already a comp";
  if (Number(row.priceSnapshot ?? 0) !== 0) return "has a non-zero price (was booked as revenue)";
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const ids = [
    ...new Set(
      (argOf("--ids") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (!ids.length) {
    console.error(
      "stamp-addon-comp: --ids <uuid,...> is required (id-pinned only; never table-wide)",
    );
    return 1;
  }
  const bad = ids.filter((id) => !UUID_RE.test(id));
  if (bad.length) {
    console.error(`stamp-addon-comp: not a uuid: ${bad.join(", ")}`);
    return 1;
  }
  const local = process.argv.includes("--local");
  let url;
  let localCfg = null; // --local: the vetted explicit fields are the ones dialled
  try {
    url = local ? process.env.DATABASE_URL : resolveDatabaseUrl(process.env);
    if (!url) throw new Error("--local requires DATABASE_URL");
    if (local) localCfg = requireLocalPgConfig(url);
  } catch (e) {
    console.error(`stamp-addon-comp: ${e.message}`);
    return 2;
  }
  console.log(`stamp-addon-comp: target ${redactUrl(url)} ${apply ? "APPLY" : "DRY-RUN"}`);
  const client = new pg.Client(localCfg ?? { connectionString: url });
  try {
    await client.connect();
    await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
    const { rows } = await client.query(
      `SELECT a.id, a."tenantId", a."addonKey", a.sku, a.active, a."stripeItemId", a."isComp",
              a."priceSnapshot", t.slug
         FROM "TenantAddon" a JOIN "Tenant" t ON t.id = a."tenantId"
        WHERE a.id = ANY($1::text[]) ${apply ? "FOR UPDATE OF a" : ""}`,
      [ids],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const plan = ids.map((id) => {
      const row = byId.get(id);
      return { id, row, refusal: refusalFor(row), test: row ? isTestTenant(row.slug) : false };
    });
    for (const p of plan) {
      console.log(
        `  ${p.id}  ` +
          (p.row
            ? `tenant ${p.row.tenantId} ${p.row.sku ?? p.row.addonKey} ${p.test ? "TEST" : "LIVE"}  `
            : "") +
          (p.refusal ? `REFUSED: ${p.refusal}` : "stampable"),
      );
    }
    const refused = plan.filter((p) => p.refusal);
    const live = plan.filter((p) => !p.refusal && !p.test);
    const phrase = `STAMP ${plan.length} ROWS`;

    if (!apply) {
      await client.query("ROLLBACK");
      if (refused.length) {
        console.log(
          `stamp-addon-comp: ${refused.length} id(s) are NOT stampable; --apply would refuse the whole batch`,
        );
        return 0;
      }
      const base = `railway run --service postgres node ${SELF.replace(/\\/g, "/")} --ids ${ids.join(",")} --apply`;
      console.log(
        live.length
          ? `stamp-addon-comp: ${live.length} row(s) belong to a LIVE tenant. To stamp: ${base} --live-tenant-override --confirm "${phrase}"`
          : `stamp-addon-comp: all ${plan.length} row(s) belong to TEST tenants. To stamp: ${base}`,
      );
      return 0;
    }

    // ── APPLY ───────────────────────────────────────────────────────────────────────────────
    if (refused.length)
      throw Object.assign(
        new Error(`refused: ${refused.map((p) => `${p.id} (${p.refusal})`).join("; ")}`),
        { refuse: true },
      );
    if (
      live.length &&
      (!process.argv.includes("--live-tenant-override") || argOf("--confirm") !== phrase)
    ) {
      throw Object.assign(
        new Error(
          `${live.length} row(s) belong to a LIVE tenant: pass --live-tenant-override --confirm "${phrase}"`,
        ),
        { refuse: true },
      );
    }
    for (const p of plan) {
      const r = await client.query(
        `UPDATE "TenantAddon" SET "isComp" = true, "updatedAt" = now()
          WHERE id = $1 AND active = true AND "stripeItemId" IS NULL AND "isComp" = false
            AND COALESCE("priceSnapshot", 0) = 0`,
        [p.id],
      );
      if (r.rowCount !== 1)
        throw Object.assign(new Error(`row ${p.id} was not updated exactly once`), {
          refuse: true,
        });
      await client.query(
        `INSERT INTO "AuditLog" (id, "tenantId", "userId", action, "entityType", "entityId", meta)
         VALUES ($1, $2, NULL, 'ADDON_COMPED', 'tenant', $2, $3::jsonb)`,
        [
          randomUUID(),
          p.row.tenantId,
          JSON.stringify({
            platformAdmin: true,
            actor: ACTOR,
            addonKey: p.row.sku ?? p.row.addonKey,
            tenantAddonId: p.id,
            reason: "owner ruling 2026-10-05: grants are comps",
          }),
        ],
      );
    }
    await client.query("COMMIT");
    console.log(
      `stamp-addon-comp: stamped ${plan.length} row(s) as comp; ${plan.length} audit row(s) written`,
    );
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`stamp-addon-comp: ${e.message}${e.refuse ? " — nothing was written" : ""}`);
    return e.refuse ? 1 : 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
