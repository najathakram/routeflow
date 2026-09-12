# UX spec — Settings → GoHighLevel tab, operator bell entry

- **Status:** IMPLEMENTED (2026-09-12) · covers **R29–R31** of `spec.md` · design tokens: `.claude/pipeline/design-system.md`
  (repo cache — never invent a token; use the existing Card / Badge / Button / Input / Select / Switch / Table /
  toast primitives already used by `settings/page.tsx` and `settings/_components/StripeConnectCard.tsx`).
- Audience: a non-technical operator. Copy is plain English; no API words ("token" is called "connection key",
  "location id" is "GoHighLevel account ID", "opportunity" is "lead", "pipeline stage" is "stage").

## Entry points

1. **Settings hub** (`SettingsHub.tsx`, Integrations group): new item `GoHighLevel` — desc "Create customers
   from won leads" — href `/settings?tab=gohighlevel`.
2. **Tab** `gohighlevel` in `settings/page.tsx` `SECTIONS`: `{ title: "GoHighLevel", node: <GoHighLevelSettingsTab />,
width: "max-w-4xl" }`.
3. **Bell** (`layout.tsx` notifications dropdown): entry type `crm`, icon = the existing users/contact icon
   family, title "New customer from GoHighLevel", description "<name> — finish onboarding", clickable → `/customers/<id>`.

## Tab layout (top → bottom, single column, cards)

### Card 1 — Connection

- Header: "Connection" + status **Badge**: `Not connected` (neutral) · `Connected` (success) ·
  `Needs attention` (warning) · `Disconnected` (neutral).
- Body when not connected / disconnected: two inputs — "Connection key" (password field, paste, never
  pre-filled) and "GoHighLevel account ID" (text) — helper line: "Create the key in GoHighLevel: Settings →
  Private Integrations → Create new integration. Tick: Contacts (read + write), Opportunities (read),
  Custom fields (read + write), Location (read). Copy it once — it is shown only once." Link "Setup guide"
  (opens `docs/runbooks/gohighlevel-client-setup.md` rendered at the existing help route if one exists;
  otherwise plain external link to the repo doc is NOT acceptable — render the steps inline in a collapsible
  "How do I get a key?" section instead).
- Primary button "Save & test". On success: toast "Connected to <locationName>", badge → Connected, inputs
  collapse into a summary line "Account: <locationName> · key ending in ····<last4>" with a "Replace key"
  link (re-opens the two inputs) and a "Disconnect" ghost button (confirm dialog: "RouteFlow will stop
  creating customers from GoHighLevel. Existing customers are kept.").
- On 401: badge → Needs attention, inline error "GoHighLevel rejected this key. Create a new one and paste it
  here." On other failure: inline error with the reason; badge unchanged.
- Banner (top of tab) when status is Needs attention: warning banner "RouteFlow lost access to GoHighLevel.
  Paste a new connection key below." with a "Test again" button.

### Card 2 — When does a lead become a customer? (disabled until Connected)

- Radio: **"When a lead reaches a stage"** (default) → two Selects: Pipeline (from `GET /pipelines`), Stage
  (stages of the chosen pipeline). **"When a lead is marked Won"** → selects hidden.
- Helper: "Only leads that reach this point after <startFrom date> are added. Older ones can be imported
  below."
- Date input "Start from" (default = connection date; editable).
- Save button (disabled until changed); toast "Saved".
- Empty state for pipelines (none returned): "No pipelines found in this GoHighLevel account."
- Error state (pipelines fetch failed): inline retry.

### Card 3 — Options (disabled until Connected)

- Switch **Preview mode** (default ON) — helper "Nothing is created yet. Review the list below, then turn
  this off." When ON, a soft info banner sits above the log: "Preview mode is on — customers are not created."
- Switch group "Write back to GoHighLevel": "Add tag routeflow-customer" · "Fill RouteFlow fields on the
  contact" · "Add a note with the customer link" (all default ON) · "Mark the lead as Won" (default OFF,
  helper: "Requires the Opportunities write permission on the key").
- Switch **Enabled** ("Create customers automatically") — default OFF; cannot be turned on while trigger
  is STAGE and no stage is chosen (switch disabled + helper "Choose a stage first").
- Save button; toast "Saved".

### Card 4 — Activity

- Header row: "Activity" · "Last checked <relative time>" (or "Never") · button **"Check now"** (runs
  `POST /sync`; spinner; toast "Checked GoHighLevel: <new> new, <created> created, <linked> linked,
  <needsReview> need review" — or in preview mode "<dryRun> previewed").
- Stale warning (enabled and lastPollAt > 10 min ago): small warning text "Automatic checks seem delayed."
- Filter chips: All · Needs review · Created · Linked · Preview · Failed.
- Table (responsive: on < 640 px collapse to stacked rows): Lead (opportunityName) · Contact (contactName)
  · Result (Badge: Created / Linked / Preview / Needs review / Pending / Failed / Skipped) · Details
  (matchedBy as "Existing customer matched by email/phone/name/link", or the reason in plain words:
  `no-identity` → "No email or phone on the contact"; `identity-conflict` → "Email or username already used
  by a staff account"; `customer-cap` → "Customer limit reached"; `contact-not-found` → "Contact deleted in
  GoHighLevel"; `create-failed` → "Could not create the customer"; write-back reasons → "Created; still
  updating GoHighLevel") · When (relative) · Actions: link "Open customer" when `customerId`; "Retry" on
  Preview / Needs review / Failed / Pending-writeback; "Dismiss" on Needs review / Failed / Preview.
- Empty state: "No leads yet. When a lead reaches <stage>, it appears here." (or "…is marked Won").
- Loading: skeleton rows (3). Error: inline retry. Pagination: "Load more" (page size 25).
- Section **Import existing leads**: button "Preview existing leads" → shows "<count> leads are already at
  <stage> and not in RouteFlow" + a list of up to 20 (lead, contact, email, phone) + "Import these" button
  (confirm dialog; in preview mode the copy says "Preview these"). Count 0 → "Nothing to import."

## States checklist (every surface)

empty · loading · partial (Pending / Created-still-updating) · error (inline + retry) · offline (existing
global handling) · unauthorized (the existing add-on 403 message from `AddonGuard`; the tab shows the
existing "This add-on is not enabled" card pattern) · too-much-data (paginated log) · stale (delayed checks
warning) · concurrent edit (last save wins; no optimistic UI).

## Accessibility

Every control labelled; the connection key input is `type="password"` with an explicit "Show" toggle; badges
carry text, never colour alone; the table has a caption "GoHighLevel activity"; dialogs are the existing
Radix dialog (focus trap, Esc); toasts announce via the existing toast container (assert through the
container in tests, L-076); links have discernible names ("Open customer <name>").

## Copy that must appear verbatim (tests pin these)

"Connection" · "Save & test" · "Connected to " · "Needs attention" · "Preview mode" · "Check now" ·
"Import existing leads" · "New customer from GoHighLevel" · "finish onboarding".

## Out of scope

Mobile app · dark-mode-specific art · any change to the customer detail page other than the existing tag chips.
