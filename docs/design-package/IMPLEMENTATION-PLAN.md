# RouteFlow Unified — Implementation Plan & Tracker

> Wiring the **Unified "Ledger" design package** (`docs/design-package/project/`) to the backend.
> This is a **multi-session program**. Source of truth: `project/unified/*.html` (visual/behavioral),
> `project/specs/*.md` (rules), `project/uploads/*.md` (PRDs; specs override). Master map:
> `project/specs/backend-wiring-index.md`.
>
> **Cadence:** one feature branch + PR per phase (master push is blocked → PR + squash-merge).
> Each phase ends with its spec's acceptance checklist passing + Jest/Playwright green per workspace.
> Update the code map (`.claude/code-map/`) after every change.

## Design system facts (the "Ledger" system)

- One foundation; **surfaces differ only by `--accent` + density.** Operator = teal
  (`--brand-500 #14A39F`), Buyer = emerald (`#059669`, roomier: row 52 / body 14),
  Admin = indigo (`#4F46E5`) on slate chrome (compact).
- Tenant `--primary` still overrides `--accent` at runtime (TenantProvider) on the operator surface.
- Type: **Spline Sans** (UI), **Spline Sans Mono** (money/mono, tabular-nums), **Instrument Serif**
  (display/empty-state titles). Compact default density: `--row-h 44px`, `--text-body 13.5px`.
- Radii: controls `6px`, cards `10px`, chips/pills full. Shadows hairline-first
  (`sh-card 0 1px 2px /.05`, `sh-drop`, `sh-modal`).
- Ink neutrals: `ink-900 #0F1B2D / 700 #33425B / 500 #5C6B82 / 400 #8B97AC`;
  `paper #FFF / canvas #F7F9FC / sunken #EDF1F6 / line #E2E8F0 / line-strong #D6DEE8`.
- Status: success `#16A34A`/bg `#DCFCE7`, warning `#D97706`/`#FEF3C7`, danger `#DC2626`/`#FEE2E2`,
  info `#0284C7`/`#E0F2FE`.

## Cross-cutting ground rules (apply every phase)

- **Fidelity 1:1** with the HTML; **copy is law** (reuse verbatim; humane, direct, no em/en dashes).
- **Tenant-scoped** everything (queries + socket events); JWT carries tenantId/role.
- **Server-side gating** (flag keys in `plan-gating-wiring.md`). Client hides/upsells; server enforces.
  Soft caps warn + grace, never interrupt a run in progress; metered actions finish then prompt.
- **Never-block:** every guard modal has a legal path forward (no dead ends).
- **Undo standard:** reversible acts execute immediately + 8s Undo (soft-delete server-side);
  confirm dialogs only for irreversible (void payment, post filing, delete tenant). Imports = 24h undo.
- **Money math:** keep `apps/{api/src/common,web/lib,mobile/lib}/pricing.ts` in sync; cost snapshots
  (`cost_at_sale`, method) are immutable history.
- **Realtime** rides existing Socket.io + Redis; events per domain in the wiring index.

---

## Phase status

