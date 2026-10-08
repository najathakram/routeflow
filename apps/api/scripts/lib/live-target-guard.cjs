// Live-target guard for every script that can WRITE to a database (row 195, SA-756r).
//
// A live-capable writer must be unable to touch a protected tenant (paying, Stripe-linked, or named
// in PROTECTED_TENANT_SLUGS) unless an operator names that tenant's id AND types a confirmation at a
// real terminal. This module is the one place that rule lives:
//
//   filterWritableTenants(rows, subsById, slugs)   multi-tenant writers: drop protected rows, print counts
//   assertWritableTenant(tenant, sub, slugs, opts)  single-target writers: throw unless a valid override
//   protectedTenantIds(client, slugs)               SQL writers: ids for `AND "tenantId" <> ALL($1::text[])`
//   confirmProtectedOverride({ tenantId, argv })    the only way to mint an override token
//   refuseRetiredFlags(argv)                         --allow-paying-tenant / --confirm-paying are gone
//
// No slug is ever printed or put in an error: ids and counts only.
// CLI:  node apps/api/scripts/lib/live-target-guard.cjs --check   ("N configured · M matched a tenant")

"use strict";

const { protectedArm } = require("./paying-tenant.cjs");
const { loadProtectedSlugs } = require("./protected-slugs.cjs");
const { isTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const ARMS = ["paying", "stripe-linked", "env-listed"];
const RETIRED_FLAGS = ["--allow-paying-tenant", "--confirm-paying"];
const OVERRIDE_BRAND = Symbol("protected-tenant-override");
const ADDITIVE_BRAND = Symbol("protected-additive-override");

class ProtectedTenantError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtectedTenantError";
  }
}

const subFor = (subsById, id) =>
  subsById instanceof Map ? subsById.get(id) : subsById ? subsById[id] : undefined;

/**
 * Multi-tenant writers: keep only the rows a script may write. Prints counts per arm, never a slug.
 * @param {Array<{ id: string, slug: string, status: string, class: string, deletedAt?: Date | null }>} rows
 * @param {Map<string, object> | Record<string, object>} subsById tenantId -> { planKey, stripeSubId }
 * @param {Set<string>} slugs from loadProtectedSlugs
 */
function filterWritableTenants(rows, subsById, slugs, { log = console.log } = {}) {
  const skipped = { paying: 0, "stripe-linked": 0, "env-listed": 0 };
  const writable = [];
  for (const row of rows) {
    const arm = protectedArm(row, subFor(subsById, row.id), slugs);
    if (arm === null) writable.push(row);
    else skipped[arm] += 1;
  }
  const total = ARMS.reduce((n, a) => n + skipped[a], 0);
  log(
    `protected-tenant guard: skipped ${total} of ${rows.length} tenant(s) ` +
      `(${ARMS.map((a) => `${a} ${skipped[a]}`).join(" · ")})`,
  );
  return { writable, skipped: { ...skipped, total } };
}

/**
 * Single-target writers. Returns the protecting arm when an override token for THIS tenant was
 * presented, null when the tenant is unprotected; throws ProtectedTenantError otherwise.
 * `allowProtected` must be a token from confirmProtectedOverride — `true` is not accepted.
 */
function assertWritableTenant(tenant, sub, slugs, { allowProtected } = {}) {
  const arm = protectedArm(tenant, sub, slugs);
  if (arm === null) return null;
  const valid =
    allowProtected &&
    ((allowProtected[OVERRIDE_BRAND] === true && allowProtected.tenantId === tenant.id) ||
      allowProtected[ADDITIVE_BRAND] === true);
  if (valid) return arm;
  throw new ProtectedTenantError(
    `tenant ${tenant.id} is protected (${arm}): refused. An operator override needs ` +
      "--allow-protected <tenantId> and --backup-taken, run at a real terminal.",
  );
}

