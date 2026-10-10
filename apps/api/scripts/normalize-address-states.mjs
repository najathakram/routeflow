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
 *   RESOLVED_GOOGLE        (--google only) Google Address Validation returned a COMPLETE, CONFIRMED
 *                          US answer whose state was neither inferred, replaced nor spell-corrected
 *                          -> stateCode = <code>, review = false
 *   UNRESOLVED:<reason>    listed, NEVER guessed. In --live the row gets ONLY
 *                          stateNeedsReview = true (the "State needs review" chip) — never a code.
 *                          Reasons: EMPTY (blank state) · UNPARSEABLE (text that is not a state) ·
 *                          NEEDS_GOOGLE (would need --google, not attempted) · NEEDS_ZIP (would
 *                          need Google but has no usable 5-digit zip — never sent) ·
 *                          AMBIGUOUS_NEEDS_ZIP (a text that is also a city's name — "Washington",
 *                          "Kansas", "L.A." — with no valid civilian zip to confirm the state;
 *                          add or fix the zip and re-run, Google is NOT involved) ·
 *                          GOOGLE_NO_MATCH · GOOGLE_INCOMPLETE · GOOGLE_INFERRED (Google inferred,
 *                          replaced or could not confirm a component) · GOOGLE_ERROR (HTTP /
 *                          timeout / network) · ZIP_CONFLICT (a resolved state that contradicts the
 *                          row's own zip — see below) · NULL_TENANT (never written, never sent).
 * ZIP CROSS-CHECK. After ANY resolution (local or Google), a row with a parseable 5-digit zip whose
 * 3-digit prefix has a known state set (`lib/us-zip3.mjs`; military and unassigned prefixes have no
 * set, so no check) is UNRESOLVED:ZIP_CONFLICT when the resolved code is not in that set — bare
 * "Washington" with a DC zip, "L.A." (alias `la` = Louisiana) with a Los Angeles zip. For an
 * UNAMBIGUOUS text a blank zip skips the check; for an AMBIGUOUS one (`AMBIGUOUS_STATE_TEXTS`) a
 * blank, invalid, military or unassigned zip is UNRESOLVED:AMBIGUOUS_NEEDS_ZIP — only a zip that
 * CONFIRMS the state resolves it. A false conflict only lists a row; a false agreement would write
 * a wrong state, so the table errs wide.
 * There is no fuzzy matching, no edit distance, no city inference: "Tejas" and "Texs" are
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
 *   --expect-rows <n>   the write count your own `--dry-run` printed ("rows to write"). REQUIRED for
 *                 every `--live` except the unattended `--only-test-tenants --confirm` path (where
 *                 it is optional): a mismatch with the count THIS run computed is exit 3 with zero
 *                 writes, so the phrase you type can never be copied from the wrong run. `--live`
 *                 only.
 *   --max-rows <n>  ceiling on candidate rows after scope (default 500). More candidates is exit 2
 *                 BEFORE any Google request and before any write — never a silent truncation. Raise
 *                 it deliberately after reading the report.
 *   --show-unresolved-text  opt in to printing the raw free-text `state` of UNRESOLVED rows
 *                 (JSON-escaped, cut to 40 chars). Off by default: reports show verdict + reason only.
 *   --json        print the report as JSON instead of prose (for the owner's records).
 *   --help        usage, exit 0.
 *   --tenant-slug <slug>   scope the run to ONE tenant. The intended rollout is TEST TENANT FIRST
 *                 (`--tenant-slug test`), then one client tenant at a time, then unscoped. A slug
 *                 that matches no tenant is exit 1. Unscoped runs also LIST NULL-tenant rows
 *                 (reason NULL_TENANT) — they are reported and never written. REQUIRED by --google.
 *
 * GOOGLE ADDRESS VALIDATION — OPT-IN, SENDS PII TO A THIRD PARTY
 *   --google          REQUIRES `--tenant-slug <slug>` (exit 2 otherwise, before any connection):
 *                     Google runs ONE TENANT AT A TIME, so the run's blast radius is a tenant you
 *                     named. With `--only-test-tenants` the tenant gate is judged on the candidate
 *                     listing BEFORE any request (a non-approved tenant is exit 3, zero requests).
 *                     For rows still UNPARSEABLE after every local rule AND carrying a street line
 *                     and a usable 5-digit zip (a blank zip is NEEDS_ZIP — without one Google infers
 *                     the state), call
 *                     POST https://addressvalidation.googleapis.com/v1:validateAddress with ONLY
 *                     { address: { regionCode: "US", addressLines: [line1, "<city>, <state> <zip>"] } }
 *                     — never line2, a name, an id, coordinates or a tenant. It happens in EVERY mode
 *                     including the read-only report and --dry-run (that is the only way to preview
 *                     what Google would resolve), and --live calls again: the two runs are billed
 *                     separately. A result is accepted ONLY when ALL hold: verdict.addressComplete
 *                     === true; regionCode === "US"; administrativeArea maps to a US state;
 *                     addressComponents is present; its administrative_area_level_1 component is
 *                     CONFIRMED and not inferred / replaced / spellCorrected; no locality or
 *                     postal_code component is inferred or replaced; hasReplacedComponents is not
 *                     true. Anything else is GOOGLE_INFERRED (or the older reasons) — listed, never
 *                     written. An accepted answer is then ZIP-cross-checked like any other.
 *                     Blank-state (EMPTY) rows are never sent: there is no text to normalize, so an
 *                     answer would be Google inferring a value nobody recorded.
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
 *   --only-test-tenants  require `isTestTenant(slug)` from `scripts/lib/test-tenants.cjs` — the
 *                 single source of the policy, never restated and never widened here — for the
 *                 tenant of EVERY candidate row, judged on the CANDIDATE LISTING before anything is
 *                 classified: so before any Google request, and before any write. ONE non-matching
 *                 or unresolvable tenant refuses the WHOLE batch with exit 3, ZERO requests and
 *                 ZERO writes. The refusal names tenant ids and slugs only (no address rows) and
 *                 goes to STDERR always, also under --json. Enforced in EVERY mode, so the
 *                 `--dry-run` the owner reads is the exact preflight of the live gate. NULL-tenant
 *                 rows are never written or sent, so they cannot trip it. The write list is then
 *                 re-checked against the same policy as a second line of defence.
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
 *      `--backup-attested`, `--live` with neither `--expect-rows` nor `--only-test-tenants
 *      --confirm`, `--confirm` without `--only-test-tenants`, `--google` without the key or
 *      without `--tenant-slug`, an invalid `--max-rows`); also `--max-rows` or `--google-max`
 *      exceeded (raised after the read-only candidate query, before any row is printed, any
 *      request is sent or any write happens)
 *   3  `--live` confirmation refused — stdin is not a TTY, the typed text did not match, or
 *      `--expect-rows` differs from the computed write count; also the `--only-test-tenants`
 *      refusal (a candidate tenant outside the approved test tenants — zero requests, zero writes)
 *   4  `--live` rolled back — a row changed under us (its guarded UPDATE returned no row); under
 *      --json the JSON document is still emitted, with `rolledBack` naming the row
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
 *   - Output discipline: ids, tenant ids, tenant slugs, verdicts, reason codes and state codes
 *     only. The raw free-text `state` is NOT printed unless you pass --show-unresolved-text, and
 *     then only for an UNRESOLVED row, JSON-escaped and cut to 40 characters. Never an address
 *     line, city, zip, coordinate, business name, email, the Google key or request body, or the
 *     connection URL. The listing SELECTs the street, city and full zip only when --google needs
 *     them to build a request; every mode also selects a 3-digit zip PREFIX for the ZIP
 *     cross-check, and no report or JSON document ever carries it.
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
 *   (d) live on prod — typed confirmation on a TTY, fresh backup named, and the write count your
 *       own dry-run printed ("rows to write") as --expect-rows:
 *         railway run --service postgres node apps/api/scripts/normalize-address-states.mjs --live \
 *           --backup-attested "<the fresh backup you just took>" --expect-rows <n>
 *       (more than 500 candidates? the run refuses before writing — read the report, then add
 *       --max-rows <count> deliberately)
 *   (e) optional, sends addresses to Google — only after (a) shows NEEDS_GOOGLE rows you want tried,
 *       ONE TENANT AT A TIME (--tenant-slug is required); test tenant first, then each client:
 *         GOOGLE_MAPS_API_KEY=<server key> railway run --service postgres \
 *           node apps/api/scripts/normalize-address-states.mjs --tenant-slug test \
 *           --only-test-tenants --dry-run --google --google-max 200
 *         GOOGLE_MAPS_API_KEY=<server key> railway run --service postgres \
 *           node apps/api/scripts/normalize-address-states.mjs --tenant-slug <client-slug> \
 *           --dry-run --google --google-max 200
 *       then --live with the same --tenant-slug and --google flags (the two runs are billed
 *       separately). Rows without a usable zip (NEEDS_ZIP) are never sent.
 */
import { createRequire } from "node:module";
import readline from "node:readline";
import { resolveDatabaseUrl } from "./lib/railway-db-url.mjs";
import guardLib from "./lib/live-target-guard.cjs";
import protectedSlugsLib from "./lib/protected-slugs.cjs";
import {
  applyUpdates,
  assertTestTenantTargets,
  buildUpdates,
  candidateSql,
  checkExpectRows,
  confirmationMatches,
  confirmationPhrase,
  DEFAULT_MAX_ROWS,
  GOOGLE_DEFAULT_MAX,
  GOOGLE_HARD_MAX,
  GoogleCapExceededError,
  MaxRowsExceededError,
  planRun,
  reportLine,
  summarize,
  TestTenantListingRefusedError,
} from "./lib/address-state-normalize.mjs";

const { protectedTenantIds } = guardLib;
const { loadProtectedSlugs } = protectedSlugsLib;

const HELP = `normalize-address-states.mjs — backfill CustomerAddress.stateCode from the free-text state

Usage: node apps/api/scripts/normalize-address-states.mjs
         [--dry-run | --live [--expect-rows <n>]] [--json] [--backup-attested "<text>"]
         [--tenant-slug <slug>] [--only-test-tenants [--confirm "<phrase>"]]
         [--max-rows <n>] [--show-unresolved-text]
         [--google --tenant-slug <slug> [--google-max <n>]]

Modes:
  (none)      read-only report: every candidate row (stateCode IS NULL) and a verdict
  --dry-run   the report plus the exact statements --live would execute (still read-only)
  --live      apply them in one transaction; requires --backup-attested AND a typed confirmation,
              AND --expect-rows <n> (unless --only-test-tenants --confirm is supplying it)
  --expect-rows <n>     the "rows to write" count your own --dry-run printed. A mismatch with the
                        count this run computed is exit 3, zero writes. --live only; required for
                        every --live except --only-test-tenants --confirm, where it is optional.
  --max-rows <n>        ceiling on candidate rows after scope (default ${DEFAULT_MAX_ROWS}). More candidates
                        is exit 2 before any Google request or write — never a silent truncation.
  --show-unresolved-text  also print the raw free-text state of UNRESOLVED rows (JSON-escaped, cut
                        to 40 characters). Off by default: reports show verdict + reason only.
  --json      print the report as JSON instead of prose
  --help      print this help and exit 0

Scope:
  --tenant-slug <slug>  only that tenant's rows. Roll out TEST TENANT FIRST (--tenant-slug test),
                        then one client tenant at a time. An unknown slug is exit 1. An unscoped
                        run also lists NULL-tenant rows (NULL_TENANT) — reported, never written.
                        REQUIRED with --google: Google runs one tenant at a time.

Verdicts (one line per row: id, tenantId, verdict, proposed code):
  RESOLVED_LOCAL_EXACT   normalizeUsState already resolves it (code or full name)
  RESOLVED_LOCAL_ALIAS   a GPO/AP abbreviation (Calif., N.Y.), or a state plus ONE trailing zip /
                         country token ("TX 77001", "Texas, USA")
  RESOLVED_GOOGLE        (--google) Google returned a COMPLETE, CONFIRMED US state (not inferred)
  UNRESOLVED:<reason>    listed, NEVER guessed; --live sets ONLY stateNeedsReview = true on it
    EMPTY  UNPARSEABLE  NEEDS_GOOGLE  NEEDS_ZIP  AMBIGUOUS_NEEDS_ZIP  GOOGLE_NO_MATCH
    GOOGLE_INCOMPLETE  GOOGLE_INFERRED  GOOGLE_ERROR  ZIP_CONFLICT  NULL_TENANT
  ZIP_CONFLICT: a resolved state contradicting the row's own 5-digit zip (bare "Washington" with a
  DC zip, "L.A." with a California zip) is listed, never written with a code.
  AMBIGUOUS_NEEDS_ZIP: the text is also a city's name ("Washington", "Kansas", "L.A.") and no valid
  civilian zip confirms the state — a blank, invalid or military (APO/FPO/DPO) zip leaves it unset.
  Fix the row's zip and re-run; --google is not involved (it is never sent).
  No fuzzy matching: "Tejas" and "Texs" are UNRESOLVED. Reports carry verdict + reason only; the
  raw state text appears ONLY with --show-unresolved-text — never an address line, city or zip.
  Tip: pipe the report through  grep UNRESOLVED  to see only the rows that need a decision.
  Confirmation phrase: NORMALIZE <n> ADDRESSES

Google Address Validation (opt-in; SENDS line1 + "<city>, <state> <zip>" TO GOOGLE):
  --google            REQUIRES --tenant-slug <slug> (exit 2 otherwise): one tenant at a time. For
                      UNPARSEABLE rows with a street line and a usable 5-digit zip only (no zip =
                      NEEDS_ZIP, never sent), in EVERY mode (report and --dry-run included); needs
                      GOOGLE_MAPS_API_KEY in the environment (exit 2 without it). The key needs the
                      "Address Validation API" enabled. Accepted only when the address is COMPLETE,
                      the region is US, and the state component is CONFIRMED and not inferred,
                      replaced or spell-corrected (else GOOGLE_INFERRED). Never printed.
  --google-max <n>    cap on requests (default ${GOOGLE_DEFAULT_MAX}, ceiling ${GOOGLE_HARD_MAX}). More rows than the cap
                      is exit 2 before any request or write — never a silent truncation.

Unattended writes (approved TEST tenants only):
  --only-test-tenants   require an approved test tenant (isTestTenant in
                        scripts/lib/test-tenants.cjs: test, e2e-routeflow, routeflow-demo, or a
                        slug matching qa-/e2e-/ux-audit-) for every candidate row, judged on the
                        candidate listing BEFORE anything is classified — so before any Google
                        request. ONE non-matching or unresolvable tenant refuses the whole batch —
                        exit 3, zero requests, zero writes; tenant ids and slugs are listed on
                        stderr (never address rows, also under --json). Enforced in every mode, so
                        --dry-run previews the same gate.
  --confirm "<phrase>"  supply the typed confirmation as a value instead of a TTY prompt. Allowed
                        ONLY with --only-test-tenants (exit 2 otherwise, before connecting), and
                        the phrase must equal exactly what the prompt would have asked for —
                        NORMALIZE <n> ADDRESSES, with <n> the row count this run computed. A
                        mismatch is exit 3 with zero writes. It does NOT relax --backup-attested,
                        and a client-tenant row keeps the TTY prompt as its only path.

DATABASE_URL resolution (Railway proxy vars win over DATABASE_URL) — see lib/railway-db-url.mjs.

Exit codes: 0 ok · 1 error · 2 argument refusal (before connecting; also --max-rows or
            --google-max exceeded) · 3 confirmation refused (or --expect-rows mismatch, or the
            --only-test-tenants refusal) · 4 rolled back (a row changed under us)
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
    // `null` = not supplied (the defaults / requirements are applied below).
    maxRows: null,
    expectRows: null,
    showUnresolvedText: false,
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
    else if (arg === "--max-rows") opts.maxRows = argv[++i] ?? "";
    else if (arg.startsWith("--max-rows=")) opts.maxRows = arg.slice("--max-rows=".length);
    else if (arg === "--expect-rows") opts.expectRows = argv[++i] ?? "";
    else if (arg.startsWith("--expect-rows=")) opts.expectRows = arg.slice("--expect-rows=".length);
    else if (arg === "--show-unresolved-text") opts.showUnresolvedText = true;
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
  // The row ceiling: a positive whole number, validated here so a typo can never become "no cap".
  if (opts.maxRows !== null && !/^[1-9]\d*$/.test(opts.maxRows)) {
    opts.errors.push(
      "--max-rows must be a positive whole number (default " + DEFAULT_MAX_ROWS + ")",
    );
  }
  // `--expect-rows` is the owner's own dry-run count, checked against this run's write count.
  if (opts.expectRows !== null) {
    if (!opts.live) {
      opts.errors.push("--expect-rows is only meaningful with --live");
    } else if (!/^(0|[1-9]\d*)$/.test(opts.expectRows)) {
      opts.errors.push(
        '--expect-rows must be a whole number (the "rows to write" your --dry-run printed)',
      );
    }
  }
  // An interactive `--live` (the TTY prompt path) must state the count the owner read on their
  // dry-run, so the typed phrase can never be produced from a different run's number. The
  // unattended `--only-test-tenants --confirm` path already binds the count through the phrase.
  if (opts.live && opts.confirm === null && opts.expectRows === null) {
    opts.errors.push(
      '--live requires --expect-rows <n> — the "rows to write" count your --dry-run printed ' +
        "(only the unattended --only-test-tenants --confirm path may omit it)",
    );
  }
  // Google runs ONE tenant at a time: the blast radius of a run that sends addresses to a third
  // party is a tenant the owner named, never the whole database.
  if (opts.google && opts.tenantSlug === null) {
    opts.errors.push(
      "--google requires --tenant-slug <slug> — Google runs one tenant at a time; nothing is sent " +
        "to Google for an unscoped run",
    );
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
const maxRows = opts.maxRows === null ? DEFAULT_MAX_ROWS : Number(opts.maxRows);
const expectRows = opts.expectRows === null ? null : Number(opts.expectRows);

let databaseUrl;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch (e) {
  console.error(`normalize-address-states: ${e.message}`);
  process.exit(1);
}

// Row 195: the protected-tenant list is loaded ONCE, before any connection, from the URL this
// script dials. Unset on a non-local target, or an invalid entry, refuses the run (exit 1).
let protectedSlugs;
try {
  protectedSlugs = loadProtectedSlugs(process.env, databaseUrl);
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
// Row 195: ids of every protected tenant (paying, Stripe-linked, env-listed); filled in main().
let protectedIds = new Set();

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
 * The ONE write path: the typed confirmation, then `applyUpdates`
 * (lib/address-state-normalize.mjs — a single transaction of guarded statements whose RETURNING is
 * checked row by row; exercised against a fake client in the script spec and against a real
 * Postgres in `normalize-address-states.db.spec.ts`). `applied` is filled in place (action ->
 * count). Returns `{ code, changed? }`: 0 applied, 3 refused (no TTY, wrong phrase),
 * 4 rolled back because a row no longer matched its guarded WHERE (`changed` names it).
 */
async function confirmAndApply(updates, phrase, applied) {
  // `--confirm "<phrase>"` is the OWNER's unattended confirmation, admissible only alongside
  // `--only-test-tenants` (enforced in parseArgs, before any connection) — so by the time it is
  // read here, every candidate tenant has already been proven approved. It takes precedence over
  // the jest-only NORMALIZE_CONFIRM_TOKEN, which stays what it was: a test hook, ignored loudly
  // outside a jest worker. Neither relaxes `--backup-attested`, and neither relaxes the phrase
  // check below — an unattended run still has to name the exact count.
  const injected = opts.confirm !== null ? opts.confirm : confirmTokenOverride();
  if (injected === undefined && !process.stdin.isTTY) {
    console.error(
      "normalize-address-states: refused — --live needs an interactive TTY for the typed " +
        "confirmation, and stdin is not one",
    );
    return { code: 3 };
  }
  const answer = injected ?? (await ask(`Type "${phrase}" to proceed: `));
  if (!confirmationMatches(answer, phrase)) {
    console.error("normalize-address-states: refused — confirmation text did not match");
    return { code: 3 };
  }

  say("\n  session read-only flag lifted for this repair; opening one transaction");
  const result = await applyUpdates(client, updates);
  if (result.code === 4) {
    console.error(
      `normalize-address-states: ROLLED BACK — ${result.changed.table} ${result.changed.id} was no ` +
        "longer an unnormalised row in the state the report showed (it changed under us); " +
        "nothing was written",
    );
    return { code: 4, changed: result.changed };
  }
  Object.assign(applied, result.applied);

  say("\n=== APPLIED ===");
  for (const [action, n] of Object.entries(applied)) say(`  ${action.padEnd(16)} ${n}`);
  say(`  ${"TOTAL".padEnd(16)} ${updates.length}\n`);
  return { code: 0 };
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

  // The order is planRun's (lib/address-state-normalize.mjs, tested there): the --only-test-tenants
  // gate on the candidate LISTING, then the --max-rows ceiling, then classification — the only step
  // that can call Google. A refusal in either of the first two happens with ZERO requests sent.
  let batch;
  try {
    batch = await planRun(listing.rows, {
      onlyTestTenants: opts.onlyTestTenants,
      maxRows,
      showUnresolvedText: opts.showUnresolvedText,
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
    // Tenant ids and slugs only — never a row — and on STDERR always, so `--json` cannot hide it.
    if (e instanceof TestTenantListingRefusedError) {
      console.error(e.message);
      return 3;
    }
    if (e instanceof MaxRowsExceededError || e instanceof GoogleCapExceededError) {
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

  // Row 195: a protected tenant's rows are never written (report and --dry-run show the same list
  // --live would run). Counted here; the tenant ids stay out of the output.
  const writesBeforeGuard = updates.length;
  updates = updates.filter((u) => !protectedIds.has(u.tenantId));
  if (updates.length < writesBeforeGuard) {
    console.error(
      `normalize-address-states: protected-tenant guard dropped ${writesBeforeGuard - updates.length} ` +
        "write(s) that belong to protected tenant(s); they are never written by this tool",
    );
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
            ...(batchError || extra.rolledBack ? { blocked: true } : {}),
          },
          ...(batchError ? { batchError } : {}),
          // exit 4: the transaction was rolled back because this row changed under us
          ...(extra.rolledBack ? { rolledBack: extra.rolledBack } : {}),
          updates: mode === "report" ? null : updates,
          applied: mode === "live" ? applied : null,
        },
        null,
        2,
      ),
    );
  };

  // `--only-test-tenants` — second line of defence. The real gate already ran on the candidate
  // LISTING inside planRun, before any classification or Google request; here the WRITE LIST is
  // re-checked against the same policy, in every mode, so a bug upstream can never widen what is
  // written. It cannot fire after the listing gate passed; if it ever does it is stderr only.
  if (opts.onlyTestTenants && !batchError) {
    try {
      assertTestTenantTargets(updates, slugById);
    } catch (e) {
      console.error(e.message);
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
    // The owner's own dry-run count against this run's computed one — before "nothing to do" and
    // before any prompt, so a stale or wrong-scope run is refused (exit 3, zero writes) however
    // the confirmation would have been supplied.
    const expectError = checkExpectRows(expectRows, updates.length);
    if (expectError) {
      console.error(expectError);
      return 3;
    }
    if (updates.length === 0) {
      say("=== LIVE — no rows to write; nothing to do ===\n");
    } else {
      const outcome = await confirmAndApply(updates, confirmationPhrase(updates.length), applied);
      if (outcome.code === 4) emitJson({ rolledBack: outcome.changed });
      if (outcome.code !== 0) return outcome.code;
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

  // Row 195: SELECT-only (the session is read-only here); resolved before any report line prints.
  protectedIds = new Set(await protectedTenantIds(client, protectedSlugs));

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