| # | Phase | Spec | Status |
|---|---|---|---|
| 1 | Foundation (tokens, shell, overlays, undo, re-auth, i18n) | ux-standards, overlays | **COMPLETE** |
| 2 | Operator core (dashboard, orders, sale builder, customers, products, inventory, dispatch, returns) | pos-cost-roles | **SHIPPED & DEPLOYED** (#121, 2026-07-06 — see PHASE-2-PLAN.md) |
| 3 | Finance (invoices, payments, credit notes, bills/purchasing, reports, overview) | pos-cost-roles, guardrails §9 | **RESKINS DONE** — F1 (finance dashboard, invoice detail, credit-notes; #121) + F2 (invoices-list KPIs, payment receipt, bills-hub + new PO tab, vendor-bill detail; branch `feat/phase3-reskin-safe`). SKIPPED (current > mockup): Financial Reports (22-report explorer), Recurring invoices. DEFERRED to Phase 4 (backend absent, not stubbed): vendor-bill `supplierInvoiceNumber`/`creditApplied`/OCR-activity/Effect-on-Costs dry-run; payment `recordedBy`/company block |
| 4 | Regulated items (categories, authorizations, override, invoice split, ledgers, filings, POD) | regulated-items | not started |
| 5 | Buyer portal (catalogue v2, shelf, cart/checkout, order edit + change requests, tracking, finances, standing, licenses, messages) | buyer-experience | not started |
| 6 | Messaging (threads, WA/SMS adapters, rules matrix, opt-outs, quiet hours, metering, act-from-chat) | messaging | not started |
| 7 | Plans & billing (signup, trial, choose-plan, settings billing, admin plans editor, admin MRR) | pricing-plans, plan-gating-wiring | not started |
| 8 | Migration & batch import (numbering, external-id upsert, staging + 24h undo, batch AI queue, variants, onboarding) | migration-import | not started |
| 9 | Platform admin (tenants lifecycle, buyers + merges, audit, AI settings) | plan-gating §1/§4 | not started |
| 10 | Mobile deltas (sections A–H: drive mode, at-door sheet, batch camera) | mobile-new-features | not started |

---

## Phase 1 — Foundation (detail)

**Goal:** the design token system + shared shell + UX-standard primitives, so every later screen is
built on the Ledger foundation and matches 1:1.

### 1a. Tokens & type  — _status: done in this increment_
- `packages/config/tailwind.config.ts` (monorepo preset, source of truth): brand→teal, navy→ink-900,
  surface.raised→canvas; add var-backed `ink`/`accent`/`line`/`paper`/`sunken`; fonts sans→Spline Sans,
  add mono (Spline Sans Mono) + display (Instrument Serif); radii `ctl`/`card`; hairline shadows.
- `apps/web/tailwind.config.ts`: extend var-backed tokens; drop stale hardcoded brand overrides.
- `apps/web/app/globals.css`: full Ledger `:root` var set; `.surface-buyer`/`.surface-admin` overrides;
  `@layer components` with rf.css component classes (`.rf-*`) for 1:1 reuse.
- `apps/web/app/layout.tsx`: load Spline Sans + Spline Sans Mono (next/font); expose CSS vars.

**Re-skin leverage:** primitives + screens use semantic classes (`text-navy`, `bg-brand-*`,
`bg-surface-raised`, `border-surface-border`), so re-pointing tokens flips the whole app palette.

### 1b. Shared shell  — _status: done in this increment (operator); buyer/admin accent applied_
- Operator rail (236px, ink-900, brand tile, active inset teal bar) + topbar (60px, title, ⌘K
  searchpill, bell badge, avatar+name) restyled to `shell.js` / `rf.css`. Keep existing React logic
  (accordion, mobile drawer, guards, g-sequences, notifications) intact.
- Buyer + admin layouts get `.surface-buyer` / `.surface-admin` wrapper for their accent + density.
- Nav reconciliation (visual/labels only; routes must exist or be deferred): add **Bills & Purchasing**
  under Warehouse (`/vendor-bills`); **Regulated Items** = tobacco (addon-gated, Phase 4);
  **Messages** deferred to Phase 6 (route doesn't exist yet).

### 1c. Overlay kit primitives  — _status: done in this increment_
- Reskin `packages/ui/src/web/{Button,Badge,StatCard,EmptyState,Toast,Table}.tsx` to Ledger
  (heights, radii `ctl`/`card`, mono money, hairline, uppercase badge, ring-danger/success stat).
- Add `Skeleton` primitive (shimmer per `.skel`).

### 1d. Behavioral UX standards  — _status: done in this increment_
- **Undo service**: `useUndo()` (`apps/web/lib/undo.ts`) runs a reversible act immediately + shows an
  8s Undo toast (Toast gained `action` slot + `dismiss(id)`). Proven end-to-end on customer delete:
  server `POST /customers/:id/restore` (no migration — Customer already has `deletedAt`; RF-197) +
  `useSoftDeleteCustomer`/`useRestoreCustomer`; the customer-detail delete is now a reversible
  soft-delete with Undo (dropped the type-name confirm). **Order/Invoice soft-delete + undo land as
  those domains are rebuilt (Phase 2/3) — adding `deletedAt` there is a 50+ callsite change, so it is
  scoped to each domain's phase, reusing `useUndo`.** (See QUESTIONS.md #7.)
- **Session re-auth sheet**: `apps/web/lib/session-expiry.ts` bridge + `components/ReAuthProvider.tsx`.
  On refresh failure `api-client` pauses the failed request and asks the mounted sheet to unlock in
  place; drafts survive. "Switch account" declines → old /login redirect. Buyer/marketing unaffected.
- **i18n en/es**: home-grown (no dep) — `lib/i18n/{messages,index}.tsx`; `useI18n()`/`t()` with
  `{var}` interpolation; per-user locale persisted via `UserPreference` (`PATCH /users/me/preferences`,
  no migration) + localStorage; avatar-menu Language/Idioma toggle. es covers all keys (type-enforced).
- **Command palette**: Jump to / Actions / Results sections + `? shortcuts` footer + Ledger active
  style; localized. (g-sequences already existed.)

### Phase 1 acceptance (from ux-standards.html / overlays.html)
- [x] Tokens map 1:1 to rf.css; three surfaces visually distinct (teal / emerald / indigo).
- [x] Spline Sans UI + Spline Sans Mono money + Instrument Serif display live.
- [x] Operator shell matches design (rail, topbar, ⌘K, bell, avatar).
- [x] Skeleton primitive + illustrated empty state available (adopted per screen as rebuilt).
- [x] Toasts bottom-right, 4 variants; command palette ⌘K with Jump-to/Actions/Results sections.
- [x] 8s Undo standard (soft-delete) — primitive + proven on customer delete; per-domain adoption
      follows each domain's phase. Confirm dialogs only for irreversible.
- [x] Session expiry shows in-place unlock sheet, never loses work.
- [x] Per-user en/es toggle in avatar menu (persisted via UserPreference).

---

## Open questions
See `/QUESTIONS.md` at repo root.

## Change log
- _(this increment)_ Phase 1a–1c: Ledger tokens into preset + web config + globals; Spline Sans/Mono
  fonts; primitives + operator shell reskin; buyer/admin surface accents. 1d (undo/re-auth/i18n) pending.
  - Adversarial review (2 agents) → 6 findings fixed: **(HIGH)** `ink`/`navy` now use
    `rgb(var(--x-rgb) / <alpha-value>)` so the ~2.2k existing `navy/<opacity>` utilities emit CSS again
    (skeletons/muted text were breaking); `DEFAULT_PRIMARY` → teal; `TenantProvider` derives the accent
    ramp from a tenant's custom color. **(MED/LOW)** compact density scoped to `.surface-*` not `<body>`;
    Toast icon-tile radius 8px. Verified at runtime (`text-navy/70`→rgba, accent default teal, marketing
    body back to 16px). Typecheck + lint green (web + ui).
