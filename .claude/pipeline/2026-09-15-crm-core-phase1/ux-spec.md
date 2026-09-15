# UX Spec: CRM core Phase 1 — leads, tasks, timeline

> Fable 5.1 · 2026-09-15 · DRAFT · S3 · Prev [spec.md](./spec.md).
> DS = [`design-system.md`](../design-system.md). **Binding:** only what DS lists —
> no new token, component, dependency, asset or Frappe look (R29); each web screen names its R30
> neighbour; `acme` placeholders (R33).

**Job:** OPERATOR/TENANT_ADMIN rep, daily — note a courted business, log contacts, set the next
step, convert on yes (discovery §1-3). **In:** nav **CRM** (R27), Customer › Timeline tab, deep link,
mobile More. **Out:** Convert → `/customers/{id}`; back; role deny → `/dashboard`.

## Screen inventory

| Screen | Route | Neighbour (R30) | R# |
|---|---|---|---|
| Leads list | `/crm/leads` | `customers/page.tsx` | R4-5, R21, R27, R30 |
| Lead detail | `/crm/leads/[id]` | `suppliers/[id]/page.tsx` + `customers/[id]` comments tab | R6-11, R13, R17-20, R29 |
| Tasks | `/crm/tasks` | `sales-agents/page.tsx` | R14-15, R30 |
| Customer › Timeline | `/customers/[id]?tab=timeline` | its `comments` tab (`customers/[id]/page.tsx:1467`) | R18, R30 |
| Mobile leads/detail/timeline/tasks | `(operator)/crm/*` | `credit-notes/index.tsx`, `customers/[id].tsx`, `customers/[id]/comments.tsx` | R31 |

## Anatomy (imports `@routeflow/ui/web` unless noted)

**Leads list** — `PageHeader` ("Leads", "{n} leads", `Button` "New lead") → filter
bar (`sales-agents:164`): search + `useUrlSearch`, `Select` Stage, `Select` Status (Open/Qualified/
Lost/Converted/All), raw checkboxes Mine, Show archived (`sales-agents:174`) → `Table` (Business,
Contact, Stage `Badge variant+label`, Owner, Last activity, Updated) → "Load more" button.

**Lead detail** — back button, `Building2` tile, name, status `Badge` (`suppliers/[id]:463`);
right: `Select label="Stage"` (**stage picker**, R29), `Button` "Convert to customer", `secondary`
"Edit", `ghost` "Archive". Body `grid gap-5 lg:grid-cols-3`: `Card` "Details" |
`lg:col-span-2` `Tabs` **Timeline (n) · Tasks (n)**. Timeline = composer (`Textarea`
"Add a note…", `Select` Kind Note/Call [+ Outcome], `Button` "Add note") + `<ol>` of comment-card
rows (`customers/[id]:1527-1556`), icon per kind: NOTE `MessageSquare`, CALL `Phone`, STATUS_CHANGE
`ArrowRightLeft`, TASK_DONE `CheckCircle2`, SYSTEM `Clock`, message `Mail`. CONVERTED:
Stage `disabled`, Convert → `Button href="/customers/{id}"` "Open customer".

**Tasks** — `PageHeader` "Tasks" ("New task") → checkbox **Mine** (default on = `mine=1`), `Select`
Status → four `.overline` headings **Overdue · Today · Upcoming · No date**, each a
`Table` (☐ raw checkbox `aria-label="Complete: {title}"`, Title, Subject, Due, Assignee, Priority
`Badge`); DONE rows: checked + link "Reopen".

**Customer › Timeline** — one more `<TabTrigger value="timeline">` after `comments`
(`customers/[id]:2362-2367`, icon `Clock`) + `<Tabs.Content>` with the same Timeline composite
(`crm/_components/Timeline.tsx`, `customerId`). Nothing else on that page changes.

**Nav (R27)** — `DashboardShell` (`layout.tsx:1094-1150`) splices
`{kind:"group",label:"CRM",icon:Contact,children:[Leads /crm/leads Contact, Tasks /crm/tasks
CheckSquare]}` after Sales Agents when `useHasAddon("crm_core")`, and `{kind:"skeleton",key:
"crm-skeleton"}` (rendered `:552-566`) while `addonsLoading`, as `sales-agents-skeleton` (`:1127-1136`).
Never for `!isStaff`.