/** --allow-paying-tenant / --confirm-paying were folded into --allow-protected; refuse them loudly. */
function refuseRetiredFlags(argv) {
  const hit = RETIRED_FLAGS.find((f) => argv.includes(f));
  if (hit)
    throw new ProtectedTenantError(
      `unknown argument: ${hit} (retired — use --allow-protected <tenantId> --backup-taken)`,
    );
}

function readline_ask(stdin, stdout, question) {
  const readline = require("node:readline");
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    }),
  );
}

/**
 * The ONLY way to mint an override token. Needs, all at once:
 *   --allow-protected <tenantId> naming THIS tenant, --backup-taken, a real terminal on BOTH stdin and
 *   stdout, and the typed phrase "ALLOW PROTECTED <tenantId>". The phrase has no argv or env form.
 */
async function confirmProtectedOverride({
  tenantId,
  argv,
  stdin = process.stdin,
  stdout = process.stdout,
  ask,
  backupFlag = "--backup-taken",
}) {
  const refuse = (why) =>
    new ProtectedTenantError(`tenant ${tenantId} is protected: override refused — ${why}.`);
  refuseRetiredFlags(argv);
  // The flag may repeat (one per protected tenant): any occurrence naming THIS tenant counts.
  if (!argv.some((a, i) => a === "--allow-protected" && argv[i + 1] === tenantId))
    throw refuse("--allow-protected must name this tenant's id");
  if (!argv.includes(backupFlag)) throw refuse(`${backupFlag} is required`);
  if (!(stdin && stdin.isTTY && stdout && stdout.isTTY))
    throw refuse("the confirmation needs a real terminal (stdin and stdout)");
  const phrase = `ALLOW PROTECTED ${tenantId}`;
  const typed = await (ask ?? ((q) => readline_ask(stdin, stdout, q)))(
    `Type "${phrase}" to continue: `,
  );
  if (String(typed).trim() !== phrase) throw refuse("the typed confirmation did not match");
  return Object.freeze({ [OVERRIDE_BRAND]: true, tenantId });
}

/**
 * ONE confirmation for a whole run that only ADDS rows across many tenants (publish-and-repin's
 * grandfather grants). Prints the number of protected tenants per arm — never a slug — then needs
 * `--backup-taken` (or `backupFlag`), a real terminal on stdin AND stdout, and the typed phrase
 * "ALLOW PROTECTED ADDITIVE <count>". Returns a token assertWritableTenant accepts for any tenant of
 * this run, or null when nothing in the run is protected. Never use it for a destructive script.
 * @param counts { paying, "stripe-linked", "env-listed" } protected tenants the run would touch
 */
async function confirmProtectedAdditive({
  counts,
  argv,
  stdin = process.stdin,
  stdout = process.stdout,
  ask,
  log = console.log,
  backupFlag = "--backup-taken",
}) {
  const total = ARMS.reduce((n, a) => n + (counts[a] ?? 0), 0);
  if (total === 0) return null;
  const refuse = (why) =>
    new ProtectedTenantError(`${total} protected tenant(s) in this run: refused — ${why}.`);
  log(
    `protected tenants in this run: ${total} ` +
      `(${ARMS.map((a) => `${a} ${counts[a] ?? 0}`).join(" · ")})`,
  );
  refuseRetiredFlags(argv);
  if (!argv.includes(backupFlag)) throw refuse(`${backupFlag} is required`);
  if (!(stdin && stdin.isTTY && stdout && stdout.isTTY))
    throw refuse("the confirmation needs a real terminal (stdin and stdout)");
  const phrase = `ALLOW PROTECTED ADDITIVE ${total}`;
  const typed = await (ask ?? ((q) => readline_ask(stdin, stdout, q)))(
    `Type "${phrase}" to continue: `,
  );
  if (String(typed).trim() !== phrase) throw refuse("the typed confirmation did not match");
  return Object.freeze({ [ADDITIVE_BRAND]: true, count: total });
}

