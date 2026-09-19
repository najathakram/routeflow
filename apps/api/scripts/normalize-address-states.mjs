#!/usr/bin/env node
/**
 * Dry-run-first backfill of `CustomerAddress.stateCode` from the free-text `state` column.
 *
 * WHY THIS EXISTS. The jurisdiction selling-restrictions engine reads ONLY `stateCode` (a nullable
 * CHAR(2)), never the free-text `state`. Every row written before that column shipped has
 * `stateCode = NULL`, so the engine cannot place those customers in a state until this backfill has
 * run. The API's write boundary already normalises new and edited addresses with `normalizeUsState`
 * (packages/types/api/us-states.ts); this tool does the same for the rows that predate it, and
 * LISTS the ones it cannot resolve instead of guessing.
 *
 * WHAT IT DOES TO A ROW (ids and verdicts only — see `lib/address-state-normalize.mjs`)
 *   RESOLVED_LOCAL_EXACT   `normalizeUsState(state)` already resolves it (a code or a full name,
 *                          any case, padded)            -> stateCode = <code>, stateNeedsReview = false
 *   RESOLVED_LOCAL_ALIAS   a traditional GPO/AP abbreviation (Calif., N.Y., Tex), a name with stray
 *                          punctuation, or a state with ONE trailing zip and/or country token
 *                          ("TX 77001", "Texas, USA")   -> stateCode = <code>, stateNeedsReview = false
 *   RESOLVED_GOOGLE        (--google only) Google Address Validation returned a COMPLETE US address
 *                          whose administrativeArea is a state -> stateCode = <code>, review = false
 *   UNRESOLVED:<reason>    listed, NEVER guessed. In --live the row gets ONLY
 *                          stateNeedsReview = true (the "State needs review" chip) — never a code.
 *                          Reasons: EMPTY (blank state) · UNPARSEABLE (text that is not a state) ·
 *                          NEEDS_GOOGLE (would need --google, not attempted) · GOOGLE_NO_MATCH ·
 *                          GOOGLE_INCOMPLETE · GOOGLE_ERROR (HTTP / timeout / network) ·
 *                          NULL_TENANT (never written, never sent anywhere).
 * There is no fuzzy matching, no edit distance, no city or zip inference: "Tejas" and "Texs" are
 * UNRESOLVED on purpose. Only rows with `stateCode IS NULL` are candidates, so a re-run after a
 * partial run is safe and already-normalised rows are never touched.
 *
 * MODES
 *   (default)     report — read-only. Lists every candidate row and a verdict. Exit 0.
 *   --dry-run     report + the exact parameterized UPDATE statements `--live` would run, with
 *                 their bound values. Still read-only. Exit 0.
 *   --live        report + typed confirmation, then ONE transaction of id-pinned UPDATEs.
 *                 Requires `--backup-attested "<free text naming the fresh backup>"`.
 *                 The confirmation phrase is `NORMALIZE <n> ADDRESSES`, `<n>` being the number of
 *                 rows that will be written (resolved rows + newly flagged rows).
 *   --json        print the report as JSON instead of prose (for the owner's records).
 *   --help        usage, exit 0.
 *   --tenant-slug <slug>   scope the run to ONE tenant. The intended rollout is TEST TENANT FIRST
 *                 (`--tenant-slug test`), then one client tenant at a time, then unscoped. A slug
 *                 that matches no tenant is exit 1. Unscoped runs also LIST NULL-tenant rows
 *                 (reason NULL_TENANT) — they are reported and never written.
 *
 * GOOGLE ADDRESS VALIDATION — OPT-IN, SENDS PII TO A THIRD PARTY
 *   --google          for rows still UNPARSEABLE after every local rule, call
 *                     POST https://addressvalidation.googleapis.com/v1:validateAddress with ONLY
 *                     { address: { regionCode: "US", addressLines: [line1, "<city>, <state> <zip>"] } }
 *                     — never line2, a name, an id, coordinates or a tenant. It happens in EVERY mode
 *                     including the read-only report and --dry-run (that is the only way to preview
 *                     what Google would resolve), and --live calls again: the two runs are billed
 *                     separately. A result is accepted ONLY when verdict.addressComplete === true
 *                     AND postalAddress.administrativeArea maps to a US state (and regionCode, when
 *                     present, is "US"). Blank-state (EMPTY) rows are never sent: there is no text
 *                     to normalize, so an answer would be Google inferring a value nobody recorded.
 *   --google-max <n>  hard cap on requests (default 200, ceiling 2000). If MORE rows need Google
 *                     than the cap, the run refuses with exit 2 — after the read-only listing,
 *                     before the first request and before any write — rather than truncating.
 *   The key is read from the GOOGLE_MAPS_API_KEY environment variable and is NEVER printed, logged
 *   or placed in a report; `--google` without it is exit 2 before any connection. Under
 *   `railway run --service postgres` only the postgres service's variables are injected, so export
 *   the key in your shell first. PREREQUISITE: the key's API restrictions must include the
 *   "Address Validation API" (the server key was created for Geocoding / Places / Routes / Maps
 *   JavaScript) — otherwise every call fails as GOOGLE_ERROR http-403 and nothing is resolved.
 *
 * UNATTENDED WRITES — ONLY INTO APPROVED TEST TENANTS
 *   --only-test-tenants  before ANY write, require `isTestTenant(slug)` from
 *                 `scripts/lib/test-tenants.cjs` — the single source of the policy, never restated
 *                 and never widened here — for the tenant of EVERY row the run would write. ONE
 *                 non-matching or unresolvable row refuses the WHOLE batch with exit 3 and ZERO
 *                 writes, listing every offending id and slug. Enforced in EVERY mode, so the
 *                 `--dry-run` the owner reads is the exact preflight of the live gate. NULL-tenant
 *                 rows are never written, so they cannot trip it.
 *   --confirm "<phrase>"  supplies the typed confirmation as a value, for an unattended `--live`.
 *                 Accepted ONLY alongside `--only-test-tenants` (exit 2 otherwise, before any
 *                 connection), and the phrase must equal EXACTLY the one the prompt would have
 *                 asked for — `NORMALIZE <n> ADDRESSES` with `<n>` computed from THIS invocation's
 *                 own classification. A mismatch is exit 3 with zero writes. It does NOT relax
 *                 `--backup-attested`. A client-tenant row keeps the interactive TTY prompt as its
 *                 ONLY path.
 *
 * A malformed batch (see `buildUpdates`) blocks report and `--dry-run` rather than failing them:
 * the refusal is printed to BOTH stdout and stderr, `--json` carries it as `batchError` with
 * `summary.blocked: true`, and the exit stays 0. `--live` lets it throw — there is nothing safe to
 * run.
 *
 * TEST-ONLY HOOK
 *   NORMALIZE_CONFIRM_TOKEN — supplies the typed confirmation as a value instead of reading a TTY,
 *   so `apps/api/src/common/normalize-address-states.db.spec.ts` can execute the --live path
 *   against the compose database. Honoured ONLY inside a jest worker (JEST_WORKER_ID set) that
 *   also sets it, with a WARNING line; ignored — loudly — anywhere else. It does NOT relax
 *   `--backup-attested`, and a value that does not match `NORMALIZE <n> ADDRESSES` is still exit 3.
 *
 * EXIT CODES
 *   0  report / dry-run printed, or `--live` applied every row
 *   1  error — no database URL, connection or query failure, unknown --tenant-slug, transaction error
 *   2  argument refusal, raised BEFORE any connection is opened (notably `--live` with no
 *      `--backup-attested`, `--confirm` without `--only-test-tenants`, `--google` without the key);
 *      also `--google-max` exceeded (raised after the read-only candidate query, before any row is printed or any request is sent)
 *   3  `--live` confirmation refused — stdin is not a TTY, or the typed text did not match; also
 *      the `--only-test-tenants` refusal (a target row outside an approved test tenant)
 *   4  `--live` rolled back — a row changed under us (its guarded UPDATE returned no row)
 *
 * PRODUCTION-SAFETY RULES (this is a data repair on a live database, not a schema change)
 *   - Take a FRESH backup first, and name it in `--backup-attested`. The tool cannot verify it;
 *     the attestation exists so the owner has to state it out loud.
 *   - Run report, then `--dry-run`, then `--live` — in that order, reading the output each time.
 *   - OWNER-RUN ONLY. Never run this from an implementation session, and never against a
 *     database you have not just read the target line for:
 *       railway run --service postgres node apps/api/scripts/normalize-address-states.mjs
 *   - This is NEVER a migration. It touches rows, never the datamodel; nothing here belongs in
 *     `apps/api/prisma/migrations/**`, and a re-run after a partial repair is safe because every
 *     statement still carries `AND "stateCode" IS NULL`.
 *   - Refusals are left alone on purpose. An unresolved row is a decision for the owner, not for a
 *     script — fix the address (or run with --google) and re-run the report.
 *   - Report/`--dry-run` set `default_transaction_read_only = on` for the whole session, so the
 *     server itself rejects a write; `--live` lifts it only after the confirmation, and says so.
 *   - Output discipline: ids, tenant ids, tenant slugs, verdicts and state codes only. The raw
 *     free-text `state` is shown ONLY for an UNRESOLVED row, JSON-escaped and cut to 40
 *     characters. Never an address line, city, zip, coordinate, business name, email, the Google
 *     key or request body, or the connection URL — the report listing does not even SELECT them
 *     unless --google needs them to build a request.
 *
 * OWNER COMMANDS (from the repo root; `<n>` and the backup text are what the previous step printed
 * and what you actually took)
 *   (a) report on prod — read-only:
 *         railway run --service postgres node apps/api/scripts/normalize-address-states.mjs
 *   (b) dry-run on prod — read-only, prints the exact statements:
 *         railway run --service postgres node apps/api/scripts/normalize-address-states.mjs --dry-run
 *   (c) TEST TENANT FIRST — dry-run for the count, then the unattended live run (backup first):
 *         railway run --service postgres node apps/api/scripts/normalize-address-states.mjs \
 *           --tenant-slug test --only-test-tenants --dry-run
 *         railway run --service postgres node apps/api/scripts/normalize-address-states.mjs \
 *           --tenant-slug test --only-test-tenants --live \
 *           --backup-attested "<the fresh backup you just took>" --confirm "NORMALIZE <n> ADDRESSES"
 *   (d) live on prod — typed confirmation on a TTY, fresh backup named:
 *         railway run --service postgres node apps/api/scripts/normalize-address-states.mjs --live \
 *           --backup-attested "<the fresh backup you just took>"
 *   (e) optional, sends addresses to Google — only after (a) shows NEEDS_GOOGLE rows you want tried:
 *         GOOGLE_MAPS_API_KEY=<server key> railway run --service postgres \
 *           node apps/api/scripts/normalize-address-states.mjs --dry-run --google --google-max 200
 */
