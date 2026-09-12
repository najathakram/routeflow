# Discovery — GoHighLevel → RouteFlow lead handoff

- **Status:** IMPLEMENTED (2026-09-12, commits 939c7e44 · 0869623b · 316f1118) · **Scale:** major · **ui:** true · **Route:** dev-pipeline
- **Run dir:** `.claude/pipeline/2026-09-11-crm-gohighlevel-handoff/` · **Branch:** `feat/crm-gohighlevel-handoff` · **Base:** `83af7853` (origin/master)

## Problem, in the requester's words

A RouteFlow client runs GoHighLevel (GHL) **only for lead generation**. When a lead becomes a customer, a
member of their staff re-types the business name, contact, phone, email and address from the GHL contact card
into RouteFlow's "new customer" form, then creates the portal login. The client is not technical; they "just
have the tool". They asked whether RouteFlow can integrate with GHL.

## Whose problem, how often, what it costs

- **Role:** the client's office/admin staff (RouteFlow operator role) — every new customer.
- **Frequency:** every won lead (the exact monthly count is a Phase-0 client question; assume tens/month).
- **Cost:** 5–10 minutes of re-typing per customer, transcription errors (phone/email typos break portal logins
  and delivery contact), and a lag between "won" and "can order". Sales has no view of which leads became
  ordering customers.

## Current workaround and why it fails

Manual re-typing from one browser tab to another. It fails on volume, on accuracy (typos), and on visibility
(nobody in GHL knows the lead is now a RouteFlow customer, so sales keeps nurturing converted leads).

## Why now

The client asked. It is also RouteFlow's first CRM connector; the shape chosen here (provider folder, encrypted
per-tenant token, ledger-idempotent polling) is the template for the next one.

## If we ship nothing

The client keeps re-typing; the ask is answered "no". Low platform cost, but a direct client request declined
and the CRM-connector template unbuilt. Not a stop condition: the user, the workaround and the signal are all
stateable.

## Success signal (observable) and baseline

- **Signal:** number of RouteFlow customers created from GHL without manual entry, and zero re-typed customers
  for the pilot client after go-live. Baseline today: 0 automated, 100% manual.
- **Secondary:** the GHL contact of every converted lead carries the `routeflow-customer` tag within 3 minutes
  of reaching the client's "customer" stage.

## Who else is affected

- Other RouteFlow tenants: nothing changes (feature behind a dark add-on gate, cron is a no-op with no
  connection rows).
- RouteFlow ops: a new nightly-ish surface to watch (connection `NEEDS_ATTENTION`, dead handoffs).
- The client's sales team: they see the tag/note/link on converted contacts.

## Is the request a symptom?

Partly. "Integrate with GHL" is the client's phrasing; the underlying problem is double entry at conversion
plus no feedback to sales. The chosen shape targets exactly those two, and deliberately excludes contact
sync, marketing events and OAuth (see non-goals in spec.md).

## Solving the problem or building someone's solution?

Solving the problem. The client did not prescribe a mechanism. The polling-on-token design was chosen for
zero client-side configuration and zero inbound attack surface; it is the smallest shape that removes the
re-typing.

## Strongest hostile objection, answered

_"Polling is crude; webhooks are the right way."_ GHL webhooks exist only for OAuth marketplace apps, which
need a developer app, a review-free private distribution, token refresh handling and an unauthenticated signed
inbound endpoint. For a lead handoff, a 3-minute delay is invisible to the client, and polling needs none of
that. The design keeps an OAuth upgrade path (same connection row, `authKind`), so nothing is thrown away if
sub-minute latency is ever required.

_"Auto-creating customers pollutes the tenant."_ Mitigated by: a `startFrom` cutoff (only leads converted
after connect), dry-run on by default with a reviewable preview, match-before-create on link/email/phone/name,
and NEEDS_REVIEW instead of guessing when identity is missing.

## Deploy-day answer

Additive migration (two tables, three enums). No tenant has a connection row on deploy day, so the cron finds
nothing. The gate key `crm_gohighlevel` ships `dark` (allow + log). Rollback = set `enabled=false` on the
connection or revert the deploy; tables are inert.
