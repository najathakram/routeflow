# RouteFlow Web — Unified Design System (proposal)

> **This is the approval gate.** It reconciles the four+ competing token systems and three
> unrelated auth screens (see [`README.md`](README.md#design-inconsistency-catalogue)) into **one**
> language, so every surface reads as the same product. Nothing gets designed in Claude Design until
> this is signed off. Recommendations are opinionated; genuine forks are called out in
> [Decisions for sign-off](#decisions-for-sign-off).

## Design principle

**One product, themed by context — never four apps.** A single foundation, one component kit, one
set of interaction rules. Surfaces differ **only** by an _accent_ and a _density setting_. The
buyer portal is "RouteFlow with a green accent, comfortable density" — not a different product.
Tenant branding stays load-bearing: it overrides the accent at runtime via the existing `--primary`
CSS var.

## Division of labor (per user direction)

- **RouteFlow (this doc + the section files) supplies the _function_**: what each surface must do,
  the data it shows, the behaviors it must keep, brand identity (teal + tenant color), status
  semantics, density needs, and the consolidation target. **We do not dictate appearance.**
- **Claude Design owns the _appearance_**: the concrete type system, shape/corner language,
  elevation/shadow, spacing rhythm, and visual detailing. **One hard constraint:** it must define
  that visual system **once**, up front, and apply it **consistently to every surface** — that
  consistency is the entire point of this effort. So the first Claude Design task is a
  _visual-system proposal_ (its call) + 2–3 hero screens for review, before the full build.

Tokens named below (teal brand, status families, the accent/density concept) are **functional
inputs**, not visual prescriptions — exact hues within a family, and all type/shape/elevation
choices, are Claude Design's to decide.

---

## 1. Tokens

### 1.1 Neutrals (shared by every surface)

| Token           | Value     | Use                    |
| --------------- | --------- | ---------------------- |
| `--ink-900`     | `#0F1B2D` | Headings, primary text |
| `--ink-700`     | `#33425B` | Body text              |
| `--ink-500`     | `#5C6B82` | Secondary text         |
| `--ink-400`     | `#8B97AC` | Muted / placeholder    |
| `--paper`       | `#FFFFFF` | Cards, sheets          |
| `--canvas`      | `#F7F9FC` | App background         |
| `--sunken`      | `#EDF1F6` | Wells, table zebra     |
| `--line`        | `#E2E8F0` | Hairlines              |
| `--line-strong` | `#D6DEE8` | Input borders          |

### 1.2 Brand (default accent; **tenant `--primary` overrides at runtime**)

RouteFlow's truest identity is the marketing **teal** — adopt it as the default brand accent so
marketing and the operator app finally share a hue. Tenant branding still wins where set.

| Token                         | Value                                     |
| ----------------------------- | ----------------------------------------- |
| `--brand-700`                 | `#0B6E6B`                                 |
| `--brand-600`                 | `#0E8480`                                 |
| `--brand-500` (base)          | `#14A39F`                                 |
| `--brand-300`                 | `#7FD1CD`                                 |
| `--brand-50`                  | `#E8F2F1`                                 |
| `--primary` / `--primary-rgb` | = tenant color if set, else `--brand-500` |

### 1.3 Context accents (accent-only deltas — the ONLY per-surface color change)

| Context                        | `--accent`                                         | Signals                                 |
| ------------------------------ | -------------------------------------------------- | --------------------------------------- |
| Operator / Tenant Admin        | brand teal (tenant-overridable)                    | the workhorse                           |
| Buyer portal                   | emerald `#059669` (`-deep #047857`, `-50 #ECFDF5`) | consumer-facing B2B                     |
| Platform admin                 | indigo `#4F46E5` on a slate-tinted chrome          | "you are in the platform, not a tenant" |
| Marketing (neutral/wholesaler) | brand teal                                         | brand                                   |
| Marketing (retailer sub-theme) | rust `#C75A3D`                                     | retailer angle                          |

### 1.4 Status (one set, everywhere)

`success #16A34A / bg #DCFCE7` · `warning #D97706 / bg #FEF3C7` · `danger #DC2626 / bg #FEE2E2`
· `info #0284C7 / bg #E0F2FE`. Order/invoice/route/return status pills map onto these four families
(documented per-area in the section files) — no bespoke per-page status colors.

### 1.5 Typography — _Claude Design's call_

Claude Design chooses the type system (one display face + one UI sans + one mono), defined once and
used everywhere. **Functional constraints only:** a distinct display/serif voice is welcome on
outward surfaces (marketing/auth heroes, empty-state headlines) but must not reduce legibility in
dense tables; **`tabular-nums` (or equivalent) on every money value**; a clear semantic size scale
(display → caption) applied consistently. No specific family is mandated.

### 1.6 Radius, elevation, motion — _Claude Design's call_

Claude Design chooses one corner language, one elevation system, and motion detailing. **Functional
constraints only:** pick **one** shape language and apply it system-wide (end the pill-vs-rounded
split); elevation/visual effects must not cost data legibility or density in the operator/admin
tables (so if glass/blur is used, keep it to outward surfaces); honor `prefers-reduced-motion`;
toasts remain bottom-right + swipe-to-dismiss (a behavior, not a look).

### 1.7 Density (the second per-surface knob)

| Mode        | Row height | Base text | Used by                               |
| ----------- | ---------- | --------- | ------------------------------------- |
| Compact     | ~44px      | 13–14px   | Operator, Platform admin (data-dense) |
| Comfortable | ~56px      | 15px      | Buyer portal (consumer)               |
| Spacious    | —          | 16px+     | Marketing                             |

---

## 2. Component specs (one kit)

Built on the existing Radix + Tailwind foundation (`packages/ui/src/web/*`) so the redesign is a
re-skin + fill-the-gaps, not a rewrite. The list below is the **functional component set + required
behaviors**; the visual treatment of each is Claude Design's call (applied consistently).

- **Button** — variants `primary / secondary / ghost / danger / link`; sizes `sm / md / lg`;
  loading + disabled states. One definition, accent-driven.
- **Input / Textarea / Select / Combobox** — one field style; visible focus state; inline error
  text; the `UnitCombobox` (boxes+pieces) and searchable pickers inherit it.
- **Table** — sort header (`SortableTh` chevron cycle), **skeleton rows and empty state baked in by
  default** (fixes the uneven-polish inconsistency), optional row-select + sticky bulk bar.
- **Card / PageHeader / Tabs / Badge / Avatar / Pill** — one each.
- **Modal / Drawer / ConfirmDialog** — Radix dialog; ConfirmDialog is the single destructive-confirm
  (replaces the orders inline two-step).
- **Toast** — bottom-right, swipe-to-dismiss, 4s, 4 variants — **locked** (non-negotiable).
- **Nav shells** — all share structure/spacing/type, differ by accent + density:
  - _Operator sidebar_: collapsible rail (60/16), single-open accordion, role-based trees.
  - _Buyer sidebar_: emerald accent, "Your Sellers" switcher, floating cart.
  - _Admin sidebar_: slate chrome + indigo accent, Shield.
  - _Marketing top nav_: side-switch, CTA → the single auth entry.
- **Auth template** — **one** split-panel: accent gradient + serif value-prop + logo (left), form
  card (right). Role sets accent + copy + logo. **Eliminates the three-different-apps front door.**

---

## 3. Inconsistency → resolution (no unresolved rows)

| #   | Today                                                                                                                                                                                   | Becomes                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | 3 hardcoded auth screens (teal / slate / emerald)                                                                                                                                       | 1 accent-themed auth template                                                                           |
| 2   | `/admin/login` stub + `/admin-login`                                                                                                                                                    | 1 canonical `/admin-login`; delete stub                                                                 |
| 3   | 4+ token systems                                                                                                                                                                        | 1 token file: neutrals + brand + context accents                                                        |
| 4   | editorial-teal vs glassy-SF-Pro languages in Claude Design                                                                                                                              | 1 kit; glass only on marketing hero                                                                     |
| 5   | `/invoices/new` vs `/invoices/create`                                                                                                                                                   | 1 order/sale builder + "bill from order" as a mode; **and fix the money-math divergence**               |
| 6   | redirect-stub route sprawl (`/finance`, `/finance/customers`, `/shipments`, `/purchases`, `/vendor-bills`, `/bookkeeping`, `/distributors`, `/buyer`, `/callback`, `/customers/create`) | consolidate per the [README table](README.md#redirect-stubs--consolidation-discovered-during-traversal) |
| 7   | empty states / skeletons / sort on some pages only                                                                                                                                      | baked into the Table + list templates by default                                                        |

---

## 4. Coverage model for the mockups

Every screen in the inventory is represented. Screens sharing a **layout archetype** are designed
once as a canonical template; genuinely distinct screens get their own mockup. Archetypes → tokens

- density are fixed here so the build phase is mechanical:

1. Auth (template; operator/admin/buyer accent variants)
2. Marketing page (spacious; side-themed)
3. App shell ×3 (operator / buyer / admin nav)
4. Dashboard / overview (KPI + recent lists)
5. List + saved-views + filters + bulk-select
6. Entity detail + inline line-item editing (order/invoice)
7. Scan-to-add / create flow
8. Wizard (route builder, import)
9. Live dispatch (read-only POD on web)
10. Buyer shop → cart → checkout (comfortable)
11. Reports / analytics (charts)
12. Settings (tabbed)

**Hero screens designed fully first**: operator dashboard, orders list, order detail (inline price
edit), create-order scan flow, invoices list + detail, finance dashboard, buyer shop + cart, admin
tenants. Every mockup imports the one shared design-system file; each runs the Claude Design verify
loop (render → gate on errors → fresh-eyes → fix).

**Non-negotiables preserved**: the full checklist in
[`13-shared-patterns.md`](13-shared-patterns.md) (barcode auto-scroll, price memory, inline
per-line edit, saved views, URL filter state, Cmd+K, toasts, skeletons, empty states, realtime,
multi-channel send, tenant branding, `$X.XX` money).

---

## Decisions — settled

1. **Default brand hue** → **Teal** (unifies marketing + operator app; tenant color still overrides).
2. **UI typography** → **Claude Design decides** (we specify function, not appearance).
3. **Shape/elevation language** → **Claude Design decides** (one language, applied system-wide).
4. **Consolidation** → **Design the consolidated target** (one auth screen, one Bills & Purchasing
   hub, merged invoice creation, retired redirect-stub routes per the README table).

**Next step:** create the **"RouteFlow Web — Unified"** Claude Design project. First task there is a
_visual-system proposal_ — Claude Design's own choice of type/shape/elevation on top of these
functional inputs — plus 2–3 hero screens (operator dashboard, orders list, order detail) for a
quick review, before building the full set. Consistency across every surface is the acceptance bar.