import { createRequire } from "node:module";
import readline from "node:readline";
import { resolveDatabaseUrl } from "./lib/railway-db-url.mjs";
import {
  assertTestTenantTargets,
  buildUpdates,
  candidateSql,
  classifyBatch,
  GOOGLE_DEFAULT_MAX,
  GOOGLE_HARD_MAX,
  GoogleCapExceededError,
  reportLine,
  summarize,
} from "./lib/address-state-normalize.mjs";

const HELP = `normalize-address-states.mjs — backfill CustomerAddress.stateCode from the free-text state

Usage: node apps/api/scripts/normalize-address-states.mjs
         [--dry-run | --live] [--json] [--backup-attested "<text>"]
         [--tenant-slug <slug>] [--only-test-tenants [--confirm "<phrase>"]]
         [--google [--google-max <n>]]

Modes:
  (none)      read-only report: every candidate row (stateCode IS NULL) and a verdict
  --dry-run   the report plus the exact statements --live would execute (still read-only)
  --live      apply them in one transaction; requires --backup-attested AND a typed confirmation
  --json      print the report as JSON instead of prose
  --help      print this help and exit 0

Scope:
  --tenant-slug <slug>  only that tenant's rows. Roll out TEST TENANT FIRST (--tenant-slug test),
                        then one client tenant at a time. An unknown slug is exit 1. An unscoped
                        run also lists NULL-tenant rows (NULL_TENANT) — reported, never written.

Verdicts (one line per row: id, tenantId, verdict, proposed code):
  RESOLVED_LOCAL_EXACT   normalizeUsState already resolves it (code or full name)
  RESOLVED_LOCAL_ALIAS   a GPO/AP abbreviation (Calif., N.Y.), or a state plus ONE trailing zip /
                         country token ("TX 77001", "Texas, USA")
  RESOLVED_GOOGLE        (--google) Google returned a COMPLETE US address with a state
  UNRESOLVED:<reason>    listed, NEVER guessed; --live sets ONLY stateNeedsReview = true on it
    EMPTY  UNPARSEABLE  NEEDS_GOOGLE  GOOGLE_NO_MATCH  GOOGLE_INCOMPLETE  GOOGLE_ERROR  NULL_TENANT
  No fuzzy matching: "Tejas" and "Texs" are UNRESOLVED. The raw state text is shown ONLY for
  UNRESOLVED rows, JSON-escaped and cut to 40 characters — never an address line, city or zip.
  Tip: pipe the report through  grep UNRESOLVED  to see only the rows that need a decision.
  Confirmation phrase: NORMALIZE <n> ADDRESSES

Google Address Validation (opt-in; SENDS line1 + "<city>, <state> <zip>" TO GOOGLE):
  --google            for UNPARSEABLE rows only, in EVERY mode (report and --dry-run included);
                      needs GOOGLE_MAPS_API_KEY in the environment (exit 2 without it). The key
                      needs the "Address Validation API" enabled. Accepted only when the address
                      is COMPLETE and the administrativeArea is a US state. Never printed.
  --google-max <n>    cap on requests (default ${GOOGLE_DEFAULT_MAX}, ceiling ${GOOGLE_HARD_MAX}). More rows than the cap
                      is exit 2 before any request or write — never a silent truncation.

Unattended writes (approved TEST tenants only):
  --only-test-tenants   before any write, require an approved test tenant (isTestTenant in
                        scripts/lib/test-tenants.cjs: test, e2e-routeflow, routeflow-demo, or a
                        slug matching qa-/e2e-/ux-audit-) for every row the run would write. ONE
                        non-matching or unresolvable row refuses the whole batch — exit 3, zero
                        writes, offending ids and slugs listed. Enforced in every mode, so --dry-run
                        previews the same gate.
  --confirm "<phrase>"  supply the typed confirmation as a value instead of a TTY prompt. Allowed
                        ONLY with --only-test-tenants (exit 2 otherwise, before connecting), and
                        the phrase must equal exactly what the prompt would have asked for —
                        NORMALIZE <n> ADDRESSES, with <n> the row count this run computed. A
                        mismatch is exit 3 with zero writes. It does NOT relax --backup-attested,
                        and a client-tenant row keeps the TTY prompt as its only path.

DATABASE_URL resolution (Railway proxy vars win over DATABASE_URL) — see lib/railway-db-url.mjs.

Exit codes: 0 ok · 1 error · 2 argument refusal (before connecting; also --google-max exceeded)
            · 3 confirmation refused · 4 rolled back (a row changed under us)
`;

