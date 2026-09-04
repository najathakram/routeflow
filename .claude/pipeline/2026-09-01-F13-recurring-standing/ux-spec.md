# UX Spec: F13 · recurring-template edit page, list-card outcome, standing-order item edit

> Authored by Fable 5 on 2026-09-01. Status: APPROVED (autonomous campaign batch).
> This file is the ONLY context the implementation, review and UI-verification agents
> receive. Companion cache: `.claude/pipeline/design-system.md` (derived 2026-08-31) — cited,
> not repeated. Requirements served: [spec.md](./spec.md) R16, R17, R22, R26, R27, R28.
> **Zero new tokens, zero new primitives.** Every surface below reuses a pattern that already
> ships in the same file or its sibling; the one new route reuses the existing create form.

## Job to be done

- **Who:** tenant operators (web dashboard, `surface-operator`), a few times a month; mobile
  operators for the outcome line only.
- **What job:** "fix my recurring template / standing order without deleting it, and see
  whether last night's run actually billed."
- **Why now:** discovery.md §1 — today the edit either does not exist (B92) or silently drops
  the items (B09), and a failed cycle looks like success (B106).
- **Current workaround being replaced:** delete + recreate. If this ships half-built (an edit
  page that saves but the list card has no link to it) the workaround simply continues —
  R27 is therefore not optional.

## Entry points & exits

- **Recurring edit page** ← `/invoices/recurring` card **Edit** button (R27); ← direct URL
  `/invoices/recurring/<id>/edit` (deep link, bookmark). Unauthenticated → the dashboard
  layout's existing login redirect. Unknown id → the error card (below).
  → `/invoices/recurring` on Save success or Cancel/back link.
- **Standing-order modal (edit mode)** ← customer page → "Standing Orders" tab → pencil
  button `title="Edit template"` (existing). → closes on Save success or Cancel (existing).
- **List card outcome** — no entry/exit; it is part of the existing list.
- **Mobile recurring detail** — existing screen; one added line.

## Screen inventory

| Screen                                    | Route / path                                                                                             | Purpose                                     | Primary user    | R#       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------- | -------- |
| Recurring invoices list (card changes)    | `/invoices/recurring` — `apps/web/app/(dashboard)/invoices/recurring/page.tsx`                           | show last-run outcome; link to edit         | operator        | R16, R27 |
| Recurring template edit                   | `/invoices/recurring/[id]/edit` — `apps/web/app/(dashboard)/invoices/recurring/[id]/edit/page.tsx` (NEW) | edit schedule / lines / notes / adjustments | operator        | R26, R28 |
| Recurring template create (refactor only) | `/invoices/recurring/new` — `new/page.tsx`                                                               | unchanged behavior; renders the shared form | operator        | R28      |
| Shared form                               | `apps/web/app/(dashboard)/invoices/recurring/_components/RecurringInvoiceForm.tsx` (NEW)                 | the one form both routes render             | —               | R28      |
| Edit Standing Order modal                 | customer page tab — `apps/web/app/(dashboard)/customers/[id]/StandingOrderModal.tsx`                     | persist item edits                          | operator        | R22      |
| Mobile recurring detail                   | `apps/mobile/app/(operator)/recurring-invoices/[id].tsx`                                                 | outcome pill (severable)                    | mobile operator | R17      |

## Per-screen anatomy

### Screen: Recurring invoices list — card

- **Regions (unchanged order):** header · card grid → per card: name row (customer +
  Active/Paused pill) · schedule line · items/auto-send line · dates block (`Next run`,
  `Last run`) · **[new] failure line** · actions row.
- **Changes:**
  1. `Last run` value becomes `<date> <pill>` — pill only when `lastRunStatus` is
     `"SUCCESS"` (**Succeeded**) or `"FAILED"` (**Failed**); `null` → date only.
  2. When FAILED and `lastError` is set: one line under the dates block,
     `text-xs text-danger`, `truncate`, `title={lastError}`: `{lastError} — use Run Now to
retry.`
  3. Actions row gains an **Edit** button between Run Now and the pause toggle:
     `<Button size="sm" variant="secondary" leftIcon={<Pencil className="h-3.5 w-3.5" />}
href={`/invoices/recurring/${ri.id}/edit`}>Edit</Button>`. Run Now keeps `flex-1`.
- **Visual hierarchy:** 1st the customer name, 2nd the Failed pill (danger colour is the
  only red on the card), 3rd the actions.
- **Primary action:** unchanged (Run Now). **Secondary:** Edit, pause/activate.
- **Destructive:** none added.
- **Pill markup** — the SAME in-file pattern as the Active/Paused pill (`page.tsx:135-144`):
  `<span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium bg-success-bg
text-success">Succeeded</span>` / `… bg-danger-bg text-danger">Failed</span>`. Not the
  `Badge` primitive: the card already uses this ad-hoc pill and mixing the two styles on one
  card would be the inconsistency.

### Screen: Recurring template edit (NEW route)