**Mobile (R31: Jest logic tests + design review, no screenshots)** — `crm/index.tsx`: `NavBar
largeTitle="Leads"` + `NavAction "New"`, `SearchBar`, `FilterChipRow`, `RefreshControl`,
`ListRow{title,subtitle,trailing:<Pill>}` (`@routeflow/ui/mobile/ios`).
`crm/[id].tsx`: `NavBar inlineTitle` + `NavBackButton label="Leads"` + `NavAction "Convert"`;
Call/Text/Email row (`customers/[id].tsx:145`); `ListGroup` DETAILS · TASKS · ACTIVITY. **Log a
call:** after `Linking.openURL("tel:")`, `chooseAction("Log this call?", "acme Traders", [Reached,
No answer, Left voicemail, Cancel])` (`lib/confirm.ts:68`) → POST CALL. `timeline.tsx` mirrors
`comments.tsx`; `tasks.tsx` four `ListGroup` headers; `new-task.tsx` `MobileInput`/`MobileButton`.
More: `ListRow "Leads"` when `useHasAddon("crm_core")` (`more.tsx:164`); `SECTION_TO_TAB.crm=
"more"`. Loading `ActivityIndicator` (operator convention).

## State set (every web surface; mobile where noted)

| State | Shown (exact copy) | Recovery |
|---|---|---|
| Empty, unfiltered | `EmptyState variant="customers"`. Leads **"No leads yet"** / "Add a lead to start tracking prospects before they become customers." / **"New lead"**. Tasks **"No tasks due"** / "You're all caught up. Add a task on a lead or customer and it shows up here." / **"New task"**. Timeline **"No activity yet"** / "Notes, calls and stage changes will appear here." / **"Add note"**. Mobile "No leads yet." + "Add lead", "No tasks due.", "No activity yet." | primary action |
| Empty, filtered | **"No leads match"** / "No leads match your current search and filters." / **"Clear filters"**; **"No tasks match"**; mobile "No leads match." | Clear filters |
| Loading | `Table isLoading`; detail bar + 3 pulse cards (`suppliers/[id]:399`); timeline 3 pulse cards; addon resolving centred `Loader2` (`sales-agents:133`) | — |
| Partial (R18) | rows render under a `role="alert"` amber box (`routes/page.tsx:246`) **"Couldn't load {messages\|comments\|activities} — the rest of the timeline is shown."** + link "Try again" | refetch timeline |
| Error, read | danger banner (`customers/page.tsx:941`) **"Couldn't load leads."** / "…tasks." / "…the timeline." + `secondary sm loading={isRefetching}` **"Try again"** (`payment-requests:306`); detail 404 **"Lead not found."**. Mobile "Couldn't load leads. Pull to retry." | Try again / pull |
| Error, mutation | global toast (`providers.tsx`) with server `message`; optimistic rows roll back; form stays open | resubmit |
| Cap 403 (R20) | **Default = scoped to the convert call only** (spec Q5): its `onError` renders the warning toast, title `data.message`, description `upgradeHint(data)` (export from `PlanGateNotice.tsx:52`), `action` **"Choose a plan"** → `/choose-plan`. The global alternative — a `PLAN_GATE` branch in `providers.tsx` `MutationCache.onError` mirroring `READ_ONLY` (`:44-52`) — would touch **every** mutation in the app and is **not** taken without the lead's word | Choose a plan |
| Unauthorized | DRIVER/CUSTOMER URL → existing `router.replace("/dashboard")` (`layout.tsx:305-313`) — **no 403 page exists**; spec §4 corrected to say so. The API still 403s (R23), unchanged. Ungranted tenant at URL: `LockedPage gate={{code:"PLAN_GATE",message:"CRM isn't enabled for this workspace."}} title="CRM"` over `<Card className="h-64"/>` (`sales-agents:141`) | — |
| Offline | web: **no pattern exists** — reads → Error; writes get the axios "Network Error" toast, no queue. Mobile: the interceptor queues every non-FormData mutation, toast "You are offline. Action queued." (`api-client.ts:120-166`); a TIMEOUT is not queued (REG-B196). Convert is idempotent (R19); notes and tasks are not, so **R34** requires replay not to duplicate. Spec §4 has been corrected to match the shipped behaviour — no ruling outstanding | — |
| Too much data | 50/page + **"Load more"** (`Loader2`, disabled while fetching); cursor pages accumulated in state (`OrderPickerPanel:51-78`) | Load more |
| Stale | `staleTime 30s` + invalidation; `refetchOnWindowFocus` **false globally** (`providers.tsx:67`), never overridden — CRM does not become the exception. Spec §4 corrected to match; no ruling outstanding | reload |
| Concurrent | edits last-write-wins (R6); stage change on CONVERTED → 409 toast + refetch | — |
| Success | toasts **"Lead created"**, **"Lead updated"**, **"Lead archived"** (+Undo), **"Task completed"** (+Undo), **"Task reopened"**, **"Note added"**, **"Call logged"**, **"Converted to customer"**; mobile `showToast` same | — |

## Interaction, validation, copy

- **Lead form** (RHF+zod `Modal` as `customers/_components/CustomerFormModal.tsx`; R1-2, R12): none of business/first/last/email → under Business name **"Add a business name, a contact
  name or an email."**; **"Enter a valid email address."**; website auto-`https://`. Validate on
  submit; `Button loading` "Create lead" / "Save changes".
