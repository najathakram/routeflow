# Open questions — Unified design wiring

Genuine ambiguities found while wiring the Unified design package. Each has a **chosen default**
(most user-friendly / most design-faithful interpretation) that is implemented until told otherwise.

## Phase 1 — Foundation

1. **Default brand vs tenant brand.** `rf.css` ships a static teal (`--brand-500 #14A39F`) but the app
   is tenant-branded (`--primary` overridden at runtime by `TenantProvider`). The design's teal is the
   _unbranded default_.
   **Chosen default:** teal is the fallback/default; tenant `--primary` continues to override `--accent`
   on the operator surface at runtime (unchanged behavior). Buyer stays emerald, admin stays indigo
   regardless of tenant brand (per surface CSS).

2. **`canvas` token name collision.** The existing Tailwind `canvas` color = dark navy `#0f1b2d`
   (marketing hero gradients, safelisted). `rf.css --canvas` = light page bg `#F7F9FC`.
   **Chosen default:** keep `canvas` (dark navy) for marketing; expose the Ledger light page bg via
   `surface.raised` (re-pointed to `#F7F9FC`) + `--canvas` CSS var / `bg-sunken`. No marketing changes.

3. **Messages nav entry.** `shell.js` operator rail shows a top-level **Messages** item, but the
   messaging domain is Phase 6 and `/messages` does not exist yet.
   **Chosen default:** omit Messages from the operator rail until Phase 6 (avoid a 404 nav item); add it
   when the route lands. Bills & Purchasing (`/vendor-bills`) and Regulated Items (`/tobacco`) exist and
   are wired now.

4. **"Regulated Items" vs "Tobacco".** The design labels the shield nav item **Regulated Items**; the
   current app calls the addon-gated section **Tobacco** (`/tobacco`, `tobacco_dealer` addon).
   **Chosen default:** keep the existing route/addon; Phase 4 generalizes tobacco → regulated categories
   per `regulated-items-spec.md` and relabels. For now the nav label follows the addon state.

5. **Compact density scope.** `rf.css` sets `body { font-size: 13.5px }` globally. Applying that to
   `<body>` shrinks every class-less/`em`-sized element on the not-yet-rebuilt marketing and auth
   pages too.
   **Chosen default:** scope compact density to the app surfaces only — `font-size: var(--text-body)`
   lives on `.surface-operator` (13.5px) / `.surface-buyer` (14px) / `.surface-admin` (13.5px), not
   `<body>`. Marketing/auth keep the 16px base until rebuilt. This also makes the per-surface
   `--text-body` knob actually take effect.

6. **Tenant brand vs the accent ramp.** `rf.css` hardcodes `--primary-strong/deep/soft` to the teal
   `brand-600/700/50`, so a tenant overriding only `--primary` would get a re-branded fill DEFAULT but
   a teal strong/deep ramp (button fill vs focus ring mismatch).
   **Chosen default:** keep the exact teal ramp when a tenant has no custom color; when
   `branding.primaryColor` is set, `TenantProvider` derives `--primary-strong/deep/soft` from it
   (`shade()` mixes toward black/white) so the primary button, stat tiles, and links re-brand together
   with the focus ring. `DEFAULT_PRIMARY` is teal `#14a39f` (was stale blue `#2563eb`).

7. **Undo scope for hard-deleted domains.** The undo standard needs server-side soft-delete. Only
   Customer / User / Tenant / Expense / BuyerAccount have `deletedAt`; Order, OrderItem, Invoice,
   InvoiceItem, CreditNote, Payment are hard-deleted, and adding soft-delete there is a 50+ callsite
   change (every `findMany` must filter `deletedAt: null`; unique constraints need partial indexes).
   **Chosen default:** ship the reusable `useUndo` primitive now and prove it end-to-end on Customer
   delete (which already soft-deletes) via a new `POST /customers/:id/restore`. Order/Invoice/etc.
   soft-delete + undo land when those domains are rebuilt (Phase 2/3), reusing the primitive — not as
   a risky Phase-1 migration. Imports/migrations keep their 24h staging undo (Phase 8).

## Phase 2 — Operator core

8. **When does a builder autosave into a draft?** The spec says drafts "autosave per
   keystroke". Auto-creating a draft the instant the builder opens (or on the first keystroke of
   any order) would fill the dock with abandoned half-orders every time someone opens the builder
   and clicks away.
   **Chosen default:** a builder autosaves only once it is _bound to a draft_ — i.e. after the
   operator explicitly hits **Minimize** (parks + creates the draft) or **Resumes** one from the
   dock. From then on every change autosaves (debounced ~900ms) so a resumed draft survives
   navigation, device loss, and syncs across devices. A never-parked fresh builder is not
   persisted (Cancel discards it), keeping the dock free of accidental drafts. Completing the order
   (create / save-as-draft-order / merge) deletes the parked draft.

9. **Which builders get Minimize in Phase 2?** The spec covers order / invoice / PO builders.
   **Chosen default:** wire the **order builder** (`CreateOrderModal`) end-to-end now (Minimize +
   resume-hydrate + autosave + scan-to-draft). The dock already routes `INVOICE` drafts to
   `/invoices/new`, but the invoice builder's Minimize/resume hydration is a follow-on in Phase 3
   (Finance). Since only the order builder can _create_ drafts today, no `INVOICE` draft exists yet,
   so the dock's invoice routing is inert until then.

10. **Does the tenant costing method retroactively re-cost existing products?** The spec frames costing
    method as a tenant setting, but the schema has a per-product `Product.costingMethod` (default FIFO) and
    `recordSale` keys off it. Re-costing existing products mid-stream would rewrite ongoing COGS behavior on
    the critical sale-costing path.
    **Chosen default:** the tenant `costing.method` is the tenant DEFAULT; `recordSale` respects each
    product's own `costingMethod` — now including the new `LAST_COST` (cost = most recent purchase lot's
    unit cost), selectable per product. Existing products keep their method (no retroactive re-costing —
    safe on the money path), and the per-line `cost_at_sale` snapshot makes history immutable regardless
    (so a method change is naturally effective-dated). Propagating the tenant default to NEW products at
    creation is a small follow-on (cross-module wiring); until then the tenant-level method selector is
    stored + shown but only the per-product picker actually drives costing.

_(add new questions below as they arise, grouped by phase)_