- **Regions (DOM order):** back link `← Recurring Invoices` · `<h2>` **Edit Recurring
  Template** · the shared form (2-column grid `lg:grid-cols-5`, byte-copied from `new/page.tsx`):
  left — Customer card (**read-only** in edit mode: business name + contact, no search, no
  remove control), Schedule card, Line Items card, Notes & Terms card; right — Adjustments
  card, submit card (**Save Changes** primary + **Cancel** secondary `href="/invoices/recurring"`).
- **Loading:** full-page `Loader2 h-8 w-8 animate-spin text-navy/70` centred (design-system
  loading pattern 2, `orders/[id]/page.tsx:1691-1694`).
- **Error:** `Card` with `<p className="text-sm text-navy">This recurring template could not be
loaded.</p>` and a `Button variant="secondary" href="/invoices/recurring">Back to Recurring
Invoices</Button>`.
- **Primary action:** Save Changes. **Secondary:** Cancel. **Destructive:** none (pause/delete
  stay on the list).
- **Prefill mapping (edit):** `frequency`; `dayOfWeek ?? 1`; `dayOfMonth ?? 1`; `autoSend`;
  `nextRunAt.slice(0,10)` into the date input (label reads **Next Run Date** in edit mode,
  **First Run Date** in create mode); `notes ?? ""`; `terms ?? ""`; `String(discount ?? 0)`;
  `String(shippingFee ?? 0)`; items → one row each (`description`, `productId`, `qty`,
  `unitPrice`, `taxRate ?? 0`, `discount ?? 0`), keyed by index.
- **Submit (edit):** the form emits the same DTO shape as create; the page strips
  `customerId` and calls `useUpdateRecurringInvoice().mutate({ id, ...dto })`.

### Screen: Edit Standing Order modal (edit mode)

- **No visual change.** The item section already renders in edit mode; the ONLY change is
  that Save Changes now sends `items` (full list) — so what the operator sees is what saves.
- **Copy unchanged:** title "Edit Standing Order", button "Save Changes", toast "Standing
  order updated".

### Screen: Mobile recurring detail (severable)

- Under the existing dates `Text` (`[id].tsx:121-125`), when `lastRunOutcome(template)` is
  non-null: `<Pill variant={outcome.variant} dot>{outcome.label}</Pill>` and, when
  `outcome.detail`, a `Text style={styles.dates}` with the error text. Labels: **Last run
  succeeded** / **Last run failed**.

## State set — per screen (only rows that change; everything else is the existing behavior)

| Screen       | State             | Trigger                                                                                                         | What's shown                                                                  | Recovery                    |
| ------------ | ----------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------- |
| List card    | Outcome SUCCESS   | `lastRunStatus === "SUCCESS"`                                                                                   | green **Succeeded** pill after the date                                       | —                           |
| List card    | Outcome FAILED    | `lastRunStatus === "FAILED"`                                                                                    | red **Failed** pill + danger line `{lastError} — use Run Now to retry.`       | Run Now (same card)         |
| List card    | Outcome none      | `lastRunStatus` null/undefined                                                                                  | date only, no pill; no `Last run` row when `lastRunAt` is null (existing)     | —                           |
| Edit page    | Loading           | query in flight                                                                                                 | full-page spinner                                                             | —                           |
| Edit page    | Error / not found | query error or empty                                                                                            | error card + back button                                                      | back to list                |
| Edit page    | Default           | template loaded                                                                                                 | prefilled form, customer read-only                                            | —                           |
| Edit page    | Validation error  | client `validate()` (existing rules: next-run date required, ≥1 item, every item has a description and qty > 0) | inline `text-xs text-danger` messages (existing)                              | fix + resubmit              |
| Edit page    | Save failed       | PATCH 4xx/5xx                                                                                                   | toast `Failed to update template` + server message (existing `onError` shape) | form stays filled; resubmit |
| Edit page    | Success           | PATCH 200                                                                                                       | toast `Recurring template updated` → list                                     | —                           |
| Edit page    | Unauthorized      | 401/403                                                                                                         | existing layout redirect / error toast                                        | —                           |
| Edit page    | Concurrent edit   | another operator saved first                                                                                    | last-write-wins (API)                                                         | —                           |
| Modal (edit) | Success           | PATCH 200                                                                                                       | toast `Standing order updated`; modal closes; tab count updates               | —                           |
| Modal (edit) | Error             | PATCH 400 (e.g. unknown product)                                                                                | existing red banner with the server message                                   | edit + resubmit             |

## Interaction & validation

- **Edit page** reuses the form's existing `validate()` verbatim (customer check is skipped in
  edit mode — the customer is fixed). Errors clear on resubmit (existing behavior).
- **Double-submit:** `Button loading={isPending}` disables the primary; Cancel gets
  `disabled={isPending}` (both existing on the create page).
- **Pessimistic updates** everywhere (mutations invalidate `["recurring-invoices"]` /
  `["order-templates", …]` on success — existing hooks).
- **Modal (edit):** unchanged interaction; the payload adds `items`.

