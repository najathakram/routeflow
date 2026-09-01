# F10 — pipeline resume card (write-down survives a killed session)

**Why this file exists:** the dev-pipeline run for F10 completed with **14 agents dead on an
Anthropic session limit** (message: "You've hit your session limit · resets 1:20pm
America/Chicago", 2026-09-01 ~11:02). The dead phases are the ones that decide whether this
change is *reviewed*, so the run MUST be resumed — not restarted, and not waved through on
green gates.

## Resume command

```
Workflow({
  scriptPath: "C:\\Users\\nakram\\.claude\\skills\\dev-pipeline\\pipeline.js",
  resumeFromRunId: "wf_7011dc41-445",
  args: { ...the same args object as the original call... }
})
```

- **runId:** `wf_7011dc41-445`
- **scriptPath:** `C:\Users\nakram\.claude\skills\dev-pipeline\pipeline.js`
- **args:** identical to the original invocation (args are NOT stored by the runtime — they
  must be re-passed). The full args object is recorded in the original Workflow tool result
  and reproduced from `build-plan.md` + `test-plan.md` + `spec.md`, whose paths are:
  - planPath `…/2026-09-01-F10-reopen-stop-state-guards/build-plan.md`
  - discoveryPath `…/discovery.md` · specPath `…/spec.md` · testPlanPath `…/test-plan.md`
  - scale `major`, workdir `C:\ClaudeCode\routeflow\.claude\worktrees\rf-F10`
  - formatCommand `npx prettier --write "apps/api/src/routes/**/*.ts"`
  - verifyCommands.perRound `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`
  - verifyCommands.final `cd apps/api && npx jest src/routes --silent`,
    `cd apps/api && npx eslint src/routes`
  - testPackages `TP-guards`, packages `WP-dto` → `WP-service` → `WP-controller`,
    redGate `cd apps/api && npx jest src/routes/routes.service.stop-state-guards.spec.ts --silent`
    expect `fail`, plus the 6 mutationProbe targets.
- **Transcript dir:** `C:\Users\nakram\.claude\projects\C--ClaudeCode-routeflow\531c0f72-4a25-494c-a08a-40ce377ff584\subagents\workflows\wf_7011dc41-445`
  (`journal.jsonl` = one result line per completed agent — read it before diagnosing anything).

Unchanged agent calls replay from cache, so the 65 agents that completed are NOT re-paid for;
only the dead phases re-run.

## What completed (from the run's own result, not from the diff)

- Baseline gate **pass** (all 3 commands valid, `badCommands: []`), artifact grounding
  **0 findings**, context manifest complete (5 HIGH-risk files, 4 LOW).
- Test authoring: `TP-guards` done.
- **Red gate: `properlyRed: true`, 1 attempt** — all tests failed on assertions, audited
  non-vacuous against source.
- Implementation: `WP-dto`, `WP-service`, `WP-controller` all done.
- Review lenses ran; **17 raw findings** (6 blocker / 4 major / 7 minor).
- Partial fixing landed before the limit: `podHistory` write added, `prisma-mock.ts` gained
  `auditLog`, R4 reworked to non-absorbing CANCELLED + driver un-cancel refusal.

## What DIED and must re-run (this is the whole point)

`regate:r1`, `recheck:r1`, `regate:r2`, `recheck:r2`, `final-gate`, `final-pass`, and every
`fix:*` agent (spec file, dto, controller, prisma-mock, service, implementation, mutation,
gate). **`mutationProbe` and `finalPass` therefore have NO result** — the six probe targets
were never exercised and the Fable adversarial final pass never read the diff.

## Do not confuse green gates with a reviewed change

Gates re-run by hand at 2026-09-01 11:03 on the WIP tree, all green: `tsc` clean,
`npx jest src/routes` **135/135 in 6 suites**, `eslint src/routes` 0 errors (300 pre-existing
warnings), prettier clean. That is evidence about the checks that ran, **not** about the
review that did not. F10 is money-adjacent (B54 gates reopen on live `InvoicePayment` money;
B55 removes a stock write), and the campaign's record is that the Fable final pass is the only
thing that caught a real money defect in three consecutive batches. **F10 does not merge until
the final pass has run and its findings are resolved** (fleet decision, 2026-09-01).

## Close-out ordering (violating this corrupts shared files)

1. **Final pass must run and its findings be resolved.** F10 does NOT merge before then
   (fleet decision 2026-09-01). Green gates are not a substitute — see the section above.
2. **Rebase onto post-merge master BEFORE writing any lessons entry.** `.claude/lessons/`
   does not exist on this branch's base (`df1ef9a3` predates #571), and entry ids are
   allocated from `_meta.json.nextId` **in the merged tree**. A live collision already
   happened: #583 filed `L-029 · tooling` and #588 filed `L-029 · domain` because both read
   `nextId: 29` from the same merge base. Re-deriving from a stale tree is not enough — only
   serialization is. So: rebase → read `nextId` from the rebased tree → then write. Verify any
   `[[L-0xx]]` cross-reference resolves in that same tree.
3. F10 owes **two entries**: (a) the artifact-freshness rule — a generated artifact is
   evidence only when you can name the tool and the run that produced it (covers both the
   turbo-cache/scoped-probe case and the npm-version lockfile-drift case); (b) grep the schema
   for a column addressed to your batch before designing storage (the `podHistory` miss —
   an enablement batch pre-adds columns and the schema comment IS the spec).
4. **B209** goes in the bug register (`local-assets/docs/routeflow-bug-register.html`,
   machine-local, gitignored): `deleteRoute`'s R3 comment asserts "scheduled/cancelled runs,
   **which recorded nothing**", which is false after a post-delivery cancellation — the guard
   at `routes.service.ts:554` refuses only IN_PROGRESS/COMPLETED, so a CANCELLED run passes
   and the tx then unpins orders (`:562-566`), detaches delivery mutations and deletes the run
   stops, destroying POD evidence. Verified at source 2026-09-01. F10 recorded it and
   deliberately did not fix it (F11 or a later routes batch owns it).
5. Register republish is **LAST** in the session and needs a genuine full `Read` of the
   fetched copy first (owner mandate).
6. Ledger flips (`.claude/campaign/status/F10.jsonl`) need a **genuinely executed** full test
   run first — the six scoped mutation probes leave `.campaign/runs/api.json` holding only
   probe tests, and a turbo cache replay will NOT overwrite that (repo-root ledger files are
   not hashed inputs: `globalDependencies` is lockfile + package manifests only, and the test
   task's `inputs` are `$TURBO_DEFAULT$`). Force execution, then assert the artifact's mtime
   post-dates the rebase, then read `campaign-check`.

## Known-open review findings at the time of the limit

Blocker-class was already fixed (the `auditLog` mock gap). Still open / unverified:

- **MAJOR** `getStopPod` has no driver-ownership binding, so R8's protection is bypassable
  through `GET /route-runs/:id/stops/:stopId/pod`; the R8 in-code comment claims otherwise and
  currently over-claims.
  **DECIDED 2026-09-01, not contingent on the final pass: the comment gets fixed either way.**
  If the final pass confirms the gap, fix the code *and* the comment; if it does not, still
  narrow the comment to what the code actually guarantees. A comment asserting more than the
  code enforces is worse than no comment — it stops the next reader from checking, converting
  a gap into an *invisible* gap. This batch has now met that exact failure shape three times
  in one file: this comment, `deleteRoute`'s "scheduled/cancelled runs, which recorded nothing"
  premise (filed as B209), and `deleteRun`'s reassuring "cancel it instead of deleting"
  message. Nothing merges asserting something already suspected untrue.
- **MINOR** T2 may still be a behavioural duplicate of T1 (the test-plan was rewritten to make
  each OR arm separately falsifiable — verify the spec file actually implements that).
- **MINOR** T15 asserts only part of R6's meta payload; Date→ISO conversions untested.
- **MINOR** R7's allowed case (signature onto a COMPLETED stop that has none) has no test.
- **MINOR** the new B54 guard reuses the legacy guard's message verbatim and logs nothing, so
  neither operator nor logs can tell which guard fired.
