# RouteFlow: wire the Unified design package to the backend

You are working in the RouteFlow monorepo (NestJS API + Next.js web + Expo mobile). Your job is
to implement the RouteFlow Unified design package: rebuild the web app's surfaces to match the
designs exactly and wire every feature to real backend behavior.

## Before anything

1. Read `CLAUDE.md` and `CLAUDE_SESSION_PREAMBLE.md` (production-safety rules for migrations).
2. Read `.claude/code-map/INDEX.md` and plan from the map, not by re-reading the repo.
3. The design package lives at `C:\ClaudeCode\routeflow\docs\design-package\project` (folders: `unified/`, `specs/`,
   `uploads/`). Open `specs/backend-wiring-index.md` FIRST: it is the master table mapping every
   domain to entities, endpoints, spec file, and design files.

## What the package contains

- `unified/*.html`: 60+ hi-fi screens. These are the visual and behavioral source of truth.
  `rf.css` holds the design tokens (colors, type, spacing, radii, shadows, component classes).
  `surface-buyer.css` / `surface-admin.css` re-skin the same system for the buyer portal
  (emerald) and platform admin (indigo/slate). `shell.js` defines the three nav rails and topbar.
- `specs/*.md`: implementation specs with data models, rules, edge cases and acceptance
  checklists per domain (regulated items, pricing plans + gating, POS/cost/roles, messaging,
  buyer experience, migration/batch import, guardrails, mobile deltas).
- `uploads/*.md`: the original per-area PRDs (00 to 12). Specs override PRDs where they differ.

## Ground rules

- **Fidelity**: match the HTML designs 1:1 (layout, copy, states, spacing). Map `rf.css` tokens
  into `tailwind.config.ts` as semantic tokens; do not approximate with default Tailwind colors.
  Keep the three surfaces (operator / buyer / admin) visually distinct exactly as designed.
- **Copy is law**: the designs' microcopy was deliberately written (humane, direct, no em/en
  dashes, no exaggeration). Reuse it verbatim. New copy you must write follows the same rules.
- **Tenant scoping**: every query and socket event is tenant-scoped; JWT carries tenantId/role.
- **Feature gating is server-side**: implement the flag keys from `specs/plan-gating-wiring.md`
  (`plan.users_included`, `flag.dispatch_live`, `addon.regulated_items`, `metered.ocr_scans`,
  etc). Client hides or upsells; server enforces. Soft caps warn and grace, never interrupt a
  run in progress. Metered actions (AI scans, WA/SMS) finish the in-flight action, then prompt.
- **Never-block principle**: every guard modal has a legal path forward (capture license /
  override with responsibility / remove item; collect payment / hold order / override credit
  limit). No dead ends anywhere.
- **Undo standard**: reversible actions execute immediately and show an 8-second Undo (soft
  delete server-side); confirm dialogs only for irreversible acts (void payment, post filing,
  delete tenant). Imports and migrations get 24-hour undo via staging.
- **Money math**: keep `apps/api/src/common`, `apps/web/lib`, `apps/mobile/lib` `pricing.ts`
  mirrors in sync. Cost snapshots (`cost_at_sale`, method) are immutable history.
- **Realtime**: dispatch/live tracking, messages, notifications ride the existing Socket.io +
  Redis path; events listed per domain in the wiring index.
- Update the code map after every change; keep Jest and Playwright green per workspace.

## Build order (each phase ends with its spec's acceptance checklist passing)

1. **Foundation**: tokens into Tailwind; shared shell (rails, topbar, command palette ⌘K,
   toasts, notification center, skeleton/empty states from `unified/overlays.html` and
   `unified/ux-standards.html`); undo service; session re-auth sheet; en/es locale plumbing.
2. **Operator core**: dashboard, orders list/detail, sale builder (scan, price memory, live
   cost/margin with floors, minimize/resume drafts), customers, products (+variants), inventory
   hub, dispatch (overview, route wizard, live), returns. Specs: `pos-cost-roles-spec.md`.
3. **Finance**: invoices (+detail, send policy: email only), payments (+receipt, check chains
   incl. NSF), credit notes, bills & purchasing (vendor bills, unlinked-item mapping, cost
   dry-run), reports, finance overview. 
4. **Regulated items**: `specs/regulated-items-spec.md` end to end: tracked categories,
   product flags + category picker, authorizations (retailer-submitted + wholesaler-added),
   responsibility override, invoice splitting, category ledgers, filings hub, POD signature
   enforcement.
5. **Buyer portal**: `specs/buyer-experience-spec.md`: catalogue v2 (rail, running-low strip,
   promos, stock states, notify-me), Your Shelf replenishment, cart/checkout, open-order editing
   + change requests (with driver approve at stop), order tracking, invoices, payments & credits
   (check chains, credit wallet, statements), standing orders, licenses, messages.
6. **Messaging**: `specs/messaging-spec.md`: threads, provider adapters (WA/SMS), notification
   rules matrix + templates, opt-outs, quiet hours, metering, act-from-chat.
7. **Plans & billing**: `specs/pricing-plans.md` + `plan-gating-wiring.md`: signup, trial,
   choose-plan (usage-fit recommendation, monthly/annual), Settings Plan & Billing (meters,
   add-ons, proration), platform-admin Plans & Features editor (versioned), admin billing MRR.
8. **Migration & batch import**: `specs/migration-import-spec.md`: numbering sequences with
   continuation + collision skip, external-id upserts, staging + 24h undo, batch AI queue with
   statuses, variant resolution (variant / new product / alias match), onboarding checklist.
9. **Platform admin**: tenants lifecycle (impersonate, suspend, slug-typed delete), buyers +
   merges, audit, AI settings.
10. **Mobile**: apply `specs/mobile-new-features.md` (sections A to H) to `apps/mobile`,
    reusing the API contracts built above. Drive mode, at-door sheet, batch camera capture.

## How to verify each screen

For every screen you build, open the matching `unified/*.html` next to your implementation and
compare: nav state, header actions, table columns, badge variants, empty states, guard flows.
The design files are static; wherever they show data, that data shape tells you the DTO. When a
design and an existing API DTO disagree, extend the API (additive, migration-safe) rather than
degrading the design. If something is genuinely ambiguous, list it in a `QUESTIONS.md` at repo
root instead of guessing silently, and proceed with the most user-friendly interpretation.

Screens intentionally not drawn (reuse the named archetype): estimates list/detail (invoices),
supplier detail (customer detail), operational expenses list (bills list + form modal), stock
count tab (inventory table + count field), forgot-password (auth card), print manifest (doc
style like invoice/receipt), 404/error (empty-state pattern).
