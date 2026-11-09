// AI limits PR-2: the core of `delete-tenant-anthropic-keys.mjs`. From PR-3 nothing reads a business's own Claude key
// (`SystemConfig` `anthropic.apiKey`); this removes the stored rows. keyRefs finds them BY REFERENCE (no value read; the
// tenant slug is used only to classify test tenants and is never returned); planDeletes applies the guards; deleteAll is
// the ONE writer: every delete and its AuditLog row in ONE transaction, all or nothing. The platform key
// (`PlatformConfig` `claude.apiKey`) is never touched. Idempotent: a second run finds nothing.

"use strict";

const { isTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const KEY = "anthropic.apiKey";
const AUDIT_ACTION = "ai.tenant_anthropic_key_deleted";

/** The business key rows still stored: non-empty (a cleared key is "" and has nothing to delete). */
async function keyRefs(client) {
  const r = await client.query(
    `SELECT sc.id, sc."tenantId", t.slug FROM "SystemConfig" sc
     JOIN "Tenant" t ON t.id = sc."tenantId"
     WHERE sc.key = $1 AND sc.value <> '' ORDER BY sc.id`,
    [KEY],
  );
  return r.rows.map((x) => ({ id: x.id, tenantId: x.tenantId, isTest: isTestTenant(x.slug) }));
}

/** How many tenants are not approved test tenants. A host that LOOKS local (a tunnel) holding any is not local. */
async function liveTenantCount(client) {
  const { rows } = await client.query(`SELECT slug FROM "Tenant"`);
  return rows.filter((t) => !isTestTenant(t.slug)).length;
}

/** A dry run is a read-only database session (the server refuses any write); only `--apply` may write. */
function poolConfig(url, apply) {
  return apply
    ? { connectionString: url }
    : { connectionString: url, options: "-c default_transaction_read_only=on" };
}

// Pure: the API still reads and writes the business key until PR-3 is deployed, so `--apply` needs the operator's
// `--after-pr3` attestation (no database fact marks PR-3, so the flag is the check). A dry run always passes.
function runOrderGate({ apply, afterPr3 }) {
  if (!apply || afterPr3) return { ok: true };
  return {
    ok: false,
    reason:
      "the API reads the business key until PR-3 is deployed: --apply needs --after-pr3 (run it only after that deploy)",
  };
}

/** Which rows may be deleted: a protected tenant's only if named; a non-test tenant's only with `liveOverride`. */
function planDeletes({ refs, protectedIds = new Set(), allowProtected = new Set(), liveOverride }) {
  const write = [];
  const skipped = { protected: 0, nonTest: 0 };
  for (const ref of refs) {
    if (protectedIds.has(ref.tenantId) && !allowProtected.has(ref.tenantId)) skipped.protected += 1;
    else if (!ref.isTest && !liveOverride) skipped.nonTest += 1;
    else write.push(ref);
  }
  return { write, skipped };
}

// Pure: dry run or nothing to delete passes; a local database with only test tenants passes; anything else needs
// --live-tenant-override, --backup-taken, a real terminal and the typed phrase `DELETE <rows> LIVE`.
function applyGate({ apply, local, liveOverride, backupTaken, isTTY, rows, nonTestRows }) {
  if (!apply || rows === 0 || (local && nonTestRows === 0)) return { ok: true, phrase: null };
  if (!liveOverride)
    return {
      ok: false,
      reason: "this target or tenant is not test-only: --apply needs --live-tenant-override",
    };
  if (!backupTaken) return { ok: false, reason: "--backup-taken is required for a live run" };
  if (!isTTY)
    return { ok: false, reason: "a live run needs a real terminal for the typed confirmation" };
  return { ok: true, phrase: `DELETE ${rows} LIVE` };
}

/** Every `--allow-protected <tenantId>`; a flag with no id is an error. */
function parseAllowProtected(argv) {
  const ids = [];
  argv.forEach((a, i) => {
    if (a !== "--allow-protected") return;
    const id = argv[i + 1];
    if (!id || id.startsWith("--")) throw new Error("--allow-protected needs a tenant id");
    ids.push(id);
  });
  return ids;
}

/** Delete the rows and write one AuditLog row each, in ONE transaction; a row changed since the plan rolls all back. */
async function deleteAll({ client, write }) {
  if (write.length === 0) return 0;
  const tx = await client.connect();
  try {
    await tx.query("BEGIN");
    for (const ref of write) {
      const del = await tx.query(
        `DELETE FROM "SystemConfig" WHERE id = $1 AND "tenantId" = $2 AND key = $3 AND value <> ''`,
        [ref.id, ref.tenantId, KEY],
      );
      if (del.rowCount !== 1)
        throw new Error("a key row changed since the plan: rolled back, nothing deleted");
      await tx.query(
        `INSERT INTO "AuditLog" (id, "tenantId", action, "entityType", "entityId", meta, "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, 'SystemConfig', $3, $4::jsonb, now())`,
        [ref.tenantId, AUDIT_ACTION, ref.id, JSON.stringify({ key: KEY, actor: "script" })],
      );
    }
    await tx.query("COMMIT");
    return write.length;
  } catch (err) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    tx.release();
  }
}

module.exports = {
  KEY,
  AUDIT_ACTION,
  keyRefs,
  liveTenantCount,
  poolConfig,
  runOrderGate,
  planDeletes,
  applyGate,
  parseAllowProtected,
  deleteAll,
};
