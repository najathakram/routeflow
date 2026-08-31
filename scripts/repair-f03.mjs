/**
 * F03 repair lane — `scripts/repair-f03.mjs`.
 *
 * ⚠️ CONTRACT STUB. This file currently declares the module's exported surface and
 * NOTHING ELSE — no detection, no repair, no DB access, no logging. It exists so that
 * `apps/api/src/scripts/repair-f03.spec.ts` can import it and fail on its ASSERTIONS
 * (the behavior isn't built yet) instead of dying on ERR_MODULE_NOT_FOUND before a
 * single expectation is evaluated. The F03 build stage (build-plan P5) replaces every
 * body below with the real implementation; the spec is the contract it must satisfy.
 *
 * Requirement R10 (`.claude/pipeline/2026-08-31-f03-payment-truth/spec.md`), safety
 * shape copied from `scripts/repair-integrity.mjs`:
 *   - read-only dry run by default; `--execute` requires `--i-have-a-fresh-backup`;
 *   - per-row transaction with an in-tx re-read compared against the dry-run snapshot
 *     (a row that drifted is SKIPPED, never overwritten, and never aborts the batch);
 *   - JSONL log written under `local-assets/` (gitignored), path returned to the caller;
 *   - refuses a non-production DATABASE_URL unless `--force-nonprod` is passed;
 *   - the B81 damage class (a reclassified CREDIT_NOTE/ADVANCE payment method) is
 *     REPORTED as unrepairable and never modified — the evidence that would prove the
 *     damage is the very field that was overwritten.
 *
 * `assertTestTenant` deliberately does NOT apply here: this script repairs live rows by
 * design (owner's repair-as-we-go decision, build-plan P5).
 */

/**
 * @param {string[]} argv
 * @returns {{ execute: boolean, backupAttested: boolean, forceNonprod: boolean }}
 */
export function parseFlags(argv) {
  const args = Array.isArray(argv) ? argv : [];
  return {
    execute: args.includes("--execute"),
    backupAttested: args.includes("--i-have-a-fresh-backup"),
    forceNonprod: args.includes("--force-nonprod"),
  };
}

/**
 * Entry guard: throw when `databaseUrl` does not point at the production database and
 * the operator has not explicitly opted in with `--force-nonprod`.
 *
 * STUB: returns undefined (never throws) — the "must refuse" assertion is red.
 *
 * @param {string} _databaseUrl
 * @param {{ forceNonprod?: boolean }} _flags
 * @returns {void}
 */
export function assertRepairTarget(_databaseUrl, _flags) {
  return undefined;
}

/**
 * READ-ONLY. Inspects `store` and returns the per-row before→after proposals for the
 * four mechanically repairable damage classes, plus the classes that are documented as
 * unrepairable. Must never call a store mutator.
 *
 * STUB: returns empty collections — every proposal assertion is red.
 *
 * @param {unknown} _store
 * @returns {Promise<{ proposals: Array<{ class: string, id: string, before: unknown, after: unknown }>, unrepairable: Array<{ ticket: string, status: string }> }>}
 */
export async function identifyRepairs(_store) {
  return { proposals: [], unrepairable: [] };
}

/**
 * Applies `proposals` through `store`, one transaction per row, re-reading each row
 * inside the transaction and skipping any that drifted since `identifyRepairs` saw it.
 * Must REJECT unless both `flags.execute` and `flags.backupAttested` are true.
 *
 * STUB: resolves unconditionally with empty results and no log path — the applied /
 * skipped / logPath assertions are red, and the guard assertion is red because nothing
 * is refused yet. (It must not throw here: a stub that threw would make the guard test
 * pass for the wrong reason.)
 *
 * @param {unknown} _store
 * @param {unknown[]} _proposals
 * @param {{ execute?: boolean, backupAttested?: boolean }} _flags
 * @returns {Promise<{ applied: Array<{ id: string }>, skipped: Array<{ id: string }>, logPath?: string }>}
 */
export async function applyRepairs(_store, _proposals, _flags) {
  return { applied: [], skipped: [] };
}