const PROTECTION_SQL = `
  SELECT t.id, t.slug, t.status, t.class, t."deletedAt", s."planKey", s."stripeSubId"
  FROM "Tenant" t LEFT JOIN "TenantSubscription" s ON s."tenantId" = t.id`;

async function fetchProtectionRows(client) {
  return typeof client.query === "function"
    ? (await client.query(PROTECTION_SQL)).rows
    : await client.$queryRawUnsafe(PROTECTION_SQL);
}

/** Protected rows of the database as [{ id, slug, arm }]. Throws if a row lacks a string slug. */
async function protectedRows(client, slugs) {
  const out = [];
  for (const r of await fetchProtectionRows(client)) {
    if (typeof r.slug !== "string")
      throw new ProtectedTenantError("protectedTenantIds: a tenant row has no string slug");
    const arm = protectedArm(
      { slug: r.slug, status: r.status, class: r.class, deletedAt: r.deletedAt },
      { planKey: r.planKey, stripeSubId: r.stripeSubId },
      slugs,
    );
    if (arm !== null) out.push({ id: r.id, slug: r.slug, arm });
  }
  return out;
}

/**
 * SQL writers: ids of every protected tenant, for `AND "tenantId" <> ALL($1::text[])`. Fillers of
 * NULL tenantIds use the PARENT's derived tenant, so they exclude by the derived id the same way.
 * `client` is a pg Client/Pool (`query`) or a Prisma client (`$queryRawUnsafe`).
 * @returns {Promise<string[]>}
 */
async function protectedTenantIds(client, slugs) {
  return (await protectedRows(client, slugs)).map((r) => r.id);
}

/**
 * For destructive scripts whose only defence is productionGuard's host allow-list (a tunnel can make
 * production look local): refuse when the database they are about to wipe holds a PROTECTED tenant
 * that is not an approved test tenant. A local dev database holds only test tenants, so it passes.
 * Prints and throws counts only, never a slug.
 */
async function assertNoLiveProtectedTenants(client, slugs) {
  const live = (await protectedRows(client, slugs)).filter((r) => !isTestTenant(r.slug));
  if (live.length === 0) return;
  const per = Object.fromEntries(ARMS.map((a) => [a, live.filter((r) => r.arm === a).length]));
  throw new ProtectedTenantError(
    `this database holds ${live.length} protected non-test tenant(s) ` +
      `(${ARMS.map((a) => `${a} ${per[a]}`).join(" · ")}): a destructive local script refuses to run here.`,
  );
}

/** `--check` output: counts only. */
function describeCheck(configured, matched) {
  const lines = [`${configured} configured · ${matched} matched a tenant`];
  if (matched < configured)
    lines.push(
      `UNMATCHED: ${configured - matched} configured slug(s) match no tenant — check spelling`,
    );
  return lines;
}

async function checkMain(env = process.env) {
  const { resolveDatabaseUrl } = await import("./railway-db-url.mjs");
  const url = resolveDatabaseUrl(env);
  const slugs = loadProtectedSlugs(env, url);
  const { Client } = require("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const list = [...slugs];
    const res = list.length
      ? await client.query(
          'SELECT count(DISTINCT lower(btrim(slug)))::int AS n FROM "Tenant" WHERE lower(btrim(slug)) = ANY($1::text[])',
          [list],
        )
      : { rows: [{ n: 0 }] };
    const lines = describeCheck(list.length, res.rows[0].n);
    for (const l of lines) console.log(l);
    return lines.length === 1 ? 0 : 1;
  } finally {
    await client.end();
  }
}

module.exports = {
  ARMS,
  RETIRED_FLAGS,
  ProtectedTenantError,
  filterWritableTenants,
  assertWritableTenant,
  confirmProtectedOverride,
  confirmProtectedAdditive,
  refuseRetiredFlags,
  protectedTenantIds,
  assertNoLiveProtectedTenants,
  describeCheck,
};

if (require.main === module) {
  if (!process.argv.includes("--check")) {
    console.error("usage: node live-target-guard.cjs --check");
    process.exit(2);
  }
  checkMain().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
