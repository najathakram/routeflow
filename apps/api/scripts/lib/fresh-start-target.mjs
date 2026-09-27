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

export const BACKUP_COMMAND = (slug) =>
  `railway run --service postgres node apps/api/scripts/backup-production.mjs pre-fresh-start-${slug}`;

const FLAGS = new Set(["--execute", "--local", "--live-tenant-override", "--backup-taken"]);

/** Strict argv: one positional slug, the known flags, `--exclude-tenant <slug,...>` (repeatable). */
export function parseFreshStartArgs(argv) {
  const out = {
    slug: null,
    execute: false,
    local: false,
    live: false,
    backupTaken: false,
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
  };
}
