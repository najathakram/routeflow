# PR-3 — parked drafts on mobile

**Status:** IMPLEMENTED — shipped 2026-08-18/19; see the PR for the verified final shape
**Scale:** major (mobile-only, new subsystem, money-adjacent on resume)
**Sources of truth:** `.claude/pipeline/decisions/2026-08-18-batch-architecture.md` §PR-3 (binding — the five numbered designs) and `docs/plans/mobile-ux-batch-2026-08-17.md` §PR-3. If this file and the decisions doc disagree, the decisions doc wins.

## Context

The draft system already exists **server-side and on web**: `SaleDraft` model, full `/drafts` CRUD (`apps/api/src/drafts/`), and web's `DraftDock`. **Mobile has zero callers.** An operator building an order on a handset who takes a call, switches tabs, or gets the SPA reloaded loses the whole cart. This PR gives mobile the same park/resume, mirroring web's payload so a draft parked on one device resumes on the other.

Model (binding): **bind to a server draft once parkable, autosave continuously (900ms debounce), delete on successful submit.** Navigation hooks are flush points only.

Read before writing code: `apps/web/lib/drafts.ts` (the payload contract to mirror), `apps/web/lib/api/drafts.ts` (hook shapes), `apps/web/components/DraftDock.tsx` (UX precedent), `apps/api/src/drafts/drafts.service.ts` (server semantics — drafts are PER-USER and tenant-scoped).

## Non-goals / do not touch

- No API change. `/drafts` is used exactly as it exists. **No Prisma migration.**
- No idempotency key on `POST /orders` (deliberately descoped — the client-side latch + poison-pill below replace it).
- Do NOT touch `pricing.ts` in any workspace, `ScanOrderSheet` internals, driver route/stop flows, or the buyer portal.
- Do NOT change web behavior beyond the ONE additive type-only field in WP4.

## Work packages

### WP1 — drafts API mirror + pure payload module (`apps/mobile/lib`)

**Files owned:** `apps/mobile/lib/api/drafts.ts` (new), `apps/mobile/lib/drafts-payload.ts` (new), `apps/mobile/__tests__/drafts-payload.test.ts` (new)

