# Lead replies

(the lead appends dated answers below)

- 2026-09-15T19:58Z · lead: spec-leads-deals.md (Frappe lead and deal behaviour spec, 7 sections, 47 test cases) added on this branch. Read it before Phase 1 S1.

- 2026-09-15T20:10Z · lead: engine updated to sha256 02d58b813fcbf6a60197cf5773f7b77c513ed67a117ed09cbae4ab3e42044b87 (224,133 B, E10 workdir-leak fix) via merge of the skills-sync branch. Verify this sha before any engine launch.

## 2026-09-15 ~21:35Z · lead replies to CRM cloud session requests #1–#9 (after S0)

Good report. Every ruling below is binding.

**#1 Engine.** The engine CHANGED after your S0. Pull this branch: it now carries sha256 `02d58b813fcbf6a60197cf5773f7b77c513ed67a117ed09cbae4ab3e42044b87`, 224,133 B (E10: every git, script and search call is pinned to the workdir). That is the value STAGED-ENGINE.md carries now. Verify it before any Workflow launch. Do not run b71f6c8e.

**#3 Push authorisation — ruled.**
- Docs-only pushes (STATUS.md, LEAD-REQUESTS.md, your pipeline artifacts) are authorised after every step, through the GitHub MCP path.
- Code pushes to your own slice branch (`feat/crm-phase1-*`) are authorised only AFTER I reply "S5 approved" here. Before every code push, run `npm run check-types`, `npm run lint` and the affected Jest projects in the container, and paste the tail of each output into STATUS.md. The MCP push path skips the repo's pre-push verify hook, so this replaces it. Merge `origin/master` first.
- Never push to `master`, never force, and never open a non-draft PR. Draft PRs are allowed after S5 approval.
- Authorship via the API is fine.

**#4 Host-heavy steps.** Noted. When you reach compose, `local:validate`, `local:test:db`, `local:e2e` or the screenshots, write "need HOST: <step>, branch <name> @ <sha>" in LEAD-REQUESTS. I run them locally on your pushed branch and paste the results here.

**#6 Owner-on-unassign — diverge, fixed as you recommend.** Clear `ownerUserId` only when the owner's own assignment is cancelled, re-derive otherwise, and pin it with a test that names the upstream wrinkle.

**#7 Lead dedup — email OR phone for the advisory offer, never auto-merge.** Match within the tenant only. Emails compare trimmed and case-insensitive. Phones compare normalised to digits, with the same normaliser the customers module already uses (find it, don't write a second one). Add a test for the phone-only match.

**#8 Three divergences — agreed as settled.** Status-log type per entity, no roll-up money columns (the CRM writes no money in Phase 1), and gate conversion on `stage.isLost` with `status = CONVERTED`.

**#9 Scope fence — confirmed.** Sales-hierarchy subtree, SLA engine, kanban and everything deal-shaped are Phase 2+. Phase 1 scoping = owner or assignee, plus TENANT_ADMIN/OPERATOR see all. Say where BUYER and DRIVER land: they should see no CRM.

**Extra rulings you'll need:**
- **Feature key convention (from the feature-grants design).** Every new grantable key matches `^[a-z][a-z0-9_]*$`, and the admin form rejects dots. Name the CRM gate `crm_core`, register it dark in `apps/api/src/billing/addon-gate-registry.ts` with a real `@RequireAddon` call site, and don't reuse or touch `crm_gohighlevel`.
- **Lead→Customer conversion.** `Customer.userId` is required and unique, so conversion must go through the existing customer create path and create the user record exactly the way that path already does. Make it idempotent under the customer-level advisory lock (`withAdvisoryLock` in common/db-locks.ts, registered lock names only), and never add a second in-process lock.
- **Nest module DI (lesson L-113).** Every new module imports the modules its providers need. The API has crashed at boot from this before, and I run the compose boot gate before merge.

## 2026-09-15 ~22:45Z · lead: TOKEN BUDGET PAUSE (owner: the weekly limit is near)
- Finish the step you're on, then STOP at S5. Push the S5 build-plan summary to STATUS.md and stay idle. Don't start S6/S7, and don't launch the Workflow engine.
- When you resume (after my reply), use the lean method, not the full engine: dependency waves of at most 2 Sonnet subagents at effort medium, each given only its own slice of the plan; targeted Jest per wave; ONE Opus refute-first review of the whole slice diff; one Sonnet fix round. No Fable in the build.
- Keep your own context small: compact when you pass about 200k tokens.
