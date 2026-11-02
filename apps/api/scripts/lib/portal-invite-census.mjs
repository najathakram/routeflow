/**
 * Row 633 / SA-820 S1: the one place the portal-invite census and its rotation agree on what "an invite an older
 * logging format may have recorded" means, so the count the owner reads and the set the rotation retires are the
 * same rows by construction.
 *
 * A LIVE invite is a CustomerLink with a stored invite code that has not expired (a null expiry counts as live,
 * exactly as `CustomersService.declineBuyerRequest` reads it). It is RECORDED when an AuditLog action still holds
 * that code (the interceptor used to store the request path as written). Newer rows hold the route template, so
 * they never match. Matching is a plain substring test on the stored code, never a pattern built from it.
 *
 * Nothing here selects or returns the code itself: a row carries only the link id, tenant id, status, how many
 * audit rows hold the code, and the code's SHA-256 (so a saved plan can prove a link still holds the SAME code
 * without ever storing it).
 */
import { createHash } from "node:crypto";

export const INVITE_PATH_FRAGMENT = "/buyer/invites/";

/** The audit rows that could hold a code at all: a small set, read once. */
const HITS_CTE = `WITH hits AS MATERIALIZED (
  SELECT a.id, a."tenantId", a.action FROM "AuditLog" a
   WHERE a.action LIKE '%${INVITE_PATH_FRAGMENT}%'
)`;

const LIVE_LINK_WHERE = `l."inviteToken" IS NOT NULL AND (l."inviteExpiresAt" IS NULL OR l."inviteExpiresAt" > now())`;

/** One row per live invite whose code appears in at least one audit row. */
export const RECORDED_INVITES_SQL = `${HITS_CTE}
SELECT l.id AS "linkId",
       l."tenantId" AS "tenantId",
       l.status::text AS status,
       encode(sha256(convert_to(l."inviteToken", 'UTF8')), 'hex') AS "tokenSha256",
       COUNT(h.id)::int AS "auditRows"
  FROM "CustomerLink" l
  JOIN hits h ON position(('${INVITE_PATH_FRAGMENT}' || l."inviteToken") IN h.action) > 0
 WHERE ${LIVE_LINK_WHERE}
 GROUP BY l.id, l."tenantId", l.status
 ORDER BY l.id`;

/** The denominators: every live invite, and every audit row on the invite path. */
export const TOTALS_SQL = `SELECT
  (SELECT COUNT(*)::int FROM "CustomerLink" l WHERE ${LIVE_LINK_WHERE}) AS "liveInvites",
  (SELECT COUNT(*)::int FROM "AuditLog" a WHERE a.action LIKE '%${INVITE_PATH_FRAGMENT}%') AS "invitePathRows"`;

/** Tenant labels, only read when the owner asks for the per-tenant list (`--by-tenant`). */
export const TENANT_LABELS_SQL = `SELECT t.id, t.slug, t.class::text AS class FROM "Tenant" t WHERE t.id = ANY($1::text[])`;

export const sha256Hex = (value) =>
  createHash("sha256").update(String(value), "utf8").digest("hex");

/** Pure: fold the recorded-invite rows and the totals into the counts the owner reads. Never keeps a code. */
export function summarizeCensus(rows, totals) {
  const tenants = new Set(rows.map((r) => r.tenantId));
  const byStatus = {};
  let auditRows = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    auditRows += r.auditRows;
  }
  return {
    liveInvites: totals.liveInvites,
    invitePathRows: totals.invitePathRows,
    recordedInvites: rows.length,
    auditRowsHoldingALiveCode: auditRows,
    tenantsAffected: tenants.size,
    byStatus,
  };
}

/** Pure: per-tenant counts for the owner's one-yes-per-tenant decision. */
export function countsByTenant(rows) {
  const byTenant = new Map();
  for (const r of rows) {
    const cur = byTenant.get(r.tenantId) ?? { tenantId: r.tenantId, invites: 0, auditRows: 0 };
    cur.invites += 1;
    cur.auditRows += r.auditRows;
    byTenant.set(r.tenantId, cur);
  }
  return [...byTenant.values()].sort((a, b) => a.tenantId.localeCompare(b.tenantId));
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every `<flag> <uuid>` pair on the command line (repeatable), validated as a UUID, lowercased and de-duplicated. */
export function uuidFlagValues(argv, flag) {
  const ids = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== flag) continue;
    const v = argv[i + 1];
    if (!v || !UUID_RE.test(v)) {
      throw Object.assign(new Error(`${flag} needs a tenant UUID, got ${JSON.stringify(v)}`), {
        refuse: true,
      });
    }
    ids.push(v.toLowerCase());
  }
  return [...new Set(ids)].sort();
}