- **Duplicate (R21)**, pre-submit on email/phone blur: `role="alert"` amber box in the form
  **"Possible duplicate — {n} existing {lead|customer}{s} share this email or phone:"** + ≤3 links
  "acme Traders · customer". Never blocks.
- **Stage picker (R29)**: native `Select` — Tab, arrows, change → PATCH (optimistic Badge, rollback);
  no confirm on any stage (R7 has none).
- **Convert**: `ConfirmDialog variant=secondary` **"Convert to customer?"** / "acme Traders becomes a
  customer with its own login. Notes, calls and tasks move with it. This can't be undone." + `Select`
  "Link to an existing customer" (R20, from R21 matches) / **"Convert"** (`loading`). Pessimistic.
- **Archive**: **"Archive this lead?"** / "acme Traders leaves the list. You can restore it from Show
  archived." / "Archive"; hidden on CONVERTED (R11). **Tasks**: per-row optimistic complete via
  `mutateAsync(id)` (L-147) + Undo; Reopen idempotent.
- Labels = R1 fields in Title case + Note · Kind · Outcome · Task title · Due date · Assignee ·
  Priority. Placeholders **"Search leads…"**, **"Search tasks…"**, **"Add a note…"**.

## Responsive (stock Tailwind `sm 640 / md 768 / lg 1024`)

**1440**: rail `lg:w-60` (`layout.tsx:1314`), detail `lg:grid-cols-3`. **768**: hamburger + drawer
(`layout.tsx:693, 1363`), detail one column, filters `flex-wrap`, tables `overflow-x-auto`. **390**:
drawer, PageHeader action wraps, toast `max-w-[calc(100vw-2rem)]`.

## Accessibility (WCAG 2.2 AA, DS default) · Motion (DS only)

Focus order: back → name → Stage → Convert → Edit → Archive → Details → Tabs → composer → rows →
Load more. All controls labelled (`label`/`aria-label`); DS focus rings.
Keyboard: Tab to Stage, arrows change; Enter on Convert → Radix dialog traps focus → Tab "Convert"
→ Enter. Timeline `<ol aria-label="Activity timeline">`,
`<li>` + `<time dateTime>` + sr-only kind ("Note", "Call", "Stage change"); warnings `role="alert"`;
skeletons `aria-hidden`. Targets: `size sm` 28px, rows 44px. Motion (DS): `transition-colors` 150ms,
Radix `animate-in fade-in-0 zoom-in-95`, `animate-pulse`; reduced-motion via `.skeleton`.

## Design-system compliance

| Item | Source | New? |
|---|---|---|
| `PageHeader Button Badge Input Textarea Select Modal Table Tabs EmptyState useToast Card cn` | `packages/ui/src/web/index.ts` | no |
| `ConfirmDialog`, `LockedPage`, `upgradeHint`; `.overline`, danger banner, amber alert, load-more, checkbox classes | `components/{ConfirmDialog,PlanGateNotice}.tsx`, `_components/gates/PlanGates.tsx`; `globals.css`, `customers/page.tsx:941`, `routes/page.tsx:246`, `OrderPickerPanel:164`, `sales-agents:174` | no (export `upgradeHint`; copied markup) |
| `crm/_components/Timeline.tsx`; mobile primitives + `ios.*`; lucide names already imported | rows above; `packages/ui/src/mobile/**`; DS §Icons | app composite only, no DS change |

## Playwright flows (`page.setViewportSize` as `e2e/47:67`; `loginAsOperator`, `TENANT_SLUG`; 1440 unless noted)

1. `crm_core` off → nav lacks "CRM"; `/crm/leads` → "Not on your plan" — R27.
2. `crm_core` on → `.skeleton` rail row until addons settle, then "CRM", no rail growth — R27.
3. No leads → "No leads yet" + "New lead"; `?q=zzz` → "No leads match" + "Clear filters" — R30 empty (1440/768/390).
4. Route aborted → "Couldn't load leads." + "Try again"; unabort → rows — R30.
5. 60 leads → 50 rows + "Load more" → 60 — R5.
6. New lead with a customer's email → "Possible duplicate" pre-submit; creates anyway — R21 (1440/390).
7. Keyboard only: Tab to Stage, ArrowDown → Badge "Qualified" + "Stage change" row — R7 R17 R29.
8. Convert → `/customers/{id}` + toast; revisit lead: Stage disabled, "Open customer" — R19.
9. Convert mocked 403 PLAN_GATE → warning toast, server message, "Choose a plan" — R20.
10. Timeline mocked `warnings:["Message"]` → rows + "Couldn't load messages…" — R18 (1440/768).
11. `/crm/tasks` → four `.overline` groups, Mine checked; check → "Task completed" + Undo; Reopen; mocked 500 → rollback + error toast — R14-15 R30 (1440/390).
12. DRIVER session at `/crm/leads` → URL `/dashboard` — R23.
13. Customer page → "Timeline" tab after "Comments" → "No activity yet" — R18 R30 (1440/768).
