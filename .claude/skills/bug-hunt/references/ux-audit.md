# UX audit — the experience axis

Correctness rounds ask _does the code do what it claims_. This reference is the complementary
axis: **is what it claims worth the user's time, and is it pleasant** — functional inconsistency,
unnecessary steps, friction, and anything that makes the product feel unfinished. An experience
defect is still a defect; it enters the register with the same evidence contract
(`references/verification.md`), the same B-numbering, the same refute-first discipline.

Ground rules carried over unchanged: read the register first (`local-assets/docs/routeflow-bug-register.html`
— B01–B45 were themselves largely UX findings); cite `path` + symbol for every claim (line numbers
drift); check **all three surfaces** (web dashboard, mobile, buyer portal) before declaring
anything absent; never a real client name; hunting never edits source.

**The three surfaces and where they live:**

| Surface             | Root                                                                | IA source of truth                                                             |
| ------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Operator web        | `apps/web/app/(dashboard)/`                                         | nav arrays in `(dashboard)/layout.tsx` (`label:`/`href:` entries, ~line 86 on) |
| Buyer portal        | `apps/web/app/buyer/portal/[seller]/`                               | its `layout.tsx`                                                               |
| Mobile (multi-role) | `apps/mobile/app/{(auth),(customer),(driver),(operator),(tenant)}/` | `(operator)/_layout.tsx` section split; `(operator)/(tabs)/_layout.tsx`        |

Web is the **golden reference** for flows; mobile is supposed to mirror it. Every divergence is
either a deliberate UI adaptation or a defect — the audit's job is to tell them apart.

---

## Lens 1 · Step count / path length

**Look for:** the click-and-screen count of the highest-frequency jobs, versus the value of each
step. Flag any job that needs a detour to another page mid-task, any modal that closes and loses
work, any "go to X to finish what you started in Y".

**The five jobs to count every round** (walk the code, count interactions):

1. **Take a phone order** — `orders/page.tsx` "New Order" → `CreateOrderModal.tsx`. This is the
   good baseline: one modal does customer pick, product search, barcode scan
   (`resolveProductByCode`), inline product creation (`InlineCreateProductModal`), per-line notes,
   draft parking. Measure regressions against it.
2. **Invoice it** — on `orders/[id]/page.tsx`, "Mark as Delivered" auto-creates the invoice and
   opens a send prompt (`useCreateInvoiceFromOrder`, the `invoiceNow()` closure) — zero extra
   screens. But invoicing _without_ delivering routes through `invoices/new/page.tsx` (a separate
   2,300-line builder). Count both paths.
3. **Record a payment** — invoice detail → "Record Payment" dropdown → `RecordPaymentModal`
   (`invoices/[id]/page.tsx`). There is no payment entry from the _order_ detail — the operator on
   the phone with a customer must first navigate order → linked invoice → payment.
4. **Dispatch a run** — `/routes` list → run detail (`routes/[id]/page.tsx`) → **"Dispatch Panel"
   button to yet another page** (`routes/[id]/dispatch/page.tsx`), even though the run detail
   already renders the stop list, map, and optimize. Ask what the extra page buys.
5. **Reorder as a buyer** — `buyer/portal/[seller]/templates/page.tsx` "Reorder Now" is one click
   (good); but the money math behind it is B48 (bills raw list price), which is a correctness bug
   wearing a one-click UX costume.

**Verified detour (the canonical instance):** purchasing is split across two pages that don't link
to each other. The nav item literally named **"Bills & Purchasing"** (`/vendor-bills`) has a
Purchase Orders tab that is **read-only** — no Create button, no receive action
(`vendor-bills/page.tsx` `PurchaseOrdersTab`). The actual PO lifecycle (Create PO, receive,
expand) lives in a _different_ `PurchaseOrdersTab` on `inventory/page.tsx` under Warehouse →
Inventory. An operator who follows the label "Purchasing" lands somewhere they cannot purchase,
with no link to the place they can. (Ancestor: B27, Finance's dead PO tab — the split survived
the move.)

