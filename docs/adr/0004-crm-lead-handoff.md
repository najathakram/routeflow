# 4. GoHighLevel CRM lead handoff — polling, ledger idempotency, field ownership

- **Status:** Accepted
- **Date:** 2026-09-11
- **Deciders:** RouteFlow maintainers
- **Related:** [`.claude/pipeline/2026-09-11-crm-gohighlevel-handoff/discovery.md`](../../.claude/pipeline/2026-09-11-crm-gohighlevel-handoff/discovery.md),
  [`spec.md`](../../.claude/pipeline/2026-09-11-crm-gohighlevel-handoff/spec.md) (R1-R33),
  [`docs/runbooks/gohighlevel-client-setup.md`](../runbooks/gohighlevel-client-setup.md),
  `apps/api/src/billing/addon-gate-registry.ts` (`crm_gohighlevel`, dark)

## Context and problem statement

Tenants running GoHighLevel as their sales CRM want a won opportunity to become a RouteFlow
customer automatically instead of someone re-typing it. The connector needs to read GHL
opportunities, decide when one has "handed off" to fulfillment, create or link the matching
RouteFlow customer, and write identifying fields back onto the GHL contact — once, safely, and
without a client's GHL account or RouteFlow tenant reaching an inconsistent state if a replica
restarts mid-run.

## Decision 1 — poll on the sandbox PIT over OAuth or webhooks

GoHighLevel exposes three integration paths: a marketplace OAuth app, inbound webhooks, and a
per-location Private Integration Token (PIT) polled on a schedule. We chose **PIT + polling**:

- **OAuth** needs a published marketplace app, GHL review, and a refresh-token dance per
  location — the wrong shape for a per-tenant "paste your token" setup a client can complete in
  the runbook's one page (R32).
- **Webhooks** need a publicly reachable HTTPS endpoint per tenant and GHL-side subscription
  management with no local retry story when RouteFlow is briefly down; polling degrades to "a
  few minutes late" instead of "silently missed."
- **Polling** costs one scheduled `@LeaderCron` tick (`*/3 * * * *`, see
  `gohighlevel-poll.service.ts`) per tenant with a connection `enabled`, a 50-page/120s budget cap
  and a 10s per-call timeout (R13), and degrades gracefully: a rejected token flips the
  connection to `NEEDS_ATTENTION` (R2) and the next tick just tries again.

## Decision 2 — ledger idempotency

Every opportunity the poller hands off is recorded before any RouteFlow or GHL write happens, and
the create/link + write-back steps are individually idempotent (a full-overwrite custom-field PUT,
an idempotent tag assignment, a `noteWritten` guard) so a poll run can never hand off the same
opportunity twice (R10) and a replica restart mid-sequence resumes safely rather than duplicating
a tag or note (see build-plan.md's write-back partial-failure risk row).

## Decision 3 — field ownership

GHL remains the system of record for contact identity (name, email, phone) — RouteFlow never
overwrites those. RouteFlow owns exactly three GHL custom fields plus one tag and one note it
writes back after a successful create/link (R19/R20):

- three custom fields carrying the linked RouteFlow customer id, its order/invoice URL, and the
  handoff timestamp,
- the `routeflow-customer` tag,
- one note recording the linkage outcome (created vs. matched, and to what).

Customer matching precedence is ref → email → phone → name (exact, case-insensitive only where
the spec calls for it) — see `crm-identity.ts` and T22-T25 in the test plan.

## Not now (deliberately out of scope, spec R32)

- Two-way sync of arbitrary GHL fields beyond the three RouteFlow owns.
- OAuth marketplace app / webhook ingestion (revisit only if polling latency becomes a client
  complaint — see the ADR's Decision 1).
- CRMs other than GoHighLevel.
- Historical backfill of opportunities that closed before a tenant connects (`startFrom` is a
  forward cutoff, not a backfill tool — R11).
- Any UI beyond the Settings → GoHighLevel tab (no dashboard widget, no mobile screen this round).

## Consequences

- The connector ships **dark** (`crm_gohighlevel` in `addon-gate-registry.ts`): every route 403s
  without the add-on grant, and with zero `CrmConnection` rows the cron loop is a no-op — no
  existing tenant behavior changes at deploy (R6, build-plan.md's "Deploy day" acceptance
  criterion).
- Latency is bounded by the poll interval (up to ~3 minutes), which the runbook sets as the
  client's expectation up front rather than promising real-time sync.
- **Pricing (owner ruling 2026-09-12): the connector is a billable add-on at $9.99 per month.**
  This ADR's branch ships only the dark gate; a follow-up billing change publishes the sellable
  `AddonSku` (flat monthly, granting the `crm_gohighlevel` key) in the next plan-catalog version
  and, if the catalog is mirrored to Stripe, its price. The gate flips to `enforced` only after
  that SKU exists and the pilot tenant holds it.
- A stuck `NEEDS_ATTENTION` connection needs an operator to re-paste a token; the once-per
  -transition email (R12) and the UI's stale-poll warning are the two surfaces that catch this
  before support does.
