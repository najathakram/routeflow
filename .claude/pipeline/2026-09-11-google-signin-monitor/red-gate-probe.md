# Red-gate mutation probe — 2026-09-11-google-signin-monitor

Run record (not a report). Answers the red-gate blocker: the self-test first went red against a
signature-only stub, so most oracles failed on `got undefined` and were not proven to
_discriminate_. This probe mutates the real `scripts/lib/google-signin-check.mjs` one line at a
time and confirms the specific named oracle turns red.

- Probe run: 2026-09-11, worktree `.claude/worktrees/rf-smoke`, branch `feat/google-signin-monitor`.
- Command per row: apply the single-line mutation → `node scripts/lib/google-signin-check.self-test.mjs`
  → revert (the driver asserts the file is byte-identical to the original after each revert).
- Baseline (unmutated): exit **0**, 0 FAIL lines. Restored after all five: exit **0**, 0 FAIL lines.

| #   | Mutation (one line, reverted after)                                                               | Expected red                        | Observed                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| M-1 | `probeDoor`: `reason: marker` → `reason: marker === "deleted_client" ? "invalid_client" : marker` | T2 `deleted_client` reason oracles  | exit 1 — `FAIL T2/R2 deleted_client: platform door reason`, `FAIL T2/R2 deleted_client: tenant door reason` (only these two) |
| M-2 | `resolveRequired`: `if (envValue === "0") return false` → `return true`                           | T3 `SMOKE_GOOGLE_REQUIRED=0` oracle | exit 1 — `FAIL T3/R3: SMOKE_GOOGLE_REQUIRED=0 silences a non-local host` (only)                                              |
| M-3 | wrong_host branch: `status: "fail"` → `status: "ok"`                                              | T4 `ok === false`                   | exit 1 — `FAIL T4/R2: ok === false on host mismatch` (only)                                                                  |
| M-4 | `checkApexDns`: `{ ok: true, status: "warn", reason }` → `status: "fail"`                         | T6 warn-vs-fail                     | exit 1 — `FAIL T6/R5: ENOTFOUND + not required -> status warn` (only)                                                        |
| M-5 | 503 branch: drop the `required` ternary, always `{ status: "skipped" }`                           | T3 required-vs-skipped              | exit 1 — `FAIL T3/R3: required=true -> ok === false` (only)                                                                  |

Each mutation produced a **minimal** red set — the reason enum, the required default, the
wrong_host status, the apex warn tier and the not_configured required/skipped split are each
pinned by an oracle that fails when that specific behavior breaks, not by a blanket
`got undefined`.

## Self-test changes that landed with this probe

- **T7 split** — the two compound booleans (`imports the module AND hard-codes no
accounts.google.com`, for `post-deploy-check.mjs` and `smoke.mjs`) became four checks, one
  clause each, so a red says which clause broke and an implementation that legitimately passes
  `expectedHost` explicitly fails only the hard-code guard.
- **T5 ceiling 1500 ms → 5000 ms** (floor kept at 300 ms, budget still 400 ms) — L-066: a tight
  wall-clock bound is green on CI and red on a loaded host. The ≥ 300 ms floor is what proves the
  timeout actually fires; the ceiling only proves the shared AbortController budget (R4) exists.

## Not covered by this probe

T8's oracles are literal source greps (`process.exit(1)`, `assertTestTenant`, `17 */6 * * *`) —
structural by plan design (build-plan.md TP2). They prove the text is present, not that the
monitor exits non-zero or guards the tenant at runtime; manual token **M1** covers that.
