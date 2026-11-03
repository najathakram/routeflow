# Api landing 2026-11-03, train al (merge commit `1f6f32a341`, range `d833210811..1f6f32a341`; train PR #4168, head `769749d4f8`)

Paths under `apps/api/` unless they start with `apps/web/`. Four members: #4165 `b27c148a9c` (api), #4162 `242e14a3a5` (docs only), #4167 `49a3f8cc83` (web), #4160 `b4617b1533` (web). **No migration** (the key row stores `{ requestHash, response }`), no cron, no plan flag or addon gate, no new env var, no route. Web side: `web/landing-2026-11-03-al.md`. Tests are named from the diff and the PR text and were not run for this note.

## #4165 `b27c148a9c` stop completion is idempotent (SA-1098 PR-1, W-908/W-909; closes B1034, B870; T1)

Rule: a retry of a stop completion with the same key and the same body gets the first answer back and writes nothing; a changed request under the same key gets 409 `IDEMPOTENCY_KEY_CONFLICT` (reason `PAYMENT_MISMATCH`).

- `routes/stop-completion-key.ts` (new): the key lookup runs right after the ownership check, ahead of the run and stop checks, RF-006 and the proof upload, for both `completeStop` and `completeWithPayment`. The request hash is the payment invoice, cents and upper-cased method plus each line's id, type, quantity and product (sorted by line); notes, proof and gate evidence stay out. The key row is the completion's last write inside the transaction, through `common/idempotency.service.ts`.
- `routes/route-idempotency.ts` and its spec are gone (one model); `routes/routes.service.ts` calls the new code (3121 to 3112 lines, baseline 3103, cap 3128). B870: the replay and a fresh call share one declared shape, so `check-types.spec-baseline.json` drops `routes.service.spec.ts`'s last row.
- Tests: `routes/stop-completion-key.spec.ts` (pin), `routes/stop-completion-key.db.spec.ts` (DB lane, `qa-sa1098-*` tenants, both paths), `common/idempotency.service.spec.ts`, `routes/routes.service.spec.ts`, `routes.realtime-wiring.spec.ts`, `routes.skipped-stop-completion.spec.ts`.

## #4162, #4167, #4160

- #4162 `242e14a3a5`: docs only (landing notes for train aj). #4167, #4160: no api source; see `web/landing-2026-11-03-al.md`.
