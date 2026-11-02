/**
 * READ-ONLY census (row 633 / SA-820 S1, R633-1): how many LIVE portal invites hold a code that an older logging
 * format may have recorded in an audit row? Read it BEFORE any rotation: the rotation retires exactly these.
 *
 *   railway run --service postgres node apps/api/scripts/report-portal-invite-census.mjs [--json] [--by-tenant]
 *   node apps/api/scripts/report-portal-invite-census.mjs --self-test      (no database)
 *
 * WHAT IT COUNTS (definitions live in lib/portal-invite-census.mjs, shared with the rotation):
 *   - liveInvites                   portal invites with a stored, unexpired code;
 *   - invitePathRows                audit rows on the invite route (the denominator);
 *   - recordedInvites               live invites whose code appears in at least one audit row;
 *   - auditRowsHoldingALiveCode     those audit rows;
 *   - tenantsAffected, byStatus     how widely, and in which link state.
 * Rows written after the redaction slice hold the route template, so they never count: a recorded count that stops
 * growing after that deploy is the evidence the new rows are clean.
 *
 * OUTPUT is COUNTS ONLY by default: no code, link id, tenant id, name or e-mail. `--by-tenant` adds one line per
 * affected tenant (slug, class, counts) for the owner's one-yes-per-tenant decision. It is meant for the owner's own
 * terminal: do not paste it into a ticket, PR or chat.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` and `lock_timeout` cap
 * every query; the target is the one `resolveReportDbUrl` resolves (the redacted target goes to stderr; nothing
 * usable = exit 2 without connecting); only SELECT statements appear; the connection is closed in `finally`.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECORDED_INVITES_SQL,
  TENANT_LABELS_SQL,
  TOTALS_SQL,
  countsByTenant,
  summarizeCensus,
} from "./lib/portal-invite-census.mjs";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);

const NAME = "report-portal-invite-census";

/** No-DB checks of the pure parts and the SQL's shape (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const rows = [
    { linkId: "l1", tenantId: "t1", status: "INVITED", tokenSha256: "x", auditRows: 2 },
    {
      linkId: "l2",
      tenantId: "t1",
      status: "PENDING_SELLER_APPROVAL",
      tokenSha256: "y",
      auditRows: 1,
    },
    { linkId: "l3", tenantId: "t2", status: "INVITED", tokenSha256: "z", auditRows: 1 },
  ];
  eq(
    summarizeCensus(rows, { liveInvites: 9, invitePathRows: 14 }),
    {
      liveInvites: 9,
      invitePathRows: 14,
      recordedInvites: 3,
      auditRowsHoldingALiveCode: 4,
      tenantsAffected: 2,
      byStatus: { INVITED: 2, PENDING_SELLER_APPROVAL: 1 },
    },
    "summarizeCensus",
  );
  eq(
    countsByTenant(rows),
    [
      { tenantId: "t1", invites: 2, auditRows: 3 },
      { tenantId: "t2", invites: 1, auditRows: 1 },
    ],
    "countsByTenant",
  );
  eq(summarizeCensus([], { liveInvites: 0, invitePathRows: 0 }).recordedInvites, 0, "empty");
  for (const sql of [RECORDED_INVITES_SQL, TOTALS_SQL, TENANT_LABELS_SQL]) {
    if (/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY)\b/i.test(sql))
      throw new Error("the census SQL must be read-only");
  }
  // The select list may hold the code only inside its SHA-256; the bare code must never be returned.
  const main = RECORDED_INVITES_SQL.slice(RECORDED_INVITES_SQL.indexOf("SELECT l.id"));
  const list = main
    .slice(0, main.indexOf("FROM"))
    .replace(/encode\(sha256\(convert_to\(l\."inviteToken", 'UTF8'\)\), 'hex'\)/, "");
  if (/inviteToken/.test(list)) throw new Error("the census must never select the code itself");
  return "self-test ok";
}

function printCounts(c) {
  console.log("\n=== PORTAL INVITE CENSUS (counts only) ===");
  console.log(`live invites (stored, unexpired code):          ${c.liveInvites}`);
  console.log(`audit rows on the invite route:                 ${c.invitePathRows}`);
  console.log(`live invites whose code an audit row holds:     ${c.recordedInvites}`);
  console.log(`  audit rows holding a live code:               ${c.auditRowsHoldingALiveCode}`);
  console.log(`  tenants affected:                             ${c.tenantsAffected}`);
  for (const [status, n] of Object.entries(c.byStatus)) console.log(`  in state ${status}: ${n}`);
  console.log(
    "\nRotation retires exactly these invites (they must be sent again). It is a separate, owner-run step.",
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const byTenant = argv.includes("--by-tenant");
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);
  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET lock_timeout = '5s'");
    const rows = (await client.query(RECORDED_INVITES_SQL)).rows;
    const totals = (await client.query(TOTALS_SQL)).rows[0];
    const report = summarizeCensus(rows, totals);
    let tenants = [];
    if (byTenant) {
      const counts = countsByTenant(rows);
      const labels = counts.length
        ? (await client.query(TENANT_LABELS_SQL, [counts.map((c) => c.tenantId)])).rows
        : [];
      const labelOf = new Map(labels.map((l) => [l.id, l]));
      tenants = counts.map((c) => ({
        slug: labelOf.get(c.tenantId)?.slug ?? "?",
        class: labelOf.get(c.tenantId)?.class ?? "?",
        invites: c.invites,
        auditRows: c.auditRows,
      }));
    }
    if (json) console.log(JSON.stringify(byTenant ? { ...report, tenants } : report, null, 2));
    else {
      printCounts(report);
      if (byTenant) {
        console.log("\nPer tenant (for the owner's own terminal only):");
        for (const t of tenants)
          console.log(
            `  ${t.slug} [${t.class}]: ${t.invites} invite(s), ${t.auditRows} audit row(s)`,
          );
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

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