// ─── arguments ────────────────────────────────────────────────────────────────────────────────
// Parsed and validated BEFORE anything else runs: no URL is resolved, no driver is loaded and no
// connection is opened until the flags are known to be coherent. `--live` with no attested backup
// (or `--google` with no key) must be able to fail on a machine with no database at all.

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function parseArgs(argv, env) {
  const opts = {
    help: false,
    dryRun: false,
    live: false,
    json: false,
    backupAttested: null,
    onlyTestTenants: false,
    // `null` = not supplied. An EMPTY string is supplied-and-wrong, and must reach the phrase
    // comparison (exit 3) rather than falling back to the prompt.
    confirm: null,
    tenantSlug: null,
    google: false,
    googleMax: null,
    errors: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--live") opts.live = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--backup-attested") opts.backupAttested = argv[++i] ?? "";
    else if (arg.startsWith("--backup-attested="))
      opts.backupAttested = arg.slice("--backup-attested=".length);
    else if (arg === "--only-test-tenants") opts.onlyTestTenants = true;
    else if (arg === "--confirm") opts.confirm = argv[++i] ?? "";
    else if (arg.startsWith("--confirm=")) opts.confirm = arg.slice("--confirm=".length);
    else if (arg === "--tenant-slug") opts.tenantSlug = argv[++i] ?? "";
    else if (arg.startsWith("--tenant-slug=")) opts.tenantSlug = arg.slice("--tenant-slug=".length);
    else if (arg === "--google") opts.google = true;
    else if (arg === "--google-max") opts.googleMax = argv[++i] ?? "";
    else if (arg.startsWith("--google-max=")) opts.googleMax = arg.slice("--google-max=".length);
    else opts.errors.push(`unknown argument "${arg}"`);
  }
  if (opts.dryRun && opts.live) opts.errors.push("--dry-run and --live are mutually exclusive");
  // An unattended confirmation is allowed ONLY inside the test-tenant guard. Without it there is
  // nothing standing between `--confirm` and a client tenant's rows, so the flag is refused here,
  // before any connection — the TTY prompt stays the sole path for client data.
  if (opts.confirm !== null && !opts.onlyTestTenants) {
    opts.errors.push(
      '--confirm "<phrase>" requires --only-test-tenants — an unattended confirmation is allowed ' +
        "only when every target row resolves to an approved test tenant; client-tenant rows keep " +
        "the interactive TTY confirmation as their only path",
    );
  }
  // `--json` prints its document only AFTER the write, so an interactive `--live --json` would
  // ask the owner to type the confirmation phrase having shown them no listing at all.
  if (opts.json && opts.live && opts.confirm === null) {
    opts.errors.push(
      "--json cannot be combined with an interactive --live (the listing must be read BEFORE the " +
        "confirmation prompt) — run --live without --json, or use --only-test-tenants --confirm",
    );
  }
  if (opts.live && !String(opts.backupAttested ?? "").trim()) {
    opts.errors.push(
      '--live requires --backup-attested "<free text naming the fresh backup>" — take the ' +
        "backup first, then say which one it is",
    );
  }
  if (opts.tenantSlug !== null && !SLUG_PATTERN.test(opts.tenantSlug)) {
    opts.errors.push(
      "--tenant-slug requires a tenant slug (lowercase letters, digits and hyphens, e.g. `test`)",
    );
  }
  if (opts.googleMax !== null) {
    const n = /^\d+$/.test(opts.googleMax) ? Number(opts.googleMax) : NaN;
    if (!opts.google) {
      opts.errors.push("--google-max is only meaningful with --google");
    } else if (!Number.isInteger(n) || n < 1 || n > GOOGLE_HARD_MAX) {
      opts.errors.push(`--google-max must be a whole number from 1 to ${GOOGLE_HARD_MAX}`);
    }
  }
  // Sending addresses to a third party needs the key AND the explicit flag. The key's VALUE is
  // never echoed — only its absence is reported.
  if (opts.google && !String(env.GOOGLE_MAPS_API_KEY ?? "").trim()) {
    opts.errors.push(
      "--google requires GOOGLE_MAPS_API_KEY in the environment — nothing is sent to Google without it",
    );
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2), process.env);
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}
if (opts.errors.length > 0) {
  for (const error of opts.errors) console.error(`normalize-address-states: ${error}`);
  console.error("normalize-address-states: refused before opening any connection");
  process.exit(2);
}

