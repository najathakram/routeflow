# Handoff — 2026-09-15 · B440/B455/B456 (revenue = accrual net sales) — READY TO LAUNCH, HOLDING

**Status: planning complete (S0-S5 + a tax-exclusion amendment), S6 NOT launched.**
**Owner order (via routeflow-c4): stay idle. Do NOT start S6 until "LAUNCH B440" is sent.**

- Branch `fix/B440-revenue-accrual` @ `7b8bf085` (fast-forwarded onto origin/master), worktree
  `C:\ClaudeCode\routeflow\.claude\worktrees\rf-B440`. Tree clean except hook-generated
  `.claude/pipeline/agent-log.jsonl`/`approach-rotation.json` (benign, regenerated every prompt —
  re-check before actually launching).
- Artifacts: `.claude/pipeline/2026-09-15-b440-revenue-accrual/{cause-brief,cause-ruling,
  bug-test-plan,build-plan}.md` — all four written, cross-referenced, and amended in sync for the
  tax-exclusion ruling below. `build-plan.md`'s `## Pipeline args` block (bottom of file) IS the
  literal object to pass to the Workflow tool at launch — nothing else needs assembling.

## Launch readiness

- **Engine:** `~/.claude/skills/dev-pipeline/pipeline.js`. **Verify sha256 at launch time** —
  `02d58b813fcbf6a60197cf5773f7b77c513ed67a117ed09cbae4ab3e42044b87`, 224,133 B (c4's "ENGINE
  FIXED" sha, supersedes an earlier b71f6c8e... one that had a since-patched E9/E10 defect —
  workdir leak reading the main checkout instead of the worktree). Re-verify fresh; don't trust
  this note if time has passed — another defect could have been found and fixed again since.
- **Launch mechanics** (dev-pipeline SKILL.md S7, already fact-checked against `pipeline.js`
  source during S5 — see build-plan.md's "Engine-mechanics findings" section for 3 places
  SKILL.md's own prose is stale): stage `pipeline.js` to this repo's gitignored
  `local-assets/tooling/pipeline-<version>.js` (not yet done), pass `scriptsDir` as the REAL
  `~/.claude/skills/dev-pipeline/scripts` path (never a sibling of the staged copy), write
  `startedAt` as the real launch-time ISO timestamp (build-plan.md's args block leaves this as a
  literal placeholder), write the RESUME.md card at launch before calling Workflow.
- **Host requirement:** S6 needs a shared local dev-host slot. Last known queue (may be stale):
  minter → Lite L2 → this session. Say "need HOST" to c4 and confirm current position before
  actually launching — don't assume the queue hasn't moved.
- **Given the token/cost limit, launch may use a leaner method than the full Workflow engine**
  (e.g. hand-executing the plan via individual Agent calls, as S0-S5 were done). If so: **18 of the
  19 tasks are risk:HIGH** (money/revenue-recognition code) — route those to careful/high-effort
  execution and review regardless of method. Only **DOCS1** (code-map/lessons/registry bookkeeping)
  is routine/LOW risk.

## Task graph (19 tasks — full detail in build-plan.md's `### <id>` sections)

`RC1`(root-cause, HIGH) → `RT1`/`RT2`/`RT3`(repro-test, HIGH; RT3 depends on RT2, shared spec file)
→ `FIX1`(HIGH, `common/invoiced-sales.ts` helper) → `FIX2`(HIGH, after FIX1: P&L/getSummary/
getBadDebtsReport) → `FIX3`(HIGH, after FIX2, shared file: mobile/finance/by-customer dashboards)
→ `P1`-`P11`(revert-probe, HIGH each; P1-P4,P11→FIX1, P5-P7→FIX2, P8-P10→FIX3) → `DOCS1`(routine,
after all 11 probes: code-map + lessons + bug-registry proof lines for B440/B455/B456 only — do
NOT touch B448-B458, separate filed bugs).

12 regression tests (T1-T12, REG-tagged), each with an exact fixture/oracle in bug-test-plan.md.

## Amended S3 paragraph (owner ruling, tax exclusion — verbatim, sent to c4 already)

> AMENDMENT 2026-09-15 (owner ruling, relayed by lead, post-S5): revenue excludes sales tax
> collected — standard accounting. `gross` = Σ(invoice.total − invoice.taxAmount), not
> Σinvoice.total. Category/excise tax is already folded into `taxAmount`, not a separate component
> of `total` — one subtraction excludes both, no separate category-tax term needed. Shipping and
> discount stay IN revenue (only tax comes out): `gross = total − taxAmount = subtotal − discount +
> shippingFee`. CreditNote has no `taxAmount` column today — subtract `amount` as-is in PR1 with a
> `// TODO B459` comment at the subtraction site; do not add the column now. `externalRefunds`
> needs no change (already pre-tax, `priceReturn` uses `subtotal` only). Do NOT add a
> `feeForPaymentId` clause — that's the check-payments lane's job, later, same helper.

Verified facts behind this (not re-derivable without re-reading — see build-plan.md's FIX1 section
for exact citations): `taxAmount = regularTax + categoryTax` confirmed across 4+ computation sites
in `invoices.service.ts`. Manual credit-note amounts: line-based credits are provably pre-tax (UI
caps at `InvoiceItem.subtotal`); freeform/lump-sum credits have no enforced tax semantics at all.

## Open risks (not blockers, recorded for the PR body)

1. **Freeform manual credit-note tax ambiguity** — a lump-sum credit (no line selected) is a bare
   operator-typed number with no cap/validation against any invoice figure; it MAY include tax in
   practice, and this run cannot detect or correct that. Closes when B459 (returns-in-orders lane)
   adds `CreditNote.taxAmount`. Document in the PR body, not a blocker.
2. **`getBadDebtsReport()` needs a new window parameter** it doesn't have today — FIX2's brief
   flags this as an implementation-time call (default vs. thread a new param through the caller),
   not prescribed by the ruling.
3. **B455/B456 are not yet rows in `.claude/campaign/bugs.jsonl`** (reserved as S-H/S-I, B448-B458
   range) — the minter files them in its next registry PR. `DOCS1`'s brief already says: re-check
   fresh at execution time, escalate rather than mint on this non-master worktree.
4. Sibling-sweep (post-loop, `mode:'bugfix'`) will likely hit `analytics.service.ts`'s own
   `paidAt`-based revenue series (flagged FU-3 candidate already) — file, don't fix, per scope
   discipline (L-008).

## If resuming cold from here

Read this card, then `build-plan.md` in full (it is self-contained — "nothing here says 'as
discussed'"). Do not re-plan; S0-S5 are done and c4-reviewed. The only remaining decision at
launch time is HOW to execute the plan (full engine vs. leaner hand-execution) given
cost/token constraints at that moment — the WHAT and WHY do not change. Wait for c4's literal
"LAUNCH B440" before starting S6 either way.
