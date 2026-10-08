// #2500 (SA-481, option B hardened) — the ONE database target of wipe-tenant-fresh-start.js.
//
// The defect: the script dialled `DATABASE_PUBLIC_URL || DATABASE_URL` while its type-back banner
// printed `DATABASE_URL` alone, so an operator could confirm one database and wipe another. Now the
// URL is resolved exactly once, here, and the SAME value feeds the pg Pool, the redacted banner
// (with its source) and the guard. Two explicit paths, failing closed with neither:
//
//   --local                  the shared local allow-list (production-guard.js / local-db-target.cjs);
//                            the ONLY path for a test-tenant wipe.
//   --live-tenant-override   resolveDatabaseUrl({ requireProxy: true }) only — the Railway proxy under
//                            `railway run --service postgres`, never a stray DATABASE_URL. Owner-run,
//                            a client-requested fresh start of a LIVE tenant; --execute also needs
//                            --backup-taken, and the slug type-back still follows.
//
// Both are dry runs unless --execute. `--exclude-tenant <slug,...>` names tenants that are never
// wiped in any mode (the owner supplies it at run time; slugs are never written into git), and the
// live path refuses to run without it.
//
// Pure: no exit, no logging, no connection. The resolver, redaction and local classification are
// injected, so the spec drives every branch.

import payingTenant from "./paying-tenant.cjs";

const { protectedArm } = payingTenant;

export const BACKUP_COMMAND = (slug) =>
  `railway run --service postgres node apps/api/scripts/backup-production.mjs pre-fresh-start-${slug}`;

const FLAGS = new Set([
  "--execute",
  "--local",
  "--live-tenant-override",
  "--backup-taken",
  "--allow-paying-tenant",
]);

/** Strict argv: one positional slug, the known flags, `--exclude-tenant <slug,...>` (repeatable). */
export function parseFreshStartArgs(argv) {
  const out = {
    slug: null,
    execute: false,
    local: false,
    live: false,
    backupTaken: false,
    allowPayingTenant: false,
    exclude: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--exclude-tenant") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: "--exclude-tenant needs a value" };
      for (const s of v.split(",").map((x) => x.trim())) {
        if (!s) return { error: "--exclude-tenant has an empty slug" };
        if (!out.exclude.includes(s)) out.exclude.push(s);
      }
      i++;
    } else if (FLAGS.has(a)) {
      if (a === "--execute") out.execute = true;
      if (a === "--local") out.local = true;
      if (a === "--live-tenant-override") out.live = true;
      if (a === "--backup-taken") out.backupTaken = true;
      if (a === "--allow-paying-tenant") out.allowPayingTenant = true;
    } else if (a.startsWith("-")) {
      return { error: `unknown argument: ${a}` };
    } else if (out.slug === null) {
      out.slug = a;
    } else {
      return { error: `unexpected second tenant slug: ${a}` };
    }
  }
  return out;
}

/**
 * Decide the single target, or refuse.
 * @param args  parseFreshStartArgs() output (no error)
 * @param env   the process environment
 * @param deps  { resolve(env, {requireProxy}), redact(url), classifyLocal(url, env), isTestTenant(slug) }
 *              classifyLocal is production-guard.js's classifyDbTarget: { ok, config } | { ok:false, reason }
 * @returns {{ ok: false, exit: number, reason: string } |
 *           { ok: true, url: string, source: "local" | "Railway proxy", banner: string, poolConfig: object }}
 */
