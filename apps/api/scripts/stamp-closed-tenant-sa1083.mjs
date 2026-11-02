/**
 * SA-1083 G5: gives one tenant that was already closed when the clock arrived its closing date, now, so it gets the full
 * 30 days from this run. Only for a tenant on the owner-approved list from the census. A dry run unless `--apply`.
 * It refuses a tenant that isn't closed or already has a date. It changes nothing else, and deletes nothing.
 *
 *   node apps/api/scripts/stamp-closed-tenant-sa1083.mjs --tenant <tenantId>            (dry run)
 *   railway run --service postgres node apps/api/scripts/stamp-closed-tenant-sa1083.mjs --tenant <tenantId> --apply
 *
 * SAFETY: one tenant per run. A protected tenant needs the operator override from live-target-guard.cjs
 * (--allow-protected <tenantId> --backup-taken, typed at a real terminal). Ids only in the output, no slug.
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveDatabaseUrl, redactUrl } from "./lib/railway-db-url.mjs";

const require = createRequire(import.meta.url);
const guard = require("./lib/live-target-guard.cjs");
const { loadProtectedSlugs } = require("./lib/protected-slugs.cjs");

const AUDIT_ACTION = "tenant.closed-date-stamped";

const isClosed = (t) =>
  t.status === "CANCELLED" ||
  (t.status === "READ_ONLY" && t.readOnlyReason === "subscription_cancelled");

async function main(argv) {
  guard.refuseRetiredFlags(argv);
  const i = argv.indexOf("--tenant");
  const tenantId = i >= 0 ? argv[i + 1] : null;
  if (!tenantId) {
    console.error(
      "usage: --tenant <tenantId> [--apply] [--allow-protected <tenantId> --backup-taken]",
    );
    return 2;
  }
  const apply = argv.includes("--apply");
  const url = resolveDatabaseUrl(process.env);
  console.log(`Resolved database host: ${redactUrl(url)}`);
  const { Client } = require("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT t.id, t.slug, t.status, t."readOnlyReason", t.class, t."deletedAt", t."closedAt",
              s."planKey", s."stripeSubId", coalesce(s."couponFull", false) AS "couponFull", s.id AS "subId"
       FROM "Tenant" t LEFT JOIN "TenantSubscription" s ON s."tenantId" = t.id WHERE t.id = $1`,
      [tenantId],
    );
    const tenant = rows[0];
    if (!tenant) return refuse(`tenant ${tenantId} not found`);
    if (!isClosed(tenant)) return refuse(`tenant ${tenantId} is not closed (${tenant.status})`);
    if (tenant.closedAt) return refuse(`tenant ${tenantId} already has a closing date`);

    const sub = tenant.subId
      ? { planKey: tenant.planKey, stripeSubId: tenant.stripeSubId, couponFull: tenant.couponFull }
      : undefined;
    const slugs = loadProtectedSlugs(process.env, url);
    const allowProtected = argv.includes("--allow-protected")
      ? await guard.confirmProtectedOverride({ tenantId, argv })
      : undefined;
    guard.assertWritableTenant(tenant, sub, slugs, { allowProtected });

    if (!apply) {
      console.log(JSON.stringify({ tenantId, wouldStamp: true }));
      return 0;
    }
    await client.query("BEGIN");
    try {
      await client.query(`SELECT id FROM "Tenant" WHERE id = $1 FOR UPDATE`, [tenantId]);
      const { rows: stamped } = await client.query(
        `UPDATE "Tenant" SET "closedAt" = timezone('UTC', clock_timestamp())
         WHERE id = $1 AND "closedAt" IS NULL RETURNING "closedAt"`,
        [tenantId],
      );
      if (stamped.length !== 1) throw new Error(`tenant ${tenantId} changed; nothing stamped`);
      await client.query(
        `INSERT INTO "AuditLog" (id, "tenantId", action, "entityType", "entityId", meta)
         VALUES ($1, $2, $3, 'Tenant', $2, $4)`,
        [
          randomUUID(),
          tenantId,
          AUDIT_ACTION,
          JSON.stringify({ source: "owner-approved list, SA-1083" }),
        ],
      );
      await client.query("COMMIT");
      console.log(JSON.stringify({ tenantId, stamped: true, closedAt: stamped[0].closedAt }));
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  } finally {
    await client.end();
  }
  return 0;
}

function refuse(why) {
  console.error(`refused: ${why}; nothing written`);
  return 3;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
