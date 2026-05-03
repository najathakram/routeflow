# RouteFlow Deep-Audit Master Prompt — Practical-Usage Stress Test

> Drop into a fresh L3 session.
> Surface under test: https://routeflowmobile-production.up.railway.app
> Tenant: `ux-audit-1777265477001`
> Output dir: `docs/qa/deep-audit-<YYYY-MM-DD>/`
> Mode: GUI-only · Chrome incognito · multi-tab · test profiles only · NO direct API.

---

## Why this exists

Prior audits (`audit-2026-04-29.md`, `verification-2026-05-01..02`) exhaustively
triaged 13 P0s + 55 P1s + 116 P2s and the team shipped fixes for all of them.
This pass is **DIFFERENT**: it deliberately ignores the easy happy paths and
hunts for the bugs only **practical, irritated, fast-moving real users** will
hit — interruptions, double-taps, paste-from-Excel, network blips, browser
back, accidental refresh, mid-flow auth expiry, two tabs racing, etc.

Workers WILL find new bugs. The team has fixed every audit-flagged failure;
the next layer of issues is depth-of-experience stuff that wasn't testable
until the surface beneath worked.

---

## Cached preamble (every sub-agent pastes this verbatim — prompt-cache hit)

> Approx 1.5 K tokens. Treat as immutable.

```
ROLE
You are a RouteFlow QA worker on a dedicated bug hunt. Drive the LIVE deployed
Expo bundle in a Chrome incognito window via mcp__Claude_in_Chrome__* tools.
GUI-only — NO direct API calls / NO curl / NO fetch from outside the page.
mcp__Claude_in_Chrome__javascript_tool inside the page is allowed for DOM
inspection, localStorage reads, and DEBUG-level interactions; not for
hitting /api/v1/* directly.

ENV (immutable)
- Frontend: https://routeflowmobile-production.up.railway.app
- API host the bundle calls: https://routeflowapi-production.up.railway.app
- Tenant code (only one in scope): ux-audit-1777265477001
- TEST PROFILES (NEVER use affa or any other tenant)
  - Operator (TENANT_ADMIN): ux_admin / UxAdmin@123!
  - Driver A (assigned, has run): ux_driver_a / UxDriver@123!
  - Driver B (unassigned): ux_driver_b / UxDriver@123!
  - Buyer 1 (no orders, fresh):   ux_buyer1_1777265477001@ux-audit.test / UxBuyer@123!
  - Buyer 2 (delivered + invoices): ux_buyer2_1777265477001@ux-audit.test / UxBuyer@123!
  - Buyer 3 (overdue invoice):    ux_buyer3_1777265477001@ux-audit.test / UxBuyer@123!
  - Buyer 4 (standing order):     ux_buyer4_1777265477001@ux-audit.test / UxBuyer@123!

DEDICATED-TAB DISCIPLINE (REQUIRED)
1. FIRST tool call: mcp__Claude_in_Chrome__tabs_create_mcp → record tabId.
2. mcp__Claude_in_Chrome__tabs_context_mcp {tabId} before EVERY interaction.
3. Resize to mobile viewport BEFORE login: 414×896 (or 375×667 for iPhone SE
   stress). Operator/buyer flows usually 414×896; driver flows 375×667.
4. If localStorage has another agent's session, log out via UI (Sign out
   modal → confirm) THEN re-login as your role. Never piggyback.
5. Multi-tab is allowed and encouraged for race / state-sync tests, but
   each agent owns its tabs and never touches another agent's tab.

THROTTLING REALITY
- /auth/login throttles ~5/5min/IP. On 429 / "Invalid credentials" pause 90s
  and retry. NEVER swap tenants to dodge throttling. NEVER reset another
  user's password. If you cannot login after 2 retries, mark BLOCKED with
  "auth throttled" and continue with another role.

ALREADY-FIXED — DO NOT BURN TOKENS RE-VERIFYING
The following were verified live in 2026-05-02. Skip unless you observe a
regression:
  RF-001 dispatch tenantId · RF-002 Socket.IO · RF-003 SCHEDULED-stop guard
  RF-013 cart on logout    · RF-014 order# unique · RF-018 password reset
  RF-074/197 customer cascade · RF-076/157 SVG XSS · RF-077 per-role tokens
  RF-090/213 Settings tabs · RF-176 X-Tenant-Slug · RF-188 invoice detail
  RF-203 Create forms      · RF-211 /drivers/add  · RF-212 returns list
  RF-016 RouteRun auto-complete · RF-209 finance routes · RF-222 /analytics

BUG REPORT FORMAT (compact — every bug is exactly this shape, no prose)

```yaml
- id: BUG-<W>-<n>           # W = your worker id
  title: <≤ 70 chars>
  surface: web-op | web-buyer | web-driver | cross-role | shared
  severity: P0 | P1 | P2 | P3
  category: data-integrity | money | security | flow-broken | ux | perf | a11y
            | empty-state | concurrency | adversarial-input | network | edge
  repro: |                  # numbered list, terse, mobile viewport assumed
    1. …
    2. …
  expected: <one line>
  actual: <one line; copy DOM/console/network text>
  root_cause: <best-guess hypothesis, 1-2 sentences>
  proposed_fix: <file path + 1-line change description>
  evidence: <screenshot id or DOM excerpt or network 4xx/5xx>