export function planFreshStart(args, env, deps) {
  const refuse = (reason, exit = 1) => ({ ok: false, exit, reason });
  if (!args.slug) return refuse("missing tenant slug", 2);
  if (args.local === args.live)
    return refuse(
      args.local
        ? "choose ONE path: --local and --live-tenant-override cannot be combined"
        : "choose a path: --local (a test tenant on a local database) or --live-tenant-override (owner-run, Railway proxy)",
      2,
    );
  if (args.exclude.includes(args.slug))
    return refuse(`"${args.slug}" is on the --exclude-tenant list: it is never wiped, in any mode`);

  let url;
  let source;
  let poolConfig;
  if (args.local) {
    if (!deps.isTestTenant(args.slug))
      return refuse(
        `--local wipes approved test tenants only; "${args.slug}" is not one ` +
          "(a client-requested live fresh start is --live-tenant-override, owner-run)",
      );
    try {
      url = deps.resolve(env, { requireProxy: false });
    } catch (err) {
      return refuse(`no local database target: ${err.message}`);
    }
    const verdict = deps.classifyLocal(url, env);
    if (!verdict.ok)
      return refuse(`--local refuses this target (${deps.redact(url)}): ${verdict.reason}`);
    source = "local";
    poolConfig = verdict.config;
  } else {
    if (deps.isTestTenant(args.slug))
      return refuse(
        `"${args.slug}" is a test tenant: wipe it with --local, never on the live path`,
      );
    if (args.exclude.length === 0)
      return refuse(
        "--live-tenant-override needs --exclude-tenant <slug,...> naming the tenants that must " +
          "never be wiped (supplied at run time, never written into git)",
      );
    try {
      url = deps.resolve(env, { requireProxy: true });
    } catch (err) {
      return refuse(`--live-tenant-override dials the Railway proxy only: ${err.message}`);
    }
    if (args.execute && !args.backupTaken)
      return refuse(
        `--execute on the live path needs --backup-taken. Take a fresh backup first:\n  ${BACKUP_COMMAND(args.slug)}`,
      );
    source = "Railway proxy";
    poolConfig = { connectionString: url };
  }
  return {
    ok: true,
    url,
    source,
    banner: `DB:     ${deps.redact(url)}  (source: ${source})`,
    poolConfig,
    // Printed on every live run, dry or not, so the backup is never a surprise at --execute.
    ...(args.live ? { backupCommand: BACKUP_COMMAND(args.slug) } : {}),
  };
}

/**
 * #2508 review (F1): the exclusion list must FAIL CLOSED. The slug compare in planFreshStart only
 * catches the exact spelling, so every excluded slug is also looked up in the SAME database the
 * wipe will hit (`found`, from prisma.tenant.findMany({ slug: { in: exclude } })): any slug that
 * names no tenant (a typo, a case variant) aborts the run, and the target is refused by tenant id.
 * @param exclude the --exclude-tenant slugs
 * @param found   [{ id, slug, name }] rows the database returned for them
 * @param tenant  the resolved target tenant { id, slug, name }
 * @returns {{ ok: true, lines: string[] } | { ok: false, reason: string }}
 */
export function checkExcludedTenants({ exclude, found, tenant }) {
  const bySlug = new Map(found.map((t) => [t.slug, t]));
  const unknown = exclude.filter((s) => !bySlug.has(s));
  if (unknown.length)
    return {
      ok: false,
      reason:
        `--exclude-tenant names no tenant: ${unknown.join(", ")} — an exclusion that protects ` +
        "nothing is refused (check the spelling; slugs are exact)",
    };
  const excluded = exclude.map((s) => bySlug.get(s));
  if (excluded.some((t) => t.id === tenant.id))
    return {
      ok: false,
      // SA-547b: id only — a business name is a client identifier, like a slug.
      reason: `tenant ${tenant.id} is excluded: it is never wiped, in any mode`,
    };
  return { ok: true, lines: excluded.map((t) => `EXCLUDED (never wiped): tenant ${t.id}`) };
}

/**
 * #2639 / SA-547: a PROTECTED target — paying (mrr.service's isPayingRow) or linked to a Stripe
 * subscription — is refused in EVERY mode (dry run included) unless `--allow-paying-tenant`. With the
 * flag, `--execute` additionally needs the operator to type `WIPE PAYING <slug>` after the slug
 * type-back. `tenant`/`sub` are the rows read from the SAME resolved database the wipe will hit.
 * @param tenant { id, slug, name, status, class, deletedAt }
 * @param sub    { planKey, stripeSubId } | null — the tenant's TenantSubscription row
 * @param protectedSlugs the Set from protected-slugs.cjs loadProtectedSlugs (row 195, env-listed arm)
 * @returns {{ ok: false, reason: string } | { ok: true, phrase: string | null, line: string | null }}
 */
export function checkProtectedTarget({ tenant, sub, allowPayingTenant, protectedSlugs }) {
  const arm = protectedArm(tenant, sub, protectedSlugs);
  if (arm === null) return { ok: true, phrase: null, line: null };
  const why =
    arm === "paying"
      ? "it is a PAYING tenant (ACTIVE, PRODUCTION, on a plan)"
      : "its subscription is linked to Stripe";
  if (!allowPayingTenant)
    return {
      ok: false,
      reason:
        // SA-547a: the id + arm only — a business NAME is a client identifier, like a slug.
        `tenant ${tenant.id} is protected: ${why}. Refused in every mode. ` +
        "An owner-approved wipe of a protected tenant needs --allow-paying-tenant plus a typed confirmation.",
    };
  return {
    ok: true,
    phrase: `WIPE PAYING ${tenant.slug}`,
    line: `PROTECTED (${arm}) — --allow-paying-tenant given; --execute will also ask for a typed confirmation.`,
  };
}