1. `lib/api/drafts.ts` — mirror web's `lib/api/drafts.ts`: `useDrafts()`, `useDraft(id)`, `useCreateDraft()`, `useUpdateDraft()`, `useDeleteDraft()` over `/drafts`, query key `["drafts"]`, invalidating on every mutation. Match this repo's mobile api-module conventions (see `lib/api/orders.ts`). Export the `SaleDraft` type.
2. `lib/drafts-payload.ts` — PURE (no react-query/api-client imports; must run in the node Jest env):
   - `OrderDraftPayload` copied **field-for-field** from `apps/web/lib/drafts.ts` (`customer`, `lineItems[]`, `orderDiscount`, `shippingFee`, `requestedDeliveryDate`, `orderDate`, `notes`, `urgent`, `floorAcked`) PLUS these ADDITIVE optional fields: `selectedCreditIds?: string[]`, and per-line `note?: string` on `DraftLineItem`.
   - **Unlisted lines are NOT a separate array.** They map into web's existing `DraftLineItem` shape with `isUnlisted: true`, `tempId: <local id>`, `productName: <name>`, `unitPrice`, `qty` — this is what makes a mobile-parked draft resume on web and vice versa.
   - `toOrderDraftPayload(state) → OrderDraftPayload` and `fromOrderDraftPayload(payload) → state`. `tempId = productId` for catalog lines (keeps `floorAcked` stable). Every money value that must be recomputed goes through `computeLineSubtotal` — never `qty * unitPrice`.
   - `draftParkable(state): boolean` — **customer chosen AND (catalog lines > 0 OR unlisted lines > 0)**. A customer-only draft is noise and must not be parked.
   - Ports of `draftDeviceLabel()`, `parkedAgo(iso)`, `draftSummary(draft)` from web (adapt `draftDeviceLabel` to React Native: `Platform.OS` — but keep this module import-free of RN if possible by taking the label as a parameter; if RN's `Platform` is needed, put ONLY that helper in the non-pure module and keep the rest pure).
3. `__tests__/drafts-payload.test.ts` must pin a full round-trip of a fixture containing: a boxed line with `boxes`/`pieces` + a MANUAL price override + a per-line note, an unlisted line, two `selectedCreditIds`, and a `floorAcked` entry. Assert `fromOrderDraftPayload(toOrderDraftPayload(x))` is equivalent to `x`, and that `draftParkable` is false for customer-only state.

### WP2 — the autosave hook (`apps/mobile/lib`)

**Files owned:** `apps/mobile/lib/use-draft-autosave.ts` (new), `apps/mobile/__tests__/use-draft-autosave.test.ts` (new)

Implements decisions §PR-3.1 and §PR-3.2. Exposes `{ flush, discard, draftId }`.

- **Single-flight create latch (binding):** the hook holds `draftIdRef: string | null` AND `createPromiseRef: Promise<string> | null`. Any flush that needs an id **awaits the existing promise if set**; otherwise it creates one (`POST /drafts`), **stores the promise before awaiting it**, and reuses it. Hydration seeds `draftIdRef` so a resumed session can never create. Spec-pinned contract: **at most one `POST /drafts` per builder session regardless of flush concurrency** — a boolean flag is NOT sufficient, it must be the stored promise.
- Debounce 900ms; skip the write when the serialized payload is JSON-unchanged from the last saved value; hydration seeds `lastSaved` so resuming does not immediately re-PATCH.
- `discard()` clears the pending timer and sets a discarded flag such that `flush()` and any in-flight debounce become no-ops afterwards. Spec: **no write happens after `discard()`**.
- Autosave is gated by an `enabled` flag (the screen passes `!runId && !stopId`).
- The hook takes the payload as a value/getter plus `{ enabled, kind, customerId, customerName, title }` metadata for the draft row.
- Tests use fake timers and stub create/update/delete functions (no network). Cover: three payload changes across one create round-trip ⇒ exactly one create; unchanged payload ⇒ no PATCH; `discard()` then `flush()` ⇒ no write.

### WP3 — order builder park/resume + DraftStrip (`apps/mobile`)

**Files owned:** `apps/mobile/components/NewOrderScreen.tsx`, `apps/mobile/components/DraftStrip.tsx` (new), `apps/mobile/app/(operator)/new-order.tsx`, `apps/mobile/app/(operator)/(tabs)/orders/index.tsx`

Implements decisions §PR-3.2 (submit), §PR-3.3/§PR-3.4 (hydration) and §PR-3.5 (binding point).

- **Binding point:** the autosave hook lives INSIDE `ProductPickView` (it owns all parkable state: `items`, `unlisted`, `floorAcked`, `orderNotes`, `orderUrgent`, `deliveryDate`, `orderDate`, `discountRaw`, `shippingFeeRaw`, `selectedCreditIds`, `scannedById`). `NewOrderScreen` owns only the customer.
- **Resume:** `?resumeDraft=<id>` is accepted as a route param on `/(operator)/new-order` and resolved at `NewOrderScreen` level via `useDraft(id)` (show a spinner while loading). The loaded draft seeds `pickedCustomerId/Name` so `ProductPickView` mounts immediately, and the payload is handed down as a **one-shot `initialDraft` prop** consumed by lazy `useState` initializers (keyed so changing customer does not re-seed). A **404 toasts "That draft is gone"** and falls through to a normal empty builder.
- **Hydration safety (binding):** fetch live products for parked productIds, then:
  - missing/archived product ⇒ drop the line, collect the names, and show **ONE** alert after hydrate: `Removed N item(s) no longer in your catalog: …`;
  - pin the parked `unitPrice` **only when the parked `priceType === "MANUAL"`** (a real operator override) — otherwise leave it unset so the live tier price re-derives (matches `submitOrder`'s existing override rule; the server owns tier/promo pricing);
  - if `unitsPerBox` changed, keep the parked `boxes`/`pieces` (physical counts) and re-derive `qty` with the LIVE `unitsPerBox` via `normalizeBoxesPieces`;
  - re-validate resumed `selectedCreditIds` with the existing `isCreditOpenForApply` predicate and drop dead ones silently.
- **Submit (binding order):** `flush()` once BEFORE `createOrder.mutate` (so a failed create leaves an up-to-date draft). On success: (1) `discard()` so nothing races, (2) PATCH the draft stamping `payload.submittedAt = <ISO>` (the poison-pill), (3) `await Promise.race([deleteDraft(id), timeout(1500)])` before navigating, with one background retry on failure. The existing manual "Save as draft" (which creates a server DRAFT **order**) stays; a successful save deletes the bound personal draft the same way.
- **`DraftStrip.tsx`** — RouteFlow-styled horizontal card strip; **renders nothing when there are no drafts**; each card shows the customer, a `draftSummary` line and `parkedAgo`; tapping routes to `/(operator)/new-order?resumeDraft=<id>`; long-press/✕ deletes with a confirm. **Filters out any draft whose `payload.submittedAt` is set**, and lazily fire-and-forget deletes those when seen. Mounted above the list in `(tabs)/orders/index.tsx`.
- `onChangeCustomer` keeps the SAME server draft and PATCHes `customerId`/`customerName` on the next flush.
- Flush points: back handler, one fire-and-forget `beforeRemove`, and (web only) `visibilitychange`.

### WP4 — web type parity (`apps/web`) — type-only

**Files owned:** `apps/web/lib/drafts.ts`

Add the two ADDITIVE optional fields to web's types so the mirrors stay identical and a mobile-parked draft type-checks on web: `selectedCreditIds?: string[]` on `OrderDraftPayload`, and `note?: string` on `DraftLineItem`. **Type-only — do not change any web behavior or read the fields.** Add a one-line comment that mobile round-trips these.

## Acceptance criteria

- [ ] `lib/drafts-payload.ts` is pure (imports nothing from api-client/react-query) and its spec passes in the node Jest env.
- [ ] Unlisted lines round-trip through web's `DraftLineItem` with `isUnlisted: true` — there is NO separate `unlisted[]` array in the payload.
- [ ] Exactly one `POST /drafts` per builder session under concurrent flushes (spec-pinned via the stored promise, not a boolean).
- [ ] No write occurs after `discard()` (spec-pinned).
- [ ] Submitting deletes the bound draft; if the delete fails the draft carries `submittedAt` and `DraftStrip` never offers it for resume.
- [ ] Resuming a draft whose product was deleted drops those lines with one alert; a non-MANUAL parked price re-derives from the live tier price; changed `unitsPerBox` preserves boxes/pieces and re-derives qty.
- [ ] `draftParkable` is false until a customer AND at least one line exist.
- [ ] `DraftStrip` renders nothing with zero drafts.
- [ ] No file under `apps/api`, `prisma/`, or any `pricing.ts` is modified; the only `apps/web` change is the type-only WP4.

## Verification

```
npx turbo run check-types lint test --filter=@routeflow/mobile --force
npm run verify
```