const mode = opts.live ? "live" : opts.dryRun ? "dry-run" : "report";
const say = opts.json ? () => {} : (...args) => console.log(...args);
const googleMax = opts.googleMax === null ? GOOGLE_DEFAULT_MAX : Number(opts.googleMax);

let databaseUrl;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch (e) {
  console.error(`normalize-address-states: ${e.message}`);
  process.exit(1);
}

// host + database only — never the URL, which carries the password.
const target = (() => {
  try {
    const u = new URL(databaseUrl);
    return `${u.host}${u.pathname}`;
  } catch {
    return "<unparseable target>";
  }
})();

// ─── formatting ───────────────────────────────────────────────────────────────────────────────

/** The `--dry-run` listing: one numbered statement, then each bound value on its own line. */
function printStatements(updates) {
  updates.forEach((update, index) => {
    say(`  [${index + 1}] ${update.sql}`);
    update.params.forEach((value, i) => say(`        $${i + 1} = ${value}`));
  });
}

// ─── main ─────────────────────────────────────────────────────────────────────────────────────

let client = null;

function connect(connectionString) {
  // `pg` is required lazily so argument validation above can never be preceded by a driver load.
  const { Client } = createRequire(import.meta.url)("pg");
  return new Client({ connectionString });
}

// Test-only: the typed confirmation, supplied as a value instead of read from a TTY, so the
// DB-lane spec can execute the --live path end to end. Honoured ONLY inside a jest worker that
// also sets it, announced loudly when honoured, and ignored — also loudly — anywhere else, the
// same shape as BACKFILL_CONFIRM_TOKEN in backfill-legacy-tenant-ids.mjs. It never relaxes
// --backup-attested: an unattended --live still has to name a backup.
function confirmTokenOverride() {
  const raw = process.env.NORMALIZE_CONFIRM_TOKEN;
  if (!raw) return undefined;
  if (!process.env.JEST_WORKER_ID) {
    console.error(
      "normalize-address-states: NORMALIZE_CONFIRM_TOKEN is ignored outside test " +
        "(JEST_WORKER_ID unset); the confirmation must be typed on a TTY",
    );
    return undefined;
  }
  console.error(
    "normalize-address-states: WARNING: test override NORMALIZE_CONFIRM_TOKEN active — " +
      "this is NOT an owner-typed confirmation",
  );
  return raw;
}

