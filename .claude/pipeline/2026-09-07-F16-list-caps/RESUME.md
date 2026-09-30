# RESUME — F16 list caps (bug-pipeline, mode bugfix, scale major)

Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`, branch `fix/F16-list-caps-numbering` off master 19a419ba.
Artifacts in this dir: cause-brief.md (S1) · refutation.md (S2) · cause-ruling.md (S3, design of record) · bug-test-plan.md (S4) · build-plan.md (S5) · pipeline-args.json.
Engine: `local-assets/tooling/pipeline-2026-09-06-6d31a370.js` (staged copy). Launch = Workflow({ scriptPath: <engine>, args: <pipeline-args.json as an OBJECT> }).
runId: wf_ca136d4b-a99 (task w1qvb1hmp; transcript C:/Users/nakram/.claude/projects/C--ClaudeCode-routeflow/14338d9c-5c59-4c2e-a365-d1c3f9a77712/subagents/workflows/wf_ca136d4b-a99) · startedAt: 2026-09-07T09:31:00Z (args carry 10:40Z — a clock slip; use 09:31Z for the ledger) · args ≈ 5.1 KB minified (above the ~4.5 KB record cap → NEVER resumeFromRunId; recover by a light loop) · Never resume a run whose stored args were truncated (L-085) — start a light loop from the tree instead.
Landing recipe: commit (trailer `Bookkeeping-Follow-Up: pending`) → merge origin/master → regen api+mobile+pricing reports → hook push → draft PR → window (watchdog → public → ready → CI green → squash → wait BOTH rows SUCCESS → private) → PDC → E2E (spec 37) → docs follow-up (prove/discharge; F16 stays open for B100) → retire branch with proof.
B100 = separate run (`cause-ruling.md` §9) — owner ack before the prod migration.

## Round 3 (lead-designed light loop) — launched 2026-09-07 ≈ 13:35Z

Engine wf_ca136d4b-a99 ended clean:false (result.json persisted; ledger + RUN-LOG appended; 11 final-pass findings). Design `fix-round-3.md` (M1 lifetime sums via DB aggregate + shared type; M2 issued e2e fixture; M3 truncation notes; m4 export productId; m5 overdue-status disjunct; m7 DRAFT count scope; m8 invoices-tab bar; m9 Object.hasOwn allowlists; m6/m12 accept + file; manual sibling sweep). Workflow wf_54afc268-4e4 (task wg58ahqi2). After land: commit → merge master → regen reports (api, mobile, pricing) → hook push → draft PR → window (SUCCESS-only private flip) → PDC → E2E (spec 37 `list-caps`) → docs follow-up (prove 7 rows; B12/B80/B110 T2 legs from the run; file: KPI SQL aggregate perf row, sibling-sweep defects, `limit:999` siblings, import.service setHours; F16 stays open for B100 → run `F16b` with the owner's migration ack).

## Round 4 (lead-designed) — launched 2026-09-07 ≈ 14:15Z

Round 3 (wf_54afc268-4e4): M1–m9 all FIXED; final gates green api 4326 / web 179 / mobile 1418; sibling sweep 18 hits → 7 defects outside the PR (FILE in the follow-up: estimates/vendor-bills/credit-notes `limit:999` KPI pages, import.service.ts:1180 setHours + :1344 orphanCount, duplicate-match.service.ts:144 + :354). Round 4 design `fix-round-4.md` (H1 Profile-tab Orders tile → meta.total; H2 roundMoney on statement figures; H3 exportPayments pin; H4 orphaned note; H5 finances six-credit slice labelled). Workflow wf_5a0b5ce3-cfa (task wsghs2qg6). On land → the landing recipe above.
