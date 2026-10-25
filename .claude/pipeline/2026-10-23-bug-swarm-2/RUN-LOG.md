# 2026-10-23-bug-swarm-2 · /bug-swarm v0 run 2 (counter) · mm-landing (Mac mini)

Base e6acb9955 · 06:13Z → 06:54Z (40 min wall) · PR #3633 · SKILL v0 run unchanged (lead: no knob
changes until run 2/3 evidence)

**Scope.** Rows 301, 296 and 300 (invoices/new only), held from run 1 until #3615 merged. Triage found no new
LOW counter rows on the open board. Row 296 was split: touch targets fixed. The Scan-barcode name already
existed (BarcodeScannerButton title default). The keyboard check, Tab order and B6 copy remain on the row.

**Cost (true telemetry).** $15.14 = subagents $4.55 + orchestrator session delta $10.59. That delta includes
interleaved non-run work (CI timeout PR #3631, W-699/W-700 notes, the draft cleanup), so it is an upper bound.
**$5.05 per fixed bug** ($1.52/bug subagents only). Run 1: $3.42/bug ($1.29 subagents). Per-bug cost rose
because the fixed overhead (triage, pack, review, captures) was spread over 3 bugs, not 6. Haiku triage
cost is null again (no haiku-5-5 price in session-usage).

**Quality.** First-pass gate GREEN. The only red was web tsc on a STALE `packages/*/dist` cloned from the
run-1 worktree, a setup defect fixed by `turbo run build --filter=./packages/*` in the gate. Review: Opus PASS,
0 MUSTs (it traced settings.taxRate as a percent, so the label matches the charged rate). SPEC-EDIT 0.
Captures 390/768/1440: all controls ≥ 44 below lg and unchanged desktop sizes.

**Evidence for the run-1 knob candidates.**
- *Fold triage into the context pack:* 2 of 2 runs. The pack re-verified liveness for every row that
  triage had already checked (run 1: it overturned 8; run 2: it agreed on 3/3, so the triage pass was
  pure duplicate). One more run meets the 3-run rule.
- *Schema-nullability gate line:* no new evidence (no field newly sent as null in run 2).

**New this run.** The UI-capture phase cost $1.81 (12% of the run, 6.5 M tokens, 26 min). It confirmed the
fixes but found no defect. Side effect: opening Create Order auto-saves server drafts, which left 3 empty drafts on
`test` that overlay the counter at 390 for the next lane. Deleted them via the API on the Mac mini lane's
request. Rule: a capture agent deletes the drafts it created before it reports.

**Wasted / slow.** The orchestrator was again the largest share (70%). v0's hand orchestration is the cost,
and the v1 Workflow script (W-653) is now unblocked by its 2-row rule. Builder sed slips recurred
(macOS `sed -i`), and the next commit ran before the suite. Briefs now say Edit tool + `&&` chains.

**Lesson candidates.** Clone `node_modules` with APFS `cp -c` but REBUILD `packages/*/dist` per worktree
(dist ties to the base sha). A touch-target floor is pinned per component, so a counter-path tap-target list
(L-305 style) would stop the 296/299 class recurring: packages/ui Button md is 34px.
