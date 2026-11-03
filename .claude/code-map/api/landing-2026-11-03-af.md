# Api landing 2026-11-03, train af (merge commit `d6d5c56cb1`, range `6e9dae10eb..d6d5c56cb1`; train PR #4146, train head `73caa26085`)

Paths under `apps/api/` unless they start with `packages/`. Three members, each merged into the train by its own merge commit: #4144 `d49f6787f6` (web + mobile manifest, no api path), #4140 `100cdf13bd` (scripts + pricing + api specs), #4145 `17191e57cb` (docs only: bookkeeping for Train ae and #4143). **No migration** (no `apps/api/prisma/` path), no cron, no plan flag or addon gate, no new env var, no route. Web side: `web/landing-2026-11-03-af.md`. Tests are named from the diff and the PR text and were not run for this note.

## #4140 `100cdf13bd` read-only corrected-units sheet (SA-1088, SA-790 §1, SA-968 §3, row 138, OQ-19)

Rule: for ONE tenant, list every regulated-ledger line on the box axis with the "Unit Basis Qty" the ledger carries now, the corrected figure per the B681 classifier, and the difference, per period, beside the period's filed snapshot. It writes nothing; the ledger does not change. Running it against a live tenant is not part of the PR: that needs the exact `railway run` command posted, the owner's yes for that call, the live-tenant override and the backup step.

- `packages/pricing/src/b681-correction.ts` (new, + `index.ts` export): the classifier ported from the saved branch onto master's one axis rule (no copy of `legacy-box-axis.ts`, no apply script). Specs: `b681-correction.spec.ts` (passes unchanged on master, QD-1), `b681-correction.rows.spec.ts`.
- `scripts/lib/b681-ledger-query.mjs` (read half only) with its self-test; `scripts/lib/report-corrected-units-sheet.mjs` with its self-test.
- `scripts/report-corrected-units-sheet.mjs`: READ ONLY plus ROLLBACK; `--apply`, `--fix` and `--repair` are refused with exit 2; the live-target host guard (exit 64 / 65); one tenant per run (a non-test slug needs `--live-tenant-override`); no customer or product names; the CSV is written only under `local-assets/handoff/`. The footer compares each period with the newest LOCKED filing, else the newest GENERATED; a count other than 49 prints loudly.
- Tests: `src/scripts/report-corrected-units-sheet.spec.ts` (source scan: no write verb, QD-3), `report-corrected-units-sheet-script.spec.ts` (QD-2), `report-corrected-units-sheet.db.spec.ts` (QD-2, QD-4..QD-7, DB lane), `src/common/scripts-live-target-guard.spec.ts`.

## #4144, #4145

- #4144: no api source; see `web/landing-2026-11-03-af.md`. #4145 `17191e57cb`: docs only (web landing note for train ae and #4143).