function ask(question) {
  return new Promise((resolve) => {
    // The prompt goes to stderr so `--json --live` still emits a clean JSON document on stdout.
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * The ONE write path: typed confirmation, then a single transaction of guarded statements whose
 * RETURNING is checked row by row. `applied` is filled in place (action -> count). Returns an exit
 * code: 0 applied, 3 confirmation refused, 4 rolled back because a row no longer matched its
 * guarded WHERE.
 */
async function confirmAndApply(updates, phrase, applied) {
  // `--confirm "<phrase>"` is the OWNER's unattended confirmation, admissible only alongside
  // `--only-test-tenants` (enforced in parseArgs, before any connection) — so by the time it is
  // read here, every row in `updates` has already been proven to land in an approved test tenant.
  // It takes precedence over the jest-only NORMALIZE_CONFIRM_TOKEN, which stays what it was: a
  // test hook, ignored loudly outside a jest worker. Neither relaxes `--backup-attested`, and
  // neither relaxes the phrase check below — an unattended run still has to name the exact count.
  const injected = opts.confirm !== null ? opts.confirm : confirmTokenOverride();
  if (injected === undefined && !process.stdin.isTTY) {
    console.error(
      "normalize-address-states: refused — --live needs an interactive TTY for the typed " +
        "confirmation, and stdin is not one",
    );
    return 3;
  }
  const answer = injected ?? (await ask(`Type "${phrase}" to proceed: `));
  if (answer.trim() !== phrase) {
    console.error("normalize-address-states: refused — confirmation text did not match");
    return 3;
  }

  say("\n  session read-only flag lifted for this repair; opening one transaction");
  await client.query("SET default_transaction_read_only = off");
  await client.query("BEGIN");
  try {
    // Report order, inside this ONE transaction — so a row that changed under us rolls back
    // everything written beside it.
    for (const update of updates) {
      const res = await client.query(update.sql, update.params);
      if (res.rows.length !== 1) {
        await client.query("ROLLBACK");
        console.error(
          `normalize-address-states: ROLLED BACK — ${update.table} ${update.id} was no longer ` +
            "an unnormalised row in the state the report showed (it changed under us); " +
            "nothing was written",
        );
        return 4;
      }
      applied[update.action] = (applied[update.action] ?? 0) + 1;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }

  say("\n=== APPLIED ===");
  for (const [action, n] of Object.entries(applied)) say(`  ${action.padEnd(16)} ${n}`);
  say(`  ${"TOTAL".padEnd(16)} ${updates.length}\n`);
  return 0;
}

async function run() {
  say(`\n=== CUSTOMER ADDRESS STATE NORMALIZATION — ${mode} — ${target} ===`);
  say(
    `    scope: ${opts.tenantSlug === null ? "ALL tenants (plus NULL-tenant rows, listed only)" : `tenant slug ${opts.tenantSlug}`}`,
  );
  say("    session is READ ONLY; ids, verdicts and codes only — no address data\n");

  if (opts.tenantSlug !== null) {
    const { rows } = await client.query('SELECT "id" FROM "Tenant" WHERE "slug" = $1', [
      opts.tenantSlug,
    ]);
    if (rows.length === 0) {
      console.error(`normalize-address-states: no tenant has the slug "${opts.tenantSlug}"`);
      return 1;
    }
  }

  const listing = await client.query(
    candidateSql({ withAddress: opts.google, tenantScoped: opts.tenantSlug !== null }),
    opts.tenantSlug !== null ? [opts.tenantSlug] : [],
  );

  let batch;
  try {
    batch = await classifyBatch(listing.rows, {
      google: opts.google
        ? {
            apiKey: process.env.GOOGLE_MAPS_API_KEY.trim(),
            max: googleMax,
            onStart: ({ needed, max }) =>
              say(
                `  GOOGLE: sending ${needed} address(es) to Google Address Validation ` +
                  `(cap ${max}) — line1 + "<city>, <state> <zip>" only\n`,
              ),
          }
        : null,
    });
  } catch (e) {
    if (e instanceof GoogleCapExceededError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
  const { reports, google } = batch;

  for (const report of reports) say(`  ${reportLine(report)}`);
  if (reports.length === 0) say("  CustomerAddress  (no rows with a NULL stateCode)");
  say("");

  // A malformed batch (see buildUpdates) must not turn a READ-ONLY run — the thing the owner
  // reads to decide — into a failure: report and --dry-run print the refusal and still exit 0
  // with `summary.blocked: true`. Only --live lets it throw, because there is nothing safe to
  // run. The refusal goes to stdout as well as stderr (and into --json as `batchError`).
  let updates = [];
  let batchError = null;
  try {
    updates = buildUpdates(reports);
  } catch (e) {
    if (mode === "live") throw e;
    batchError = `normalize-address-states: no write list could be built — ${e.message}`;
    console.error(batchError);
    say(batchError);
  }

  const counts = summarize(reports, updates);
  say("=== SUMMARY ===");
  say(`  candidates             ${counts.candidates}`);
  say(`  RESOLVED_LOCAL_EXACT   ${counts.resolvedLocalExact}`);
  say(`  RESOLVED_LOCAL_ALIAS   ${counts.resolvedLocalAlias}`);
  say(`  RESOLVED_GOOGLE        ${counts.resolvedGoogle}`);
  say(
    `  UNRESOLVED             ${counts.unresolved}` +
      (counts.unresolved > 0
        ? `  (${Object.entries(counts.unresolvedByReason)
            .map(([reason, n]) => `${reason}=${n}`)
            .join(" ")}; ${counts.alreadyFlagged} already flagged)`
        : ""),
  );
  say(
    `  rows to write          ${counts.toWrite}  (set state ${counts.toSetState}, flag for review ${counts.toFlag})`,
  );
  if (google.enabled) {
    const errorKinds = Object.entries(google.errors);
    say(
      `  google                 attempted=${google.attempted} resolved=${google.resolved}` +
        (errorKinds.length > 0
          ? ` errors=${errorKinds.map(([kind, n]) => `${kind}:${n}`).join(",")}`
          : ""),
    );
    if (errorKinds.length > 0) {
      say("  ! some Google requests failed — those rows are GOOGLE_ERROR (a re-run retries them);");
      say("    http-403 usually means the Address Validation API is not enabled for this key");
    }
  }
  say("");

  const applied = {};
  const slugById = new Map();
  for (const report of reports) {
    if (report.tenantId) slugById.set(report.tenantId, report.tenantSlug ?? null);
  }

  /** The `--json` document, emitted from exactly ONE place so a refusal cannot drift from the
   *  normal shape. Never carries the Google key or a request body, and the rows never held an
   *  address line, city, zip, coordinate or name. */
  const emitJson = (extra = {}) => {
    if (!opts.json) return;
    console.log(
      JSON.stringify(
        {
          mode,
          target,
          generatedAt: new Date().toISOString(),
          tenantSlug: opts.tenantSlug,
          onlyTestTenants: opts.onlyTestTenants,
          backupAttested: opts.live ? opts.backupAttested : null,
          google: { ...google, max: google.enabled ? googleMax : null },
          rows: reports,
          summary: {
            ...counts,
            ...(batchError || extra.testTenantError ? { blocked: true } : {}),
          },
          ...(batchError ? { batchError } : {}),
          ...(extra.testTenantError ? { testTenantError: extra.testTenantError } : {}),
          updates: mode === "report" ? null : updates,
          applied: mode === "live" ? applied : null,
        },
        null,
        2,
      ),
    );
  };

  // `--only-test-tenants` — the gate that makes an unattended `--confirm` acceptable. It runs on
  // the WRITE LIST (so rows that are never written, NULL-tenant ones included, cannot fail it) and
  // in EVERY mode, so the `--dry-run` the owner reads is the exact preflight of `--live`. A blocked
  // batch has no write list to judge, so the batchError refusal above wins.
  if (opts.onlyTestTenants && !batchError) {
    try {
      assertTestTenantTargets(updates, slugById);
    } catch (e) {
      const testTenantError = e.message;
      console.error(testTenantError);
      say("=== REFUSED — --only-test-tenants ===");
      say(testTenantError);
      say("\n=== END — nothing was modified ===\n");
      emitJson({ testTenantError });
      return 3;
    }
  }

  if (mode === "dry-run") {
    say(
      batchError
        ? "=== DRY RUN — BLOCKED, no write list could be built; nothing to show ==="
        : `=== DRY RUN — the ${updates.length} statement(s) --live would execute ===`,
    );
    printStatements(updates);
    say("\n=== END — nothing was modified ===\n");
  }

  if (mode === "live") {
    if (updates.length === 0) {
      say("=== LIVE — no rows to write; nothing to do ===\n");
    } else {
      const code = await confirmAndApply(updates, `NORMALIZE ${updates.length} ADDRESSES`, applied);
      if (code !== 0) return code;
    }
  }

  emitJson();
  return 0;
}

async function main() {
  client = connect(databaseUrl);
  await client.connect();

  // Read-only for the whole session first, in every mode. Only `confirmAndApply` lifts it, after
  // the report has been printed and the confirmation typed — never before.
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '60s'");

  return run();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`normalize-address-states: failed — ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => client?.end?.());
