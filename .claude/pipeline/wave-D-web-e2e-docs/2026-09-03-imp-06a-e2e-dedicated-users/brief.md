# Brief — PR-8 · Item 6a: dedicated users for auth-state mutators; un-quarantine 31/32

Branch `test/imp-06a-e2e-dedicated-users` (after PR-7). Commit type `test:`. Scale: **major**
(auth state; pipeline with the security lens). Depends on PR-7's local lane for acceptance.

## Why

Two F14 projects are commented out of `apps/web/playwright.config.ts` (~:420-462):
`impersonation-signout` (spec 31) and `active-sessions` (spec 32). Spec 32 revokes `rows[0]` of
`/auth/sessions` (createdAt DESC) — which is `operator.json`'s session whenever `setup` logged in
after it — so every phase-2 project 401'd on its first refresh (post-deploy run 33612887226).
Root cause per L-050: a spec that mutates shared auth state needs its own user, not a schedule.
The sweep of all 27 specs found `/auth/sessions`/`revoke` only in 31 and 32; `logout` appears in
01, 02, 03, 04, 05, 07 and `password` in 07 (39 hits) and 04 — those must be read to confirm they
do not revoke the shared operator's refresh token or change the shared password.

## Requirements

| R#  | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                    | Verified by |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| R1  | `apps/api/scripts/e2e-seed.js`: two new fixed users on `e2e-routeflow`, idempotent (find-then-create, same pattern as the existing three): `e2e_sessions_op` / `Sessions1!` (OPERATOR — for spec 32) and `e2e_impersonated_admin` / `Impersonated1!` (TENANT_ADMIN — for spec 31's impersonation target, so `e2e_admin` stays a shared seed identity). `helpers/constants.ts` `CREDENTIALS` gains both.                                        | T1, A1      |
| R2  | Spec 32 logs in as `e2e_sessions_op` (its own fresh login, **no storageState** — by design) and only ever revokes sessions of that user; spec 31 impersonates `e2e_impersonated_admin`. Neither touches `admin`/`operator.json`.                                                                                                                                                                                                               | T2, A1      |
| R3  | The two project blocks are un-commented (`impersonation-signout`, `active-sessions`); spec 31 keeps its documented `test.skip` when `PLAYWRIGHT_SA_USERNAME`/`PASSWORD` are unset (L-041: a skip is not a discharge — the PR states whether the repo secrets exist, from `gh secret list`, and therefore whether 31 runs in CI).                                                                                                               | A2          |
| R4  | Audit of the other `logout`/`password` specs (01, 02, 03, 04, 05, 07): for each, the PR description states what the calls do (UI logout of the spec's own context vs `POST /auth/logout` revoking a shared refresh token; password change on the shared operator vs a spec-created user). Any spec found to mutate the shared operator's server-side auth state gets its own seeded user in this PR (same pattern) — the list is the evidence. | review      |
| R5  | `playwright.config.ts` quarantine comment replaced by a 4-line note: which specs own dedicated users and why (L-050); `docs/IMPROVEMENTS.md` item 6 → `shipped (PR-7 + PR-8)`; code-map `web.md`; lessons: `updatedAt` (L-050 already covers this) unless R4 finds a surprise.                                                                                                                                                                 | review      |

## Tests

- **T1** `apps/api/scripts/__tests__`… — no; the seed is a script. Proof: run the seed twice
  against the compose DB (`local:seed`-style URL) → second run creates nothing (idempotent) and
  `SELECT username FROM "User" WHERE username IN (...)` shows both users under the
  `e2e-routeflow` tenant (agent pastes the query output).
- **T2** static spec `apps/web/e2e/helpers/no-shared-auth-mutation.spec.ts`? — not a Playwright
  test; make it a small Node check `apps/web/e2e/scripts/check-shared-auth.mjs` run by `npm run
verify`? **No** — keep the gate light: an Opus review assertion + A1. (No unit test — the
  behaviour is only observable in the lane.)

## Acceptance

- A1: `npm run local:e2e:all` (PR-7) three consecutive runs → `active-sessions` green ×3, the
  previously collided `auth-password` (AP-06) green ×3, no other project's status changes vs the
  PR-7 baseline; `impersonation-signout` green ×3 when SA creds are set locally (else "skipped —
  SA creds unset", stated).
- A2: after merge, the deploy-triggered prod E2E run: `active-sessions` green; `impersonation-
signout` per R3.

## Files

`apps/api/scripts/e2e-seed.js`; `apps/web/e2e/helpers/constants.ts`; `apps/web/e2e/31-impersonation-signout.spec.ts`;
`apps/web/e2e/32-active-sessions.spec.ts`; `apps/web/playwright.config.ts`; any spec R4 flags;
bookkeeping.