```

OUTPUT FILE
docs/qa/deep-audit-<YYYY-MM-DD>/workers/<worker-id>/findings.yaml

HARD RULES
- Token budget: ≤ 1500 output tokens per worker. Self-truncate.
- Stop after 8 confirmed bugs in your scope. Quality over quantity.
- A bug ONLY counts if you have a concrete repro you executed in YOUR tab
  and captured DOM/console/network evidence. Hunches go in a separate
  `## Suspected (no repro)` section, max 5 lines.
- Use mcp__Claude_in_Chrome__browser_batch aggressively to minimize round trips.
- NEVER mutate live data destructively — only operate on entities you yourself
  just created (e.g. dummy customers named "QA-<your-id>-…"). Tag your dummies
  so the cleanup script can remove them.
- Status lexicon: 🔴 BUG-NEW · 🟡 PARTIAL-REGRESSION · ⚪ DESIGN-QUESTION
```

---

## Phase plan (strictly serial; agents within a phase parallel)

### Phase A — Pre-flight (you, ≤ 400 output tokens)

1. Confirm frontend 200, login each role once via the GUI (not curl) to
   warm the throttler-aware login flow and capture the current bundle hash.
2. Create the output tree: `docs/qa/deep-audit-<YYYY-MM-DD>/{workers,supervisors}/`.
3. Write `targets.json` listing the **practical-stress scenarios** below
   (extracted into structured form, ~200 lines max). Each scenario has
   `{ id, surface, scenario_brief, owner_squad }`.
4. Confirm Railway services SUCCESS via `railway status` (ops permission
   only — not a verification action).

### Phase B — Hunt (4 supervisors × 2 workers each = 8 parallel hunts)

Each L2 spawns its 2 L1 workers in a **single tool message** so they
run in parallel. Wait for all 2 to finish before the L2 compresses.

#### Squad OPS — operator dashboard depth (sonnet, medium effort)

Surface: web-op (operator role only). One Chrome tab per worker.
Skip everything in the "ALREADY-FIXED" list above unless regressed.

- **OPS-1 — Order/Invoice/Money paranoia** (sonnet)
  Practical scenarios to drive:
  1. Create an order with 30 line items by repeating Add → product → qty 7
     thirty times. Does the catalog dropdown re-fetch on every open
     (perf bug)? Does scrolling lock up at 30+ items?
  2. Pick a tax-exempt customer; verify invoice tax = $0 in the detail
     view AND on the printable PDF (RF-079 deeper layer).
  3. Create a $0 order (qty 0 lines) — should be blocked client-side.
  4. Edit invoice discount to a value > subtotal — does total go negative?
  5. Apply a credit note that partially exceeds remaining balance —
     should clamp to balance, not over-credit (RF-010 deeper).
  6. Open same invoice in 2 tabs; in tab A change discount, in tab B
     record payment. Do they collide cleanly or last-write-wins silently?
  7. Mark an OVERDUE invoice as PAID — does dashboard "AR Aging" tile
     refresh in real-time (RF-002 follow-on) or stale until refresh?
  8. Type "1,234.56" into a price field — does the comma break it?
     Type emoji into a SKU. Type 50,000 chars into Notes.

- **OPS-2 — Routes / Dispatch / Drivers** (sonnet)
  Scenarios:
  1. Create a route → add 12 stops by tapping "Add" 12× rapidly. Are
     stop numbers sequential? Any duplicates? Any orphans?
  2. Reorder stops via drag-and-drop on mobile viewport — does the order
     persist after navigation away?
  3. Click "Optimize stops" with 0 stops, 1 stop, 2 stops, 12 stops.
     Loading state? Error? Reordered correctly? (RF-205 deeper.)
  4. Dispatch a run with no driver assigned — UI should block.
  5. Dispatch the SAME route twice for today — should be blocked or
     warned. Audit didn't cover this.
  6. Reassign a route from driver A to driver B mid-day. Does driver A
     lose access? Does driver B see it on next pull? Real-time event?
  7. Try "Delete route" on a route that has an IN_PROGRESS run.
     Should be blocked with a clear message.
  8. Filter routes by "today" then by driver — do filters compose or
     reset each other?

#### Squad BUYER — customer portal depth (sonnet, medium effort)

Surface: web-buyer. Two buyers per worker (different states).

- **BUYER-1 — Catalog / Cart / Checkout** (sonnet)
  Scenarios:
  1. Add same SKU to cart 5 times — does qty increment to 5 or do you
     get 5 line items? (Either is a choice but should be consistent.)
  2. Add to cart, navigate to /catalog, /orders, /more, back to cart —
     do items persist?
  3. Add to cart, leave 30 min, come back — cart still there or expired?
     If expired, is there a clear "session expired" toast?
  4. Apply a price-tier eligibility (operator changes the customer's
     pricing tier mid-session) — does buyer see new prices on next add?
  5. Submit checkout with empty cart — UI must block.
  6. Submit checkout, then immediately tap "Place order" again — was
     the second tap idempotent or did it create 2 orders? (RF-019
     applied here in spirit.)
  7. Buyer 4 has standing order Mon/Wed/Fri — try to skip a single fire
     date. Does UI surface this control?
  8. Cancel a PENDING order from buyer side — does inventory restock?

- **BUYER-2 — Invoices / Returns / Profile / Auth** (sonnet)
  Scenarios:
  1. Buyer 3 has overdue invoice — does the dashboard's "Outstanding
     balance" match the invoice list sum? Does color/severity escalate?
  2. View invoice PDF in mobile — does it render or just spin?
  3. Initiate a return on a delivered order — multi-line returns? Reason
     selector? Photo upload? Does the credit note auto-generate (RF-150)?
  4. Reset password from /forgot-password as a buyer — get the email,
     follow link, set new password, login with new password.
  5. Forced password change scenario — operator resets buyer's password,
     buyer next login MUST be forced to change before any other route.
  6. Try deep-linking to /invoices/<uuid> while logged out → goes to
     /customer-login → after login, returns to that invoice (or not).
  7. Open buyer portal on tab A; in tab B, simulate token expiry by
     deleting `rf:buyer:accessToken` from localStorage; tap any nav in
     tab A — does it cleanly redirect to /customer-login (not break)?
  8. Profile screen — change phone, change name, save — does operator
     see the new contact info immediately?

#### Squad DRIVER — POD edge cases (sonnet, medium effort)

Mobile viewport 375×667. Driver A is assigned UX Route A. After yesterday's
backfill, that run is now COMPLETED — for fresh testing the operator agent
in OPS-2 should dispatch a NEW run for Driver B before this squad starts.

- **DRIVER-1 — Run lifecycle + offline** (sonnet)
  Scenarios:
  1. Start run with 0 stops (edge: route was dispatched empty).
  2. Mark stop delivered, partial delivery (2 of 5 items delivered) —
     does inventory adjust? Does invoice line items reflect partial?
  3. Skip a stop with reason — does the run still auto-complete on
     last delivered+skipped (RF-016 follow-on)?
  4. Capture signature, undo strokes, capture again — does the
     re-captured signature replace cleanly?
  5. Take POD photo, hit Cancel, take another — does the first one
     leak in storage or attach to the wrong stop?
  6. Cash payment $0.01, $0.99, $999999.99, "abc" — validation?
  7. Network throttle to "Slow 3G" mid-payment — does the optimistic
     UI roll back if request fails? Idempotency on retry?
  8. Force-close (close tab) after marking delivered but before
     payment recorded. Re-open: is delivery in offline queue, payment
     awaiting? Or split-state inconsistent?

- **DRIVER-2 — Map / Standing / Cash drawer / Stats** (sonnet)
  Scenarios:
  1. Map screen with 0 stops, with 5 stops, with 50 stops simulated.
  2. Standing-order day for driver — does the auto-generated order
     appear on the route?
  3. Cash drawer — record collections from 5 stops, see running total,
     end-of-day reconciliation. Off-by-cent? Wrong tenant currency?
  4. Driver Stats screen — totalStopsCompleted should match COMPLETED
     runs. After RF-016 backfill, did stats update?
  5. Driver opens app while running has been CANCELLED by operator —
     does the run vanish gracefully or show stale data?
  6. Multi-driver day: Driver A and Driver B logged in same browser
     same incognito — token isolation (NEW-m2-1 follow-on).
  7. Driver receives push-event "route.dispatched" via Socket.IO —
     does the runs list update without manual refresh?
  8. Driver tries to navigate to /home or /customers — should be
     redirected away (not authorized).

#### Squad CROSS — cross-role, security, accessibility (sonnet, high effort)

Multi-tab, multi-role parallel sessions. Operate in own browser windows.

- **CROSS-1 — Real-time + concurrency** (sonnet, HIGH effort)
  Scenarios:
  1. Tab A: operator order list. Tab B: buyer 2 places a new order.
     Does Tab A's list auto-update via Socket.IO within 5 s?
  2. Tab A: buyer dashboard. Tab B: operator marks an invoice PAID.
     Does buyer's "Outstanding balance" update without refresh?
  3. Tab A: driver A `/route`. Tab B: operator dispatches a NEW run to
     driver A. Does driver A's screen show the new run live?
  4. Tab A: operator opens product. Tab B: another operator (use
     ux_admin twice; namespaced session collision still possible)
     edits price. Tab A submits with old price — server should reject
     or silently merge.
  5. Tab A: buyer cart. Tab B: operator changes customer's pricing tier.
     Tab A submits checkout — uses old tier price?
  6. Open 3 driver runs in 3 tabs (multi-driver same browser) — token
     namespace must isolate; cross-action must NOT bleed.
  7. Refresh same page 5× rapidly — Socket.IO reconnects gracefully?
     Network shows ONE active connection, not five?
  8. Logout in tab A — does tab B (same role) detect cross-tab signout
     via the storage event listener and redirect?

- **CROSS-2 — Accessibility, edge inputs, browser quirks** (sonnet)
  Scenarios:
  1. Keyboard navigation: tab through login → operator nav → forms.
     Are all interactive elements reachable? Does focus-ring show?
  2. Screen reader labels: aria-label on icon-only buttons (Add, Delete,
     Optimize, Edit). Pills (status badges) — `role=status`?
  3. Color contrast: secondary text vs background — meets WCAG AA?
  4. RTL text input: Arabic / Hebrew customer name — UI mirror?
  5. Long paste: 5,000 chars in Notes; 200-char product name; emoji
     in SKU. Does the form clip or break?
  6. Browser back button after submit — does it re-submit (POST/REDIRECT/GET
     correct?), preserve the form, or break navigation?
  7. Browser refresh on a Create form with unsaved data — warned via
     beforeunload? Or silently lost?
  8. Print page on /invoices/:id — does it render the invoice cleanly
     without the bottom-nav / header chrome?

### Phase C — L2 supervisors compress (4 × ≤ 1500 output tokens, parallel)

Each L2 reads ITS 2 worker findings.yaml and produces:

- `docs/qa/deep-audit-<YYYY-MM-DD>/supervisors/<squad>.md`:
  - Top 5 P0/P1 bugs with full repro + fix
  - Bug count by severity + category
  - Squad verdict: SHIP / HOLD / RE-FIX
  - One-line pattern observation (e.g. "all OPS bugs cluster around
    invoice math edge cases — likely missing decimal precision lib").

L2s do NOT re-test. They synthesize.

### Phase D — Master verdict (you, ≤ 3000 output tokens)

Read ONLY the 4 supervisor docs. Produce
`docs/qa/deep-audit-<YYYY-MM-DD>/final-report.md`:

```
# Deep audit — <date>
## Headline (one line: SHIP / HOLD / RE-FIX)
## Counts
| Severity | New bugs |
| P0 | n |
| P1 | n |
| P2 | n |
## Top 10 ship-blockers (numbered, with fixes)
## Cross-cutting patterns (3-5 themes)
## Required next sprint (priority ordered)
```

---

## Quality gate

- ANY new P0 → HOLD, no exceptions.
- ≥ 3 new P1 → HOLD with re-fix plan.
- ≥ 8 new P2s in the same category → flag as a systemic gap, not separate
  bugs.
- Workers reporting < 3 bugs each in their scope → require a 5-min
  "deeper-look" pass on the most-fragile scenario in their list.
- A bug missing repro/expected/actual/root_cause is rejected by the
  supervisor and not counted.

---

## Token discipline

Targets:
- Phase A (you): ≤ 400 output
- Phase B per worker (×8): ≤ 1500 output = ≤ 12 K
- Phase C per supervisor (×4): ≤ 1500 output = ≤ 6 K
- Phase D (you): ≤ 3000 output
- **Total session output: ≤ 21.4 K tokens**
- Total session input target with caching: ≤ 200 K

Tactics:
- Cached preamble pasted verbatim into every sub-agent → 1 cache hit.
- Workers receive ONLY their squad's scenarios — not the whole prompt.
- Bug entries are YAML, not prose; supervisors deduplicate.
- Master reads 4 supervisor docs only — never raw worker output.
- Use `mcp__Claude_in_Chrome__browser_batch` for every multi-step
  interaction (login, fill form, submit, screenshot — single tool call).
- `read_page` text mode > screenshots. Screenshot only when text fails
  to capture a visual bug (overlap, off-screen, contrast).

---

## Anti-patterns (workers must refuse)

- ❌ Re-verifying any RF in the "ALREADY-FIXED" list with no signal of
  regression.
- ❌ Reporting a bug without a self-executed repro.
- ❌ Bugs in `affa` tenant or any tenant other than `ux-audit-1777265477001`.
- ❌ Touching another agent's tab.
- ❌ Hitting `/api/v1/*` directly with curl/fetch — only the page is allowed
  to fetch via its own UI actions.
- ❌ Spending tokens on writing an executive summary inside `findings.yaml`.
  YAML only; supervisor writes the prose.

---

## Mandatory practical scenarios (workers must cover at least 80%)

| Tag | Why it matters |
|---|---|
| `paste-from-excel` | Real ops paste prices/quantities from Excel — currency, separators, decimals |
| `accidental-double-tap` | Mobile users double-tap submit — should never duplicate writes |
| `mid-flow-network-blip` | Intermittent connectivity in a delivery van |
| `back-button-after-submit` | Drivers/buyers hit back constantly |
| `refresh-on-create-form` | Half-typed data — beforeunload? |
| `paste-50k-chars-into-notes` | A buyer dumping a long PO instruction |
| `qty=0`, `qty=999999`, `qty=-1`, `qty=1.5` | Number boundary checks |
| `price=0`, `price<0`, `price>1B` | Money boundary checks |
| `empty-state-screens` | Fresh tenant, brand-new buyer — every list/empty render correctly |
| `permission-edge` | Driver tries to access operator-only screen by URL |
| `expired-session-mid-flow` | Token expires while user is mid-form |
| `stale-data-after-update` | Two tabs disagreeing |
| `accidental-leave-form` | Browser back / nav-tab tap with dirty form |
| `concurrent-same-resource` | Two operators editing same invoice |
| `tenant-currency-mismatch` | Tenant set to non-USD; UI shows correct symbol everywhere |
| `timezone-display` | scheduledDate displayed in tenant TZ, not UTC (NEW-rweb-7 deeper) |

---

## How to invoke

```
I am starting RouteFlow deep-audit. Read
docs/qa/deep-audit-prompt.md and execute Phases A → D.
Output base: docs/qa/deep-audit-<today's-date>/.
Confirm Phase A pre-flight before dispatching Phase B squads.
```

---

## Cleanup obligation

After the audit, before reporting SHIP/HOLD, run any cleanup script for
QA-tagged dummy entities the workers created (look for names matching
`/^QA-/`). Do not leave audit pollution behind.

End of master prompt.
