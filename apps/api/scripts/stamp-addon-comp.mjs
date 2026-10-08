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
//   ... a row owned by a PROTECTED tenant (paying, Stripe-linked or listed in PROTECTED_TENANT_SLUGS)
//       is refused unless that ONE tenant's id is named: --allow-protected <tenantId> --backup-taken,
//       at a real terminal, then the typed phrase "ALLOW PROTECTED <tenantId>".
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
import guardLib from "./lib/live-target-guard.cjs";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import protectedSlugsLib from "./lib/protected-slugs.cjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const { assertWritableTenant, confirmProtectedOverride, ProtectedTenantError } = guardLib;
const { loadProtectedSlugs } = protectedSlugsLib;

const SELF = resolve(dirname(fileURLToPath(import.meta.url)), "stamp-addon-comp.mjs");
const ACTOR = "owner-stamp";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** The tenant + subscription shape the protected-tenant guard reads off a joined plan row. */
const tenantOf = (row) => ({
  id: row.tenantId,
  slug: row.slug,
  status: row.tenantStatus,
  class: row.tenantClass,
  deletedAt: row.tenantDeletedAt,
});
const subOf = (row) => ({ planKey: row.subPlanKey, stripeSubId: row.subStripeSubId });

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
  let protectedSlugs;
  try {
    url = local ? process.env.DATABASE_URL : resolveDatabaseUrl(process.env);
    if (!url) throw new Error("--local requires DATABASE_URL");
    if (local) localCfg = requireLocalPgConfig(url);
    // Row 195: the protected list is loaded ONCE, before connecting, from the URL dialled below.
    protectedSlugs = loadProtectedSlugs(process.env, url);
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
              a."priceSnapshot", t.slug, t.status AS "tenantStatus", t.class AS "tenantClass",
              t."deletedAt" AS "tenantDeletedAt", s."planKey" AS "subPlanKey",
              s."stripeSubId" AS "subStripeSubId"
         FROM "TenantAddon" a JOIN "Tenant" t ON t.id = a."tenantId"
         LEFT JOIN "TenantSubscription" s ON s."tenantId" = a."tenantId"
        WHERE a.id = ANY($1::text[]) ${apply ? "FOR UPDATE OF a" : ""}`,
      [ids],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const plan = ids.map((id) => {
      const row = byId.get(id);
      const test = row ? isTestTenant(row.slug) : false;
      // Row 195: an approved test tenant keeps its behaviour; any other row is checked.
      let guarded = false;
      if (row && !test) {
        try {
          assertWritableTenant(tenantOf(row), subOf(row), protectedSlugs);
        } catch (e) {
          if (!(e instanceof ProtectedTenantError)) throw e;
          guarded = true;
        }
      }
      return { id, row, refusal: refusalFor(row), test, guarded };
    });
    for (const p of plan) {
      console.log(
        `  ${p.id}  ` +
          (p.row
            ? `tenant ${p.row.tenantId} ${p.row.sku ?? p.row.addonKey} ${p.test ? "TEST" : "LIVE"}` +
              `${p.guarded ? " PROTECTED" : ""}  `
            : "") +
          (p.refusal ? `REFUSED: ${p.refusal}` : "stampable"),
      );
    }
    const refused = plan.filter((p) => p.refusal);
    const live = plan.filter((p) => !p.refusal && !p.test);
    const guardedTenants = [...new Set(plan.filter((p) => p.guarded).map((p) => p.row.tenantId))];
    const phrase = `STAMP ${plan.length} ROWS`;

    if (!apply) {
      await client.query("ROLLBACK");
      if (refused.length) {
        console.log(
          `stamp-addon-comp: ${refused.length} id(s) are NOT stampable; --apply would refuse the whole batch`,
        );
        return 0;
      }
      if (guardedTenants.length)
        console.log(
          `stamp-addon-comp: PROTECTED tenant(s) ${guardedTenants.join(", ")}: --apply needs ` +
            "--allow-protected <tenantId> --backup-taken at a real terminal (one protected tenant per run)",
        );
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
    // Row 195: a protected tenant is stamped only after its id is named AND the phrase is typed.
    // Checked before the first UPDATE; a refusal rolls everything back (exit 1, nothing written).
    for (const tenantId of guardedTenants) {
      const p = plan.find((x) => x.guarded && x.row.tenantId === tenantId);
      try {
        const token = await confirmProtectedOverride({ tenantId, argv: process.argv });
        assertWritableTenant(tenantOf(p.row), subOf(p.row), protectedSlugs, {
          allowProtected: token,
        });
      } catch (e) {
        if (e instanceof ProtectedTenantError) e.refuse = true;
        throw e;
      }
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
