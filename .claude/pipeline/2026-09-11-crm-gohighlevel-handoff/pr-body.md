## GoHighLevel → RouteFlow lead handoff (first CRM connector)

**Why.** A client runs GoHighLevel only for lead generation and re-types every won lead into RouteFlow. This
connector creates (or links) the RouteFlow customer automatically when a lead reaches the client's chosen pipeline
stage or is marked Won, flags it for onboarding, and writes back a tag, three custom fields and a note to the GHL
contact so sales sees which leads converted. Plan: `.claude/pipeline/2026-09-11-crm-gohighlevel-handoff/`
(discovery · spec R1–R33 · ux-spec · test-plan T1–T54 · build-plan · coverage-matrix) · ADR
`docs/adr/0004-crm-lead-handoff.md` · client runbook `docs/runbooks/gohighlevel-client-setup.md`.

**Shape.** Polling on a per-tenant Private Integration Token (AES-256-GCM at rest, never returned or logged),
`@LeaderCron("*/3 * * * *", "crm-gohighlevel.poll")`, ledger-idempotent `CrmHandoff` rows unique on
(tenant, provider, opportunityId), match-before-create (ExternalRef → email → E.164 phone → business name),
dry-run ON by default, `startFrom` cutoff with an explicit "import existing" preview, 429 cooldown via
`nextPollAt`, write-back retries with backoff [1,5,15,60,240] min then FAILED. No OAuth, no webhooks, no two-way
sync (Phase 2/3 candidates in the ADR). Field ownership: GHL owns identity fields; RouteFlow owns its three
`RouteFlow *` custom fields, the `routeflow-customer` tag and its notes.

**Surface.** API module `apps/api/src/crm/` (12 routes under `/crm/gohighlevel`, all `@RequireAddon("crm_gohighlevel")`
— registered **dark**), Prisma `CrmConnection` + `CrmHandoff` + 3 enums (additive migration
`20260911120000_crm_lead_handoff`, mirrored in `@routeflow/types`), gateway event `crm.lead.handoff` → operator
bell, Settings → Integrations → GoHighLevel tab, manual sandbox check `apps/api/scripts/crm-gohighlevel-check.mjs`.

**Proof.** Engine run `wf_79dfe9f9-496` (baseline → 7 test packages → structural RED → 5 packages → Opus/Sonnet
lenses: 63 findings, Verify confirmed 63) crashed at its fix phase (engine `Buffer` bug, fixed upstream); finished
as a light loop: round 1 fixed 36 root causes, round 2 fixed the Opus refute-first review's 1 blocker (a `where`
column typo unit mocks could not see — recorded as a testing lesson in `.claude/lessons/LESSONS.md`, id
assigned at landing) + 5 major + 4 minor. Mutation probes 6/6 caught (after
pinning match precedence T22b–d). Coverage: 26 requirements proven by tests, 7 manual, 0 unproven. Scoped gates:
api `src/crm` + tripwires 191 tests green, web 10 green, `split-prisma-schema --check` OK, `validate-lessons` OK.
Full verify chain: see the checks on this PR.

**Deploy day.** Additive migration only (apply via `prod-migrate.mjs` first). No tenant has a connection row, so the
cron is a no-op; the gate is dark. Rollback = `enabled=false` or revert. Pilot: client call, token created together
on screen share, one week in preview mode, then live.

**Owner rulings (2026-09-12).** Billable add-on at **$9.99/month** — this PR ships the dark gate only; a
follow-up publishes the sellable `AddonSku` (flat, granting `crm_gohighlevel`) in the next catalog version, after
which the gate flips to enforced. Default phone region `US`. Still open, non-blocking: email admins per handoff
(default is the bell and the activity log only).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