**How to detect here:** open `(dashboard)/layout.tsx`, take each nav label literally, and ask
"can I complete the job this word promises without leaving this page?" Grep for duplicate
implementations of the same tab/feature name across pages (`grep -rn "Purchase Orders Tab" apps/web`)
— duplication is where the split hides. For modals, check whether closing mid-task parks a draft
(`useCreateDraft` in CreateOrderModal does; most others discard silently).

---

## Lens 2 · Cross-surface inconsistency

**Look for:** the same action with different fields, guards, or wording on web vs mobile vs buyer
portal; the same concept named differently in different places; client-side string literals that
disagree with the API enum.

**How to detect here:**

- Diff every client `case "STATUS"` / filter-value literal against the enums in
  `apps/api/prisma/schema/*.prisma`. Any literal not in the enum is a live bug, not a style nit.
- Diff the shared mirrors: `apps/{web,mobile}/lib/payment-methods.ts`, `trip-grouping.ts` — and
  then diff the _screens that consume them_, which is where drift actually lives. Money math has
  no mirrors: `no-mirrors.spec.ts` gates import specifiers and the deleted legacy files; a
  re-implementation is found by grepping for local `roundMoney`/`computeLineSubtotal` definitions
  outside `packages/pricing`.
- Grep one domain noun across all three surfaces and list every label used for it.

**Verified — behavioural drift with a dead end (found writing this reference):** the Prisma enum
is `PurchaseOrderStatus { DRAFT, SENT, PARTIAL, RECEIVED, CLOSED }`. Web's inventory PO tab uses
`PARTIAL` correctly. But:

- `vendor-bills/page.tsx` `PO_STATUS_FILTERS` sends `PARTIALLY_RECEIVED` — the API DTO
  (`apps/api/src/inventory/dto/list-purchase-orders.dto.ts`, `@IsEnum(PurchaseOrderStatus)`)
  **rejects it with a 400**; its own spec even pins the rejection
  (`list-purchase-orders.dto.spec.ts`: _"rejects a status outside PurchaseOrderStatus" →
  PARTIALLY_RECEIVED_). Clicking the "Partial" chip can only ever show the error row.
- Mobile `(operator)/purchase-orders/[id].tsx` gates
  `canReceive = po.status === "SENT" || po.status === "PARTIALLY_RECEIVED"` — a PO the API has
  marked `PARTIAL` **cannot have its remainder received on mobile at all**, and its status pill
  falls through to the raw string `PARTIAL` (also `index.tsx` `case "PARTIALLY_RECEIVED"`).

Same string, three surfaces, three different behaviours: works, 400s, dead-ends. This is the
shape to hunt.

**Verified — naming drift for one concept:** ad-hoc order delivery is "Order delivery" in the web
nav (`(dashboard)/layout.tsx`), "Deliveries" as the page title (`deliveries/page.tsx`), "Plan
delivery trip" on the orders bulk bar and command palette, and lives at the mobile route
`(operator)/trips/` (screen `TripsListScreen`, titled "Deliveries"). Buyer templates are worse on
a single page: heading copy says "Recurring order templates", the empty state says "No standing
orders", the route says `templates` (`buyer/portal/[seller]/templates/page.tsx`) — and the
dashboard's button says "Reorder" while templates' says "Reorder Now". Known register instances of
harder drift: B03 (password rules disagree between forms), B47/B49/B50 (boxes-vs-pieces and
driver-total behavioural divergence), B87 (deposit policy absent from mobile invoice creation).

---

## Lens 3 · Dead ends & orphans

**Look for:** a screen you can reach but not act on; a record with no route back to its parent; a
detail page nothing links to; a row styled as clickable that isn't.

**How to detect here:**

