# Plan: Client release blockers — terms↔dueDate linkage, address edit no-op, edit-path stock, badge timezone

> ## ⚠️ WORKTREE
>
> ALL work happens in `C:\ClaudeCode\routeflow\.claude\worktrees\ap-client-fixes`
> (branch `fix/client-release-blockers`, rebased onto master post-#447). `cd` there before any command;
> absolute paths under the worktree for every edit. Do not commit/stage/push — the
> orchestrator does. **NO Prisma schema change, NO migration.**

> Authored by Fable 5 on 2026-08-25. Status: SUPERSEDED — IMPLEMENTED via #449 (2026-08-26); verified on master 2026-09-01: all four fixes live (settleStockForEdit, lib/invoice-terms linkage, calendarDaysUntil badges, address CRUD). Do NOT resume or re-run this plan.
> Grounded in a 6-agent release-verification sweep (2026-08-25) whose three HIGH findings the
> orchestrator re-confirmed by hand against master `754df625`. Anchors below are from that
> re-confirmation; if a line drifted, re-find by the quoted symbol, never by number.

## Objective

Four confirmed defects that reproduce a paying client's complaints:

1. **Edit-Terms modal reproduces "Net 60 shows Net 30"**: the Terms select only sets the
   label; the due date is never recomputed, so changing the term persists the OLD due date
   under the NEW label — through the very feature built to fix that complaint.
2. **Customer address edits are a silent no-op**: the edit form shows address fields
   pre-filled and editable, but the update mutation sends no address data and the server
   update path has no address handling. There is no working way to correct a customer's
   address on web.
3. **Order edits never write stock**: increasing a boxed line 1 box → 3 boxes on an
   existing order validates against stock but never decrements it (and reductions never
   return stock). Creation decrements; edit is a black hole.
4. **Invoice-list badges/KPIs still have the −1-day bug**: the date TEXT was fixed
   (UTC-pinned), but "Overdue by Nd"/"Due Today" badges and the KPI dollar buckets
   normalize in LOCAL time, misclassifying by one day for any Americas viewer.

## Constraints

- **NO schema change.** All four are code-level.
- **Money discipline**: no pricing math changes anywhere. Stock deltas are quantities, not
  money. Do not touch `computeLineSubtotal`/`roundMoney` call sites' semantics.
- Do NOT touch: `apps/api/src/invoices/**` (the server terms endpoint is correct — the bug
  is client-side), the tobacco/regulated modules, `pricing.ts` mirrors, mobile (mobile gaps
  are a separate queued batch).
- The recently-merged ad-hoc-trips feature (#435) touched `orders.service.ts` — re-find
  anchors by symbol; do not disturb `fulfillPath` logic or the trips controller.
- Conventional Commits; branch `fix/client-release-blockers`.

## Verified anchors (re-confirmed by hand, 2026-08-25, master 754df625)

- `apps/web/app/(dashboard)/invoices/[id]/page.tsx` — `EDIT_TERMS_OPTIONS` :865-872
  (values "", "Due on Receipt", "Net 15/30/45/60"); `EditTermsModal` :881-994; the Terms
  `<select>` at :958-968 calls ONLY `setPaymentTermsLabel`; submit at :907-923 sends
  `dueDate: dueDate || undefined` + `paymentTermsLabel` (server PATCH `/invoices/:id/terms`
  accepts both and is correct). `invoice.issueDate` is available on the modal's `invoice`
  prop. Modal used at :2884.
- `apps/web/app/(dashboard)/invoices/new/page.tsx` — `getDaysForTerms` :67-82 and the
  DST-safe `addDaysIso` :~90 (comment explains the UTC pitfall; mirrors mobile's
  `apps/mobile/lib/invoice-terms.ts` `dueDateFor`). These are file-local today.
- `apps/web/app/(dashboard)/invoices/page.tsx` — LOCAL-time normalization at :38
  (`today.setHours(0,0,0,0)`), :62 (`due.setHours(0,0,0,0)` in `renderStatus`), :192 and
  :211 (KPI math). Four sites total.
- `apps/web/lib/formatting.ts` — `fmtCalendarDate` :55-65 (the UTC-pinned pattern to match),
  `todayIso` :68-70.
- `apps/web/app/(dashboard)/customers/_components/CustomerFormModal.tsx` — edit-mode
  prefill :169-171 reads ONLY `street`/`city` from `addresses[0]` and hardcodes
  `state: ""` (zip also missing — prefill bug); add-mode payload :282-292 sends
  `addresses: [{line1, city, state, zip, isDefault: true, label: "Main", addressType}]`;
  edit-mode payload :305-334 sends NO address fields at all. Address autocomplete
  (`onAddressSelect`) at :589-600 works in both modes.
- `apps/api/src/customers/dto/update-customer.dto.ts` — NO `addresses` field (confirmed).
  The create DTO's address element shape lives in `create-customer.dto.ts` (find the
  address class there and reuse it — do not redeclare).
- `apps/api/src/customers/customers.service.ts` — `update(id, dto)` :635-668 (spread of
  scalar fields only); `geocodeIfPossible(addr)` :76-79 wraps the shared geocode util;
  the CREATE path geocodes `dto.addresses` BEFORE its transaction (:405-…) — mirror that
  ordering.
- `apps/api/src/orders/orders.service.ts` — `assertStockAvailableForEdit` :3569-3640
  (builds `held` from non-CANCELLED `order.lineItems`, `requested` from
  `finalActiveItems`, computes positive deltas, reads products WITHOUT locks, staff →
  `logger.warn` + allow, non-staff → `ConflictException`); call sites :3339 (operator
  `updateOrderItems` path, inside `tenantTransaction`) and :4208 (second edit path, also
  in-tx). The CREATE path's stock write (for contrast, :1841-1884): `SELECT … FOR UPDATE`
  then `currentStock: { decrement: li.qty }` per line, gated on `!isDraft`; staff may
  oversell into negative. **No SALE StockMovement rows are written on order create — stock
  is `currentStock` only. The edit fix must match that convention exactly.**
- Boxed-line qty basis (:187-202 comment + `normalizeBoxesPieces` at :1658): lines created
  with `boxes`/`pieces` store `qty` in PIECES; a boxed product ordered as selling units
  (boxes null) stores qty in SELLING UNITS. `held` and `requested` are computed in the SAME
  stored basis, so per-product deltas are internally consistent. Do NOT change this
  contract in this PR — pin it with a regression spec (WP1 item 4).

## SCOPE CHANGES (2026-08-26, verified against merged master)

- **WP2 and WP3 are SUPERSEDED — do NOT build them.** #442 Phase 1 shipped full
  Addresses-tab CRUD (edit all fields incl. state/zip, set-primary, delete w/ 409)
  on web AND mobile, and deliberately REMOVED the edit modal's inline address
  inputs (the silent-discard trap) in favor of a link to the Addresses tab
  (CustomerFormModal ~:581 comment). The defect 'no working way to correct an
  address on web' no longer exists. update-customer.dto.ts still has no
  addresses field BY DESIGN — addresses go through the dedicated endpoints.
- **WP4 is HALF DONE**: #442's review fixes already fixed the KPI bucket math
  (PaymentSummaryBar compares dueDate.slice(0,10) calendar strings; the old
  :192/:211 setHours sites are gone). Remaining: (a) the terms↔dueDate linkage
  in EditTermsModal (select at ~:958-968 still ONLY setPaymentTermsLabel), and
  (b) renderStatus's two LOCAL-time sites — now :83 (today.setHours) and :107
  (due.setHours) — replace with calendarDaysUntil per the original brief.
  fmtCalendarDate/todayIso live in apps/web/lib/formatting.ts as before.
- **WP1 anchors moved** (post #442-Phase-2 + #446 sweep): assertStockAvailableForEdit
  :3668; call sites :3339→:3438 and :4208→:4308. Everything else in the WP1 brief
  holds — re-verified by symbol. NOTE: #442 Phase 2 added deleteOrder/changeStatus
  logic nearby; do not disturb it. The sweep converted several order/customer
  lookups to findFirst — any NEW spec must mock the finder the code actually calls.
- Only WP1 and WP4 (reduced) are to be built. WP4 has no dependency on WP1.

## Work packages (ORIGINAL TEXT below — WP2/WP3 superseded, WP4 reduced per SCOPE CHANGES)

### WP1 — API: order edits settle stock deltas

- **files:** `apps/api/src/orders/orders.service.ts`, `apps/api/src/orders/orders.service.spec.ts`
- **brief:**
  1. Refactor `assertStockAvailableForEdit` into a new private
     `settleStockForEdit(db, order, finalActiveItems, user)` that KEEPS the existing
     validation semantics byte-for-byte (same violation message text, staff
     warn-and-allow, non-staff `ConflictException`) and then APPLIES the deltas:
     - Build `held` and `requested` exactly as today, but over the UNION of product ids
       (a product present only in `held` — line removed/zeroed — must get its stock back).
     - `SELECT id FROM "Product" WHERE id IN (…) FOR UPDATE` FIRST (before reading
       `currentStock`), mirroring the create path :1844-1848 — the current assert reads
       unlocked, which the refactor fixes for free.
     - After validation: for each product with `delta = requested − held ≠ 0`, write
       `currentStock: { decrement: delta }` when positive, `{ increment: -delta }` when
       negative. No StockMovement rows (matches create).
     - **Skip the entire settle (validate AND apply) when `order.status === "DRAFT"`** —
       creation never decremented for drafts, so edits must not either. (The existing
       assert call sites currently run for drafts too only if they did before — preserve
       whatever the current gating is around :3339/:4208 and add the DRAFT guard INSIDE
       settle so both sites get it.)
  2. Replace both call sites (:3339, :4208) with `settleStockForEdit`. Delete the old
     assert (or make it an internal helper of settle — no dead code).
  3. Delivered/OFD orders: settle applies there too — a qty increase on a delivered order
     means more goods went out; symmetric with create. Document with a one-line comment.
  4. Regression spec pinning the boxed-line qty basis on CREATE: a boxed product
     (unitsPerBox 12) ordered as `{boxes: 2, pieces: 3}` decrements 27 (pieces basis);
     the same product ordered legacy-style with bare `qty: 2` (no boxes/pieces keys)
     decrements exactly what today's code decrements (pin current behavior — no semantic
     change; the spec documents the contract the finding flagged).
  5. New spec cases for settle: (a) increase 1→3 boxes (qty 12→36) decrements 24;
     (b) decrease 3→1 increments 24 back; (c) removed line returns its full qty;
     (d) added line decrements its full qty; (e) DRAFT edit writes nothing;
     (f) non-staff increase beyond stock → ConflictException AND no write;
     (g) staff increase beyond stock → warn, write proceeds (stock goes negative);
     (h) unchanged lines produce zero product.update stock calls.

### WP2 — API: customer update accepts addresses (+ re-geocode)

- **files:** `apps/api/src/customers/dto/update-customer.dto.ts`,
  `apps/api/src/customers/customers.service.ts`,
  `apps/api/src/customers/customers.service.spec.ts`
- **brief:**
  1. `update-customer.dto.ts`: add
     `@IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => <the create
address DTO class>) addresses?: <same>[];` — import the SAME address class the create
     DTO uses (find it in `create-customer.dto.ts`; do not redeclare a new shape).
  2. `customers.service.ts` `update()`: when `dto.addresses?.length`, handle ONLY the
     FIRST entry as "the default address" (that is all the web form edits):
     - Geocode BEFORE the write via `this.geocodeIfPossible(...)`, mirroring the create
       path's before-transaction ordering. On geocode failure store `lat/lng: null` —
       NEVER keep the old coordinates against a changed street address (stale coords would
       silently mis-route deliveries; null degrades to the optimizer's no-coords handling).
     - Find the customer's default address (`isDefault: true`, else the first address);
       update its `line1/city/state/zip/addressType/lat/lng`; if the customer has NO
       address rows, create one with `{isDefault: true, label: "Main"}` (same shape as
       create :282-292's server-side result).
     - Wrap the customer-scalar update + address upsert in ONE
       `this.prisma.tenantTransaction` so a failed address write can't leave half an edit.
       (The geocode call stays OUTSIDE the tx.)
  3. Specs: (a) update with addresses updates the default address row and re-geocodes
     (geocode util spied); (b) geocode failure writes null coords, not stale ones;
     (c) update WITHOUT addresses leaves address rows untouched (byte-identical to
     today); (d) customer with zero addresses gets a created default row; (e) scalar
     fields still update exactly as before alongside an address change.

### WP3 — Web: customer edit sends the address (dependsOn WP2)

- **files:** `apps/web/app/(dashboard)/customers/_components/CustomerFormModal.tsx`
- **brief:**
  1. Fix edit-mode prefill (:169-171): read ALL FOUR fields from `addresses[0]` —
     `street` (line1 ?? street), `city`, `state`, `zip` — instead of hardcoding
     `state: ""` and omitting zip.
  2. In the edit branch (:305-334), send the address exactly like add mode does
     (:282-292): `addresses: [{ line1, city, state (trim || "TX"), zip, isDefault: true,
label: "Main", addressType }]` — with the SAME required-field validation add mode
     applies (street/city/zip required; reuse the existing `setStreetError` etc. block by
     hoisting it above the mode split so both branches share it).
  3. No other behavior changes: the autocomplete `onAddressSelect` already sets the form
     fields in both modes and needs no edit.

### WP4 — Web: Edit-Terms linkage + badge/KPI UTC normalization

- **files:** `apps/web/lib/invoice-terms.ts` (new),
  `apps/web/lib/formatting.ts`,
  `apps/web/app/(dashboard)/invoices/[id]/page.tsx`,
  `apps/web/app/(dashboard)/invoices/new/page.tsx`,
  `apps/web/app/(dashboard)/invoices/page.tsx`
- **brief:**
  1. **Extract** `getDaysForTerms` and `addDaysIso` from `invoices/new/page.tsx` (:67-…)
     into a new `apps/web/lib/invoice-terms.ts` VERBATIM (keep the DST doc comment; note
     it mirrors mobile's `lib/invoice-terms.ts`). `new/page.tsx` imports them; its local
     copies are deleted. Zero behavior change on the new-invoice page.
  2. **EditTermsModal linkage** (`[id]/page.tsx` :958-968): when the Terms select changes
     to a term with known days, recompute the due date from the invoice's ISSUE date:
     `tsx
     onChange={(e) => {
       const label = e.target.value;
       setPaymentTermsLabel(label);
       // The client-reported bug: changing the term used to leave the old due
       // date in place, persisting "Net 60" over Net-30 arithmetic. A known term
       // recomputes from the ISSUE date (the anchor the server itself uses);
       // picking "Select terms…" leaves the date alone for a manual correction.
       const days = getDaysForTerms(label);
       if (days != null && invoice.issueDate) {
         setDueDate(addDaysIso(String(invoice.issueDate).slice(0, 10), days));
       }
     }}
     `
     The user may still hand-adjust the date AFTER picking a term (explicit correction —
     the server accepts both fields as sent). Add a small muted helper line under the
     grid: `Picking a term recalculates the due date from the issue date
({fmtCalendarDate(invoice.issueDate)}).`
  3. **`lib/formatting.ts`**: add beside `fmtCalendarDate`:
     ```ts
     /**
      * Whole calendar days from the viewer's LOCAL today until a stored
      * UTC-midnight calendar date. Negative = that many days overdue. The due
      * date's day is read in UTC (it is a calendar value — see fmtCalendarDate);
      * "today" is the viewer's local calendar day. Mixing the two the other way
      * round is the badge variant of the −1-day bug.
      */
     export function calendarDaysUntil(d?: string | null): number | null {
       if (!d) return null;
       const dt = new Date(d);
       if (isNaN(dt.getTime())) return null;
       const dueUTC = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
       const now = new Date();
       const todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
       return Math.round((dueUTC - todayUTC) / 86_400_000);
     }
     ```
  4. **`invoices/page.tsx`**: replace all four LOCAL normalizations (:38, :62, :192, :211)
     with `calendarDaysUntil`: `renderStatus` derives overdue/due-today/due-in-N from the
     returned integer (`< 0` overdue by `-n`, `0` due today, `> 0` due in n); the KPI
     bucket math classifies with the same helper. The rendered STRINGS must stay
     byte-identical for a UTC viewer ("Overdue by 3d" etc.) — only the day boundary
     moves. Delete the now-unused local `Date` fiddling.

## Out of scope (queued separately — do NOT build here)

Mobile terms/vendor-bill/edit-due-date gaps · deposit visibility on PDF/email/portal + AR
aging awareness (feature-scale, needs design) · order-edit tier/price loading race ·
selling-unit boxed-line semantics change · notes-field HTML stripping.

## Acceptance criteria

1. No schema/migration change; `apps/api/prisma/` untouched.
2. Edit-Terms: picking "Net 60" on an invoice issued Aug 4 sets the due-date input to
   Oct 3 automatically; Save persists both; picking "Select terms…" never touches the
   date; a hand-adjusted date after picking a term is persisted as typed.
3. New-invoice page behavior is byte-identical (helpers extracted, not changed).
4. Customer edit: changing the street and saving persists it (server row updated),
   re-geocodes, and the form re-opens showing the new values; state/zip prefill correctly;
   an update without touching address fields sends the (unchanged) prefilled address and
   the server write is idempotent.
5. Order edit 1→3 boxes decrements exactly 2 boxes' worth of pieces; 3→1 returns them;
   removed/added lines settle symmetrically; DRAFT edits write nothing; non-staff
   over-stock edits 409 without writing; staff may oversell (negative stock) with a warn —
   all spec-asserted, and the full pre-existing orders suite stays green.
6. Invoice list: an invoice due "today" (viewer local) shows Due Today, not Overdue, for a
   negative-UTC-offset viewer; badge strings unchanged otherwise; KPI buckets use the same
   helper; zero remaining `setHours(0, 0, 0, 0)` in `invoices/page.tsx`.
7. `npm run check-types`, `npm run lint`, `npm run test` green from the worktree root.

## Verification commands

- perRound: `cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-client-fixes && npm run check-types`
- final: check-types + `npm run lint` + `npm run test` (same cwd)

## Risks & rollback

- The stock-settle refactor touches the money-adjacent order edit path — its blast radius
  is bounded by keeping validation semantics byte-identical and adding only the
  delta writes; the full orders spec suite is the guard. Orchestrator runs a Fable
  money-pass on the diff before push.
- Address updates now re-geocode: a geocode outage nulls coords on edited addresses
  (documented, preferred over stale coords).
- Rollback: plain `git revert`; no data shape changed. Stock written by edits between
  deploy and a revert is real inventory movement and stays.