## UI copy

| Element                | Copy                                                                                   | Notes                                |
| ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------ |
| Card pill (success)    | `Succeeded`                                                                            | text-only pill                       |
| Card pill (failure)    | `Failed`                                                                               |                                      |
| Card failure line      | `{lastError} — use Run Now to retry.`                                                  | `truncate`, full text in `title`     |
| Card Edit button       | `Edit`                                                                                 | accessible name "Edit" (icon + text) |
| Edit page heading      | `Edit Recurring Template`                                                              | page title (`setTitle`) identical    |
| Edit page back link    | `Recurring Invoices`                                                                   | same as create                       |
| Date label (edit mode) | `Next Run Date`                                                                        | create mode keeps `First Run Date`   |
| Customer card (edit)   | business name + contact name, no controls                                              |                                      |
| Primary button (edit)  | `Save Changes`                                                                         | create keeps `Create Template`       |
| Cancel                 | `Cancel`                                                                               |                                      |
| Success toast (edit)   | `Recurring template updated`                                                           |                                      |
| Error toast (edit)     | title `Failed to update template`, description = server message or `Please try again.` |                                      |
| Error card             | `This recurring template could not be loaded.` + button `Back to Recurring Invoices`   |                                      |
| Mobile pill            | `Last run succeeded` / `Last run failed`                                               | detail line = `lastError` verbatim   |

## Responsive behavior

Same as the create page: `grid-cols-1` below `lg`, `lg:grid-cols-5` at ≥ 1024px (stock
Tailwind `lg`, no custom breakpoints — design-system.md "Spacing"). The card's actions row is
a flex row; with the third control it stays on one line at the card's minimum width (`md:` two
columns, `xl:` three) because Edit is `size="sm"` like Run Now.

## Accessibility

- Pills are plain text inside the `Last run` row — read in order "Last run, <date>, Succeeded".
- **Edit** is a `Button href` (renders an anchor) with visible text — keyboard reachable in the
  card's tab order after Run Now.
- Edit page: identical labels/focus order to the create page; the read-only customer block is
  static text (no tab stop). Contrast: `text-danger` on white and `bg-danger-bg` are the
  repo's existing status colours (design-system.md tokens).
- Mobile: `Pill` is the existing component; the error line is plain `Text`.

## Motion

None added (no new transitions; design-system.md: no framer-motion, Tailwind `transition-colors`
only on hover states — unchanged).

## Design-system compliance

| Token / component                                                                                                       | Used for          | Source                                                                                                   | New? |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------- | ---- |
| in-file pill `rounded-full px-2 py-0.5 text-xs font-medium` + `bg-success-bg text-success` / `bg-danger-bg text-danger` | outcome pills     | `invoices/recurring/page.tsx:135-144` + tokens `success`/`danger` (`packages/config/tailwind.config.ts`) | no   |
| `text-xs text-danger`                                                                                                   | failure line      | design-system.md "Inline validation"                                                                     | no   |
| `Button size="sm" variant="secondary" href leftIcon`                                                                    | Edit              | `packages/ui/src/web/Button.tsx`                                                                         | no   |
| `lucide-react` `Pencil`                                                                                                 | Edit icon         | already imported in `customers/[id]/page.tsx`                                                            | no   |
| `Loader2 h-8 w-8 animate-spin text-navy/70`                                                                             | edit-page loading | design-system.md loading pattern 2                                                                       | no   |
| `Card`, `useToast`, `usePageTitle`                                                                                      | edit page         | existing                                                                                                 | no   |
| `Pill` (mobile) with `variant "green"/"red"`                                                                            | mobile outcome    | `packages/ui` mobile ios kit, variants already used by `recurringPillFor`                                | no   |

## Playwright verification flows

Carried into test-plan.md §8 (these run ONLY post-deploy — never locally; see test-plan §6).

1. Given an operator on `/invoices/recurring` with a throwaway template, When they click that
   card's **Edit**, Then the URL is `/invoices/recurring/<id>/edit` and the heading reads
   "Edit Recurring Template" with the customer name shown read-only — proves R26/R27, state
   _default_.
2. Given the edit page, When Frequency is changed to Weekly and Notes typed and **Save
   Changes** clicked, Then the toast "Recurring template updated" shows, the URL returns to
   `/invoices/recurring`, and the API reports `frequency WEEKLY` + the notes — proves R26,
   state _success_.
3. Given the list, When **Run Now** is clicked on that card, Then after the invoice page
   opens and the list is revisited the card shows the **Succeeded** pill — proves R16 (SUCCESS
   leg).
4. Given a customer page's Standing Orders tab with a one-item template, When the operator
   opens Edit, adds a second product, bumps the first's qty to 2 and saves, Then the toast
   "Standing order updated" shows and the API reports both items with those quantities —
   proves R22.
5. (Reviewed, not driven) FAILED pill + error line — no automated way to force a create
   failure on the deployed test tenant; verified by the lens against the render branch and by
   the T1 API proof that the fields are written.