- Grep `hover:bg-` on `<tr>` / row containers, then check the same element for `onClick`, `Link`,
  or an expand toggle. Verified instance: `vendor-bills/page.tsx` PO tab rows carry
  `hover:bg-surface-raised` but have no click handler, no expansion, no link — they invite a
  click and eat it. (Mobile twin: B94, driver-detail route rows show a chevron but aren't
  tappable.)
- For every detail page under `[id]/`, grep the codebase for links _to_ it. B14 (bookkeeping
  transaction detail unlinked) came from exactly this check.
- For every list, check the reverse edge: from a credit note, can you reach its invoice? (B19 —
  raw IDs, no link.) From a payment, its receipt? (B80 — receipt page 404s beyond the newest 200,
  a picker-cap orphaning: grep `limit: 200` / `limit: 20` on queries that back detail lookups.)
- Redirect stubs are fine (`/purchases`, `/invoices/create`, `/routes/trips*` all redirect);
  a _tab_ or _screen_ that renders but offers nothing is not. Known: B27, B29 (route settings
  exist, uneditable), B21 (returns can't be cancelled from any screen), B95 (tenant-admin
  dashboard unreachable — an orphan at role scale).

---

## Lens 4 · Destructive-action safety

**The standard this product must hold:** any action that destroys or irreversibly merges data
(1) confirms, (2) **names what will be lost** — counts, names, and dollar amounts, not "this
item", (3) states irreversibility, and (4) where a softer path exists elsewhere in the app
(deactivate, void, cancel), offers it. The house has good exemplars — hold everything to them:
`finance/payments/[id]/page.tsx` void confirm names the reversal and says "cannot be undone";
`vendor-bills/page.tsx` `handleBulkDelete` states the guard rule and its result toast reports
`deleted` and `skipped (received/paid)` counts.

**How to detect here:**

- `grep -rn "confirm(" "apps/web/app/(dashboard)"` — every hit is a browser-native `confirm()`;
  compare against the styled `Modal` deletions (e.g. `DeletePaymentModal` in
  `invoices/[id]/page.tsx`). Two confirmation grammars for the same severity is itself a finding.
- Then find the destructive mutations with **no** hit at all: grep `Delete.*mutateAsync|delete.*mutateAsync`
  and check the call path for any guard.

**Verified — no guard at all:** `products/page.tsx` `handleBulkDelete` deletes every selected
product straight from the action bar, no confirm (B24 — erases history). And
`customers/page.tsx` `handleMerge` merges two customers on a single click of "Merge" with **no
dialog whatsoever** — worse, `const [primaryId, secondaryId] = Array.from(selected)` decides
which customer _survives_ by Set-insertion order, invisible and unchoosable in the UI. A merge
that guesses its own survivor is a data-loss lottery. Both violate all four points of the
standard while the payment-void 20 lines away meets it.

Also audit the **absence of undo where undo exists elsewhere**: orders can be reopened
(`orders/[id]/page.tsx` "Reopen this order?"), payments voided — but a merged customer or
bulk-deleted product has no inverse anywhere. The inconsistency, not just the danger, is the
finding.

---

## Lens 5 · Feedback & state

**Look for:** missing or lying loading/empty/error states; success toasts for partly-failed
operations; controls enabled when they can only fail; progress that doesn't track reality; caches
that keep showing the old world after a write.

**How to detect here:**

- For every `mutateAsync` returning a result object, check the toast: does it surface partial
  failure? House exemplar (copy it): vendor-bills `handleBulkMarkPaid` — toast reports
  `paid`/`skipped` and flips to `variant: "error"` when nothing succeeded. Anti-pattern to hunt:
  a bare `variant: "success"` with a fixed string after a bulk call.
- For every filter/action control, ask "is there any state in which this can only fail, and is it
  still enabled?" Verified: the vendor-bills PO "Partial" chip (Lens 2) is permanently enabled
  and can only ever produce the error row. Register kin: B15 ("Convert to Invoice" offered when
  it can't succeed), B16 ("Expired" estimate filter always errors).
- Query-cache honesty: after a write, does every list/detail that renders the changed number get
  invalidated? Known instances: B76 (payment doesn't refresh the order's cached invoice status),
  B86 (stock mutations skip product cache invalidation), B93 (order-edit writes an incomplete
  order into the cache), B77 (buyer cache not seller-scoped — the worst kind: _another tenant's_
  stale state).
- States that lie by computation: B90 (mobile Exceptions calls on-schedule runs "Late route"),
  B75 (Returns dashboard value always $0.00 — an empty state wearing a KPI's clothes).
- Transient feedback that outruns the user: buyer `templates/page.tsx` success banner carries the
  _only_ link to the created order and `setTimeout`-dismisses itself after 4 seconds. A
  confirmation that self-destructs faster than a human can act on it is feedback theatre.

---

## Lens 6 · Copy that misleads

**Look for:** instructions naming controls that don't exist; data-model jargon leaking into the
UI; error text with no next step; one concept with several names (see Lens 2 for the
cross-surface version).

**How to detect here:**

- Take instructional copy literally and follow it. B05 is the archetype: the branding tab points
  at a colour control that doesn't exist. The vendor-bills PO banner ("Receiving a PO updates
  stock…") describes a workflow _that tab cannot perform_ — accurate copy in the wrong room.
- Grep for raw enum/status strings reaching the DOM: any `default:` branch that renders the raw
  value (`statusPill` in mobile `purchase-orders/[id].tsx` renders `PARTIAL` verbatim — Lens 2),
  any `{status}` interpolation without a label map. Register kin: B28 (raw cost-set movement code
  on web).
- Check every catch-toast for actionability: "Failed to merge customers" (customers/page.tsx)
  tells the operator nothing about _why_ or _what now_. Compare the good pattern in
  `orders/[id]/page.tsx`, which deliberately surfaces the server's message because it contains
  the instruction ("void the invoice first") — copy that names the next step.
- The single-page naming test: read one screen aloud and count the nouns used for its subject
  (buyer templates page: "templates" / "standing orders" / "recurring order templates" — three).

---

## Lens 7 · Form & input ergonomics

**Look for:** free text where a picker belongs; missing defaults that force retyping; validation
arriving at submit instead of at the field; fields that discard input; keyboard/scan flow for
warehouse and driver contexts.

**How to detect here:**

- `grep -rn 'placeholder="YYYY-MM-DD"' apps/mobile` — **verified: every date on mobile is a
  free-text field.** Ten-plus screens (invoice new/edit, record-payment, payment edit, credit-note
  new, payments record, customer licenses) make an operator type ISO dates with
  `keyboardType="numbers-and-punctuation"`; there is no `DateTimePicker` anywhere in
  `apps/mobile`. Web uses `<input type="date">` throughout — the mirror broke exactly where a
  picker matters most (thumbs, trucks). Typed dates are also the feeder for the register's date
  bugs (B59, B91): a picker is both ergonomics _and_ a correctness prophylactic.
- Defaults: `record-payment.tsx` shows today's date only as a _placeholder_ (grey, not
  submitted-by-default text is fine here since blank = today — but check each date field for
  whether blank actually defaults; where it doesn't, the placeholder is a lie).
- Late validation: forms using RHF+zod validate on submit by default — walk long forms
  (`invoices/new/page.tsx`, `CreateOrderModal`) and check which errors could have fired on blur.
- Discarded input: B20 (return condition notes vanish), B88 (PO receive notes collected,
  validated, discarded), B79 (estimate Issue Date required, never sent). The grep: find every
  form field, then find its key in the submitted DTO; a field with no DTO destination is
  collecting garbage.
- Scan ergonomics: order entry supports scan-to-line (`resolveProductByCode` in CreateOrderModal,
  `ScanOrderSheet` on mobile) — verify new list/entry screens keep scan-first focus order and
  don't steal focus after each scan.

---

## Lens 8 · Visual hierarchy & density (the designer's pass)

**Look for:** the most important number on each screen reading first; status colours consistent
and accessible; the operator dashboard scannable at a glance; tables that earn their width on
mobile.

**How to detect here:**

- The system's status language is centralized: `packages/ui/src/web/Badge.tsx` `STATUS_MAP`
  (35 statuses → 5 variants, proper labels). **The audit is finding the screens that bypass it**:
  grep `function statusBadge|statusPill|poBadge|badgeFor` — local re-implementations
  (`dispatch/page.tsx` `statusBadge`, vendor-bills `poBadge`, mobile `statusPill`) are exactly
  where the `PARTIALLY_RECEIVED` drift and raw-string fallthroughs live. A local badge map is a
  future inconsistency with a timestamp.
- Dashboard scannability: `dashboard/page.tsx` leads with six `StatCard`s (Today's Revenue,
  Overdue Invoices, Active Orders, Scheduled Routes, Active Drivers, Low Stock Items). Six equal
  cards = no hierarchy; and two of the six have carried lying data (B25 low-stock ignores reorder
  points; B40 analytics ignored date range, since fixed). The designer question: which _one_
  number does a dispatcher need at 6am, and does it read first? A KPI that can be wrong is a
  hierarchy problem too — prominence multiplies the damage of a lying number.
- Accessibility floor: variant colours pair text-on-tinted-bg (`text-[#15803D]` on
  `bg-success-bg` etc.) — spot-check any _locally invented_ colour pairs against WCAG AA, and
  check no status is conveyed by colour alone (Badge includes a label — local pills sometimes
  don't).
- Tables on small screens: web tables assume width (5–7 columns in vendor-bills/invoices).
  Where a table is reachable at mobile widths, check for an `overflow-x` container or a card
  fallback; a horizontally-cropped money column is a defect, not a style choice.

---

## Lens 9 · Role-appropriate design

Each role's screens must fit the _physical context of use_:

- **Driver (one hand, in a truck, sunlight):** `(driver)/route/stop/[stopId]/index.tsx` is the
  reference implementation — big `QuickAction` tiles (Call/Text/Directions), POD tiles, discrete
  screens per sub-task (photo, signature, note, payment). Audit anything on the driver path that
  demands typing (free-text dates — Lens 7), precision taps, or reading small text. And check the
  promises: B34 ("Skip stop" records nothing), B38 (Cash tab is an empty state), B49 (the at-door
  total itself is wrong) — a beautiful one-handed screen collecting the wrong cash is not
  role-appropriate, it's role-optimized deception.
- **Warehouse (scanner in hand):** B39 — `(operator)/pick.tsx` Pick & Load is a placeholder, so
  the role's core surface doesn't exist; scan-to-order (`ScanOrderSheet`) is the pattern to
  extend. Audit: can every warehouse job be completed without touching the soft keyboard?
- **Office (dense, keyboard-first):** web has real keyboard affordances — `g`+letter nav and
  ⌘K command palette (`(dashboard)/layout.tsx` shortcuts list). Audit new pages for palette
  registration and focus order; a page reachable only by mouse breaks the office contract.
- **Buyer (simple, trust-building):** one-click "Reorder Now", clean empty states. Trust
  auditing = does the portal ever show another seller's data (B77), a raw ID (B19-adjacent), or
  a placeholder map (B43)? A buyer surface may be simple; it may never look abandoned or leak
  internals.

**Detection:** for each role, list its top three jobs, then walk the screens counting
keyboard-touches (driver/warehouse should tend to zero) or mouse-touches (office should tend to
zero). The mismatches are findings.

---

## Lens 10 · Trust & finish

**Look for:** placeholders reachable from production nav; "coming soon" surfaces a paying
operator can hit; decorative controls; anything that whispers "beta".

**How to detect here:**

- `grep -rni "coming soon" apps/mobile/app apps/web/app` — then classify each hit: honestly
  labelled and _out of the nav_ is acceptable; in the nav is not. Verified: `(driver)/cash.tsx`
  is an honest, well-written empty state ("End-of-day cash-up is coming soon") — but it ships as
  a reachable driver tab (B38). Kin: B39 (Pick & Load), B43 (buyer tracking map), B07
  (integrations tab all coming-soon), B08 (migration hub offers connectors it can't run).
- Decorative controls: grep for handlers that are no-ops or state that nothing reads — B01
  (Remember me does nothing), B23 ("+ Add" is decorative), B04 (push toggle registers nothing).
  A control that accepts input and discards it is worse than no control.
- The finish bar for a product that invoices real money: no raw enum in the DOM, no `N/A` where
  a blank or "—" belongs (buyer templates item notes render literal "N/A"), no dead hover
  states, no self-dismissing confirmations. Each is small; a screen with three of them reads as
  unfinished, and operators extrapolate finish to correctness — _"if they didn't polish the
  button, did they test the math?"_

---

## Prioritisation rubric

Rank experience findings on **frequency × friction × blast radius**:

- **Frequency** — how many times per day does the affected job run? Phone-order entry and driver
  stops run dozens of times daily per tenant; settings screens run once. A 2-click detour on
  order entry outranks a dead tab in settings.
- **Friction** — seconds lost, errors invited, or trust burned per occurrence. Scale: mild
  (extra click) → moderate (page detour, retyped data) → severe (work discarded, wrong data
  displayed, dead end mid-job).
- **Blast radius** — who is affected and what do they do next? A buyer-facing defect radiates to
  the tenant's _customers_; a driver defect corrupts the delivery record; an operator defect
  wastes staff time. Buyer > driver > operator > platform-admin, all else equal.

**Against correctness bugs:** a correctness bug that writes wrong money or destroys data always
outranks a pure-experience defect of similar frequency — the register's severity ladder already
encodes this. But apply the disguise test first:

**When a UX defect is a correctness defect in disguise** — always re-classify before ranking:

- "This date field is confusing" → the field silently rolls the date back a day (B59, B91).
- "One-click reorder is convenient" → it bills the wrong price (B48).
- "The Partial filter shows an error" → the client sends an enum value the API doesn't have
  (this reference, Lens 2) — and the same wrong literal _gates the receive action on mobile_,
  which is a stuck-inventory workflow bug, not a copy nit.
- "The merge button feels abrupt" → the surviving record is chosen by Set-iteration order.
  The tell: if reproducing the friction leaves the _database_ different from what the user
  intended, it's a correctness bug wearing a UX costume. Route it to the correctness classes and
  verify it there.

**Severity mapping for pure-experience findings** (register scale): `high` = a frequent job is
blocked or a record lies to the user's face · `medium` = broken promise, dead end, or detour on
a real workflow · `low` = cosmetic, dead code, honest placeholder. Experience findings are
rarely `critical` — unless the disguise test just told you it isn't an experience finding.

## What NOT to report

- **Taste-only preferences.** "I'd use a drawer instead of a modal", spacing and font opinions,
  colour preferences within accessible contrast. If two competent designers could disagree, it's
  not a finding.
- **Redesigns nobody asked for.** "The dashboard should be reorganized around X" is a proposal,
  not a defect. File defects against the current design's own promises.
- **Cosmetic nits with no user cost.** A 1px misalignment, an inconsistent icon that misleads
  nobody. Batch these into a polish note if they cluster; never as register entries.
- **Honestly-labelled unfinished work, once.** The register already carries B07/B38/B39/B43;
  don't re-report each "coming soon" screen every round — report _new_ placeholders and any
  placeholder newly promoted into a nav.
- **Enhancements dressed as bugs.** "There could be a bulk edit here" belongs in the user
  guide's suggestions chapter. The bar is unchanged: a finding is a broken promise, wasted
  time, misleading state, or a dead end — with `path` + symbol evidence a verifier can refute.
