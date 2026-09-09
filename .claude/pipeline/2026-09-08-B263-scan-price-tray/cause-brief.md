# Cause brief — B263 mobile-scan-price-tray

> Written by the S1 evidence agent (Sonnet @ low, read-only). Facts with evidence only — every claim carries a
> file:line, a command output, or a quoted source. The suspected cause is recorded AS A CLAIM. No fix proposals.

**Scope note**: B263 is the "Option B" twin B246's `cause-ruling.md` (§1, §8) deferred behind Option C. Option C
(mount a scan FAB on the order-edit line list, opening the existing picker pre-armed to scan) landed on master as
`7fc01298` (PR #668, 2026-09-08) — confirmed present in this branch (`fix/B263-scan-price-tray` off
`origin/master` @ `eb2b815e`; `git diff --stat master -- apps/mobile` not run here, but the FAB/`initialScanOpen`/
`scanFabHidden` wiring was read directly in the checked-out tree, see "Code path" §1). This brief gathers the
**current, post-Option-C** state of every surface named in the launching task; it does not evaluate whether B263's
suggested direction is correct.

## The bug as stated

**Source**, `.claude/campaign/bugs/B263.md` (frontmatter + body, quoted verbatim):

```
id: B263
title: Mobile order edit: price control lives inside the scan flow over a paused camera (B246 option B)
location: Orders - mobile operator order edit (scan flow)
severity: high
batch:
tier:
state: uncampaigned
proof:
sensitive: true
sensitiveFor: money
closed:
files: apps/mobile/components/ScanCamera.tsx apps/mobile/components/ScanCamera.web.tsx apps/mobile/components/BarcodeScanner.tsx apps/mobile/components/ScanOrderSheet.tsx apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx
```

> ## Reported evidence
>
> cause-ruling.md for B246 (.claude/pipeline/2026-09-08-B246-scan-fab/cause-ruling.md, section 1) deferred Option B
> behind Option C per the owner order: C first (this run), B later - move the price control (PriceOverrideModal
> today) into ScanTray over a PAUSED, not torn-down, camera, so pricing and scanning share one live surface. Today
> ScanCamera.tsx does declare an active boolean prop (default true) that gates onBarcodeScanned, but its only
> caller, BarcodeScanner.tsx, never passes one down (mounts ScanCamera with style/onScanned/onOutcome/continuous
> only) - so the pause path is unreachable from any screen today; every scan surface tears the camera down on
> close/unmount instead (ScanCamera.web.tsx stops every track), which is the cold-start cost B246 option C worked
> around on the line list rather than removed. Filed as its own row per cause-ruling.md section 8: the B twin
> stays open as its own row.

**Ledger shard** `.claude/campaign/bugs.jsonl:263` carries the identical `symptom` text plus `"register":"open"`,
`"batch":null`, `"source":"filed"`, `"filedAt":"2026-09-08T12:13:55.660Z"`, `"sensitive":true`,
`"sensitiveFor":["money"]`.

**Note on the `files:` frontmatter vs the row's own prose**: the frontmatter names `ScanOrderSheet.tsx`, not
`ScanTray.tsx` — but the prose says the price control moves "into ScanTray". `ScanTray.tsx` does not appear in
`files:` at all. Recorded as a fact, not resolved here (see "Open unknowns").

**Repro / observable gap** — this agent's own trace, not from the registry (the registry text states no tap count
for B263, only the `active`-prop claim quoted above). The scenario is the launching task's own: "scan a product →
need to change its price → scan the next one," walked against `edit-items.tsx` as currently on this branch (all
line numbers below are current, i.e. **after** Option C's `7fc01298`, not B246's pre-Option-C brief's numbers,
which have drifted by ~+15 to +30 lines throughout this file):

1. Camera is live, mid-scan (reached via the line-list `BarcodeFab`, :1016-1028, or via "Add product", :968-981 +
   the picker's own barcode icon, :1924-1931). Product A is scanned; the ladder's `accept` (:1836-1841) calls
   `onPickAndStay(product, kind)` → `addPickedToDraft(p, kind)` (wired at :813) — the picker **stays open**
   (`continuous`), a feedback banner shows, nothing about A's price is visible or editable inside the picker.
2. **`ProductPicker`'s own JSX (`:1915-2030`) has no price-editing control anywhere** — no `DraftItemCard`, no
   `PriceOverrideModal`, no margin-floor UI. To reach ANY price control the operator must leave the picker.
   **Tap 1 — "Cancel"**: `NavBackButton` at :1917 (`onPress={onClose}`) → `onClose` (defined at the mount site,
   :841-845): `setShowPicker(false); setSubstituteFor(null); setPickerScanIntent(false)` → `ProductPicker`
   **unmounts** → its `<BarcodeScanner>` (:1983-1992) unmounts → the camera tears down (web:
   `ScanCamera.web.tsx:505-508` cleanup → `stop()` :183-200 → `track.stop()` on every `MediaStreamTrack`, :197;
   native: `ScanCamera.tsx`'s `CameraView` simply unmounts — no explicit `stop()` abstraction exists there, see
   "Code path" §3) — **camera teardown #1**.
3. Line-list branch renders (`:848` onward).
   **Tap 2 — the price chip**: `DraftItemCard`'s price chip, `onPressPrice={() => setPriceEditItem(it)}` (:937)
   → `PriceOverrideModal` mounts (:734-748).
   **Tap 3 — "Apply"**: `PriceOverrideModal`'s Apply button (:1476-1482) → `onSave(newPrice, reason)` (defined at
   the mount site, :736-744) writes `draft[productId] = {...priceEditItem, unitPrice: newPrice, overrideReason:
reason || undefined}`, then `setPriceEditItem(null)` — modal closes. ("Cancel", :1473-1475, is the only other
   control, and discards instead.)
4. **Tap 4 — the `BarcodeFab`** (:1016-1028): `onPress` sets `pickerScanIntent=true` + `showPicker=true`.
   `ProductPicker` **mounts again** — a fresh component instance, since it was fully removed from the tree at
   step 2, not merely hidden — with `initialScanOpen={pickerScanIntent}` = true (:809) seeding `scanOpen` true
   (:1792) → `<BarcodeScanner>` mounts again → a fresh `getUserMedia`/`CameraView` acquisition — **camera
   reacquisition #2**, independent of teardown #1.
5. Operator scans product B.

**Measured: 4 explicit taps (Cancel, price chip, Apply, BarcodeFab) and 2 full camera lifecycle events** (one
teardown to reach a price control at all, one fresh acquisition to resume scanning) between "done scanning A" and
"camera live for B." This is **not** the same measurement B246's brief made: that brief's "3 taps (4 with the
price chip)" started counting from a state where `priceEditItem` was **already open** (i.e., the operator was
already on the line list) and measured only the **return** leg (Apply → camera). B263's stated scenario starts
**mid-scan**, inside the picker, where — both before and after Option C — there is still no price-editing surface
at all, so reaching a price control costs an additional tap-and-teardown B246's own count did not include.

**Suspected cause (claim, unverified, quoted from the registry)**: "Today ScanCamera.tsx does declare an active
boolean prop (default true) that gates onBarcodeScanned, but its only caller, BarcodeScanner.tsx, never passes one
down... so the pause path is unreachable from any screen today." Verified independently against current source in
"Code path" §3 below — the claim is corroborated exactly as stated (see the closing note in that section).

## Code path

### 1. Current after-Option-C path on the mobile order-edit screen

Covered in full above ("Repro / observable gap"). Supporting facts not already cited:

- `BarcodeFab` on the line list is hidden via `scanFabHidden({...})` (:1016-1023), reading `pricingReady`,
  `showPicker`, `!!priceEditItem`, and `unlistedModalOpen || createCreditOpen || !!licenseBlock || !!creditBlock`
  (:1017-1022) — `apps/mobile/lib/scan-fab-visibility.ts:31-37` implements the boolean as a single conjunction.
- The margin-floor one-tap fix (`"Set to floor $…"` / "Sell anyway") is a **second, independent** price-change
  path on the same `DraftItemCard`, at **`edit-items.tsx:1220-1228`** (the launching task's `~:1189` is stale by
  ~31 lines post-Option-C) — `{canEditPrice && below && !acked && floorPrice != null ? (...) : null}` — and it
  lives in the exact same non-picker branch as the price chip, so it is unreachable from mid-scan for the same
  structural reason (§2 below).
- `edit-items.tsx` imports neither `ScanOrderSheet` nor `ScanTray` (grep for both names inside the file: zero
  matches) — confirmed still true post-Option-C; Option C added only `BarcodeFab` + `scan-fab-visibility.ts`
  imports (:55-56), touching nothing about `ScanOrderSheet`/`ScanTray`.

### 2. `NewOrderScreen.tsx` + `ScanOrderSheet.tsx` + `ScanTray.tsx`

**No price control exists in the tray or the scan sheet today** — confirmed from both ends:

- `ScanTrayProps` (`ScanTray.tsx:25-35`): `rows`, `flash`, `onChangeQty`, `onIncrement`, `onDecrement`, `onRemove`,
  `ListEmptyComponent`. `TrayRowItem` (`ScanTray.tsx:70-144`) renders name, subtotal, a `QtyStepper`, and a remove
  button — no price-editing control, no `onPressPrice`-shaped prop.
- `ScanOrderSheetProps` (`ScanOrderSheet.tsx:16-44`): `visible`, `paused`, `rows`, `flash`, `totalItems`, `total`,
  `onScanned`, `onChangeQty`, `onIncrement`, `onDecrement`, `onRemove`, `onReview`, `onDone` — same, no price prop.
- The price control (`onChangePrice={setLinePrice}`, `NewOrderScreen.tsx:2318`) is wired only into **`CartModal`**
  (mounted :2299-2354ish), reached via `ScanOrderSheet`'s "Review" button (`ScanOrderSheet.tsx:201-209`) →
  `onReview={() => { setScanOpen(false); setCartOpen(true); }}` (`NewOrderScreen.tsx:2238-2241`) — a **different
  screen/modal than the camera**, not colocated with it.
- **The same "no way back to a live camera" shape B246 fixed on edit-items.tsx already exists here, unfixed**:
  `CartModal`'s `onScanMore` (`NewOrderScreen.tsx:2333-2336`) does `setCartOpen(false); setScanOpen(true)`,
  flipping the same `scanOpen` boolean `ScanOrderSheet`'s `visible` prop is bound to (`:2224`). Inside
  `ScanOrderSheet`, the camera is mounted behind an **explicit, separate** conditional —
  `{visible && granted ? <ScanCamera .../> : (...)}` (`ScanOrderSheet.tsx:131`) — independent of whatever RN's own
  `<Modal visible={visible}>` (`:128`) does with the rest of the subtree. This means `ScanTray`'s rows survive a
  `scanOpen` toggle (they're parent-owned state, passed as `rows`/`flash` props, `:2229-2230`), but the camera is
  **deliberately** unmounted and remounted on every cart round-trip — paying the identical cold start B246
  targeted, just one layer up (cart, not a picker).
- **Ambiguous/miss feedback**: `ScanOrderSheet` DOES render `feedback.action` as a tappable pill —
  `errorPill`/`errorActionBtn` (`ScanOrderSheet.tsx:160-186`), `ACTION_PILL_MS = 8000` vs `ERROR_PILL_MS = 2600`
  (`:12-14`) so an actionable pill survives long enough to read and tap. `handleOutcome` (`:108-123`) routes
  `outcome.feedback.kind === "error"` to `showError` (haptic + pill), a bare `outcome.close` to `onDone()`, and
  anything else to a haptic + `trayRef.current?.scrollToTop()` (`:118-122`). The ladder's ambiguous/miss codepaths
  (`onAmbiguous: setPickCode`, `onCreate: canCreateProducts ? setCreateCode : undefined`,
  `NewOrderScreen.tsx` — not re-cited here, unchanged since B246's brief) hand off to
  `ProductPickerSheet`/`InlineCreateProductSheet`, both mounted **after** `<ScanOrderSheet>` in JSX specifically so
  they layer visually above it (`NewOrderScreen.tsx:2245-2247`, `:2288-2291` comments explain the ordering
  requirement on react-native-web).

### 3. `ScanCamera` / `BarcodeScanner` pause semantics — the registry's central claim, re-verified

**`active` prop, both platforms** (current source, both files read in full):

- **Native** `ScanCamera.tsx:25` (doc comment): `"Feed detections only while true — pause without tearing the
camera down."` Implementation: `onBarcodeScanned={active ? handleBarcodeScanned : undefined}` (`:149`) — passing
  `undefined` deregisters the callback; the `<CameraView>` itself (`:138-150`) stays mounted with the same stream,
  so this is a genuine hardware-level pause (the camera session is not released) — **but this cannot be verified
  further from source alone**; whether `expo-camera` internally throttles anything when `onBarcodeScanned` is
  `undefined` is unknown (see "Open unknowns").
- **Web** `ScanCamera.web.tsx`: `active` (default `true`, `:135`; mirrored to `activeRef`, `:174-175`) gates only
  `handleFrame` (`:267`, `if (!activeRef.current) return;`) and `handleManual` (`:291`, same guard). The decode
  `loop` (`:317-346`) **never reads `activeRef`** — it keeps calling `detect()` on every animation frame
  regardless of `active`. The camera-acquisition effect (`:348-509`) is **not gated by `active` at all**. So on
  web, `active=false` only discards decoded results — it neither stops the CPU-side decode loop nor releases the
  `MediaStream`. Only unmount does that (`:505-508` cleanup → `stop()` → `:183-200` → `track.stop()` on every
  track, `:197`).

**`BarcodeScanner.tsx` / `.web.tsx` — where `paused` actually lands, and where `active` does not**:

- Both `BarcodeScanner.tsx:30-35` and `BarcodeScanner.web.tsx:28-32` implement `paused` identically: `const
guardedScan = (code) => (paused ? undefined : onScanned(code))` — **swallowing the accepted code**, not gating
  the camera. Both mount `<ScanCamera>` with only `onScanned={guardedScan}`, `onOutcome={handleOutcome}`,
  `continuous={continuous}` (native `:80-85`; web `:60-73`, which additionally passes `onModeChange`/`footer`) —
  **neither passes `active`**. This is the registry's claim, confirmed verbatim against current code: `active` is
  unreachable through `BarcodeScanner`'s surface today.
- `BarcodeFab.tsx` renders its own `<BarcodeScanner>` (`:184-193`, only reachable via the `onScanned` variant of
  its props union — not the `onPress` variant `edit-items.tsx` uses today) and does not expose or forward `paused`
  at all — the FAB's own scanner path has no pause lever of any kind.
- **The one place `active` IS reached today**: `ScanOrderSheet.tsx:137` passes `active={!paused}` **directly** to
  `<ScanCamera>` — bypassing `BarcodeScanner` entirely (`ScanOrderSheet` never renders `<BarcodeScanner>`). This
  is used to freeze decoding while `createCode != null || pickCode != null` (`NewOrderScreen.tsx:2228`,
  `ScanOrderSheet`'s own `paused` prop) — i.e., a sub-sheet (ambiguous-pick or create-on-miss) is stacked over a
  camera kept alive underneath. **This is the only existing "pause, don't tear down" precedent anywhere in the
  app**, and it already coexists with a tray-like list (`ScanTray`) in the exact same component.
- **A second, narrower `paused` use already exists inside `ProductPicker` itself** (post-Option-C, on
  `edit-items.tsx`): `<BarcodeScanner onScanned={onScanned} onClose={...} continuous={!!onPickAndStay}
paused={pickCode !== null || createCode !== null} />` (`edit-items.tsx:1983-1992`) — same "freeze while a
  hand-off sheet is up" pattern as `ScanOrderSheet`, but through `BarcodeScanner`'s code-swallowing `paused`, not
  `ScanCamera`'s `active`. This confirms `paused`-without-teardown is already a live, working pattern on this
  exact screen for the ambiguous/miss sub-sheets — just never yet used to keep the camera alive across a
  **price edit**.

**Net**: the registry's claim is corroborated exactly — `ScanCamera`'s `active` prop is real, does what its doc
comment says on both platforms (with the noted web-side decode-loop caveat), and is unreachable from
`BarcodeScanner`'s public surface. Two different "pause, don't tear down" mechanisms already exist in the
codebase (`ScanOrderSheet` → `ScanCamera.active` directly; `ProductPicker` → `BarcodeScanner.paused`), neither of
which is wired to survive a **price edit** on any screen today.

### 4. Money rules on the edit screen (`edit-items.tsx`)

- **`PriceOverrideModal`** (`:1392-1488`, defined inline in `edit-items.tsx` — it is not a separate file). Props:
  `item: DraftItem`, `onSave: (newPrice: number, reason: string) => void`, `onCancel: () => void` (`:1392-1400`).
  Two linked inputs — unit price and "$ off / unit" — kept in sync (`onChangePrice`/`onChangeOff`, `:1412-1430`).
  `valid = newPrice > 0` (`:1410`) is the only validation; Apply is disabled otherwise (`:1477-1482`). `onSave`
  (wired at the mount site, `:736-744`) writes exactly `unitPrice: newPrice` and
  `overrideReason: reason || undefined` onto `draft[priceEditItem.productId]` — nothing else.
- **No SPECIAL/tier lock on the price control itself.** `DraftItemCard`'s `canEditPrice` prop is
  `!isDriver && order.status !== "CANCELLED"` (`:922`) — no `isSpecial`/tier check. Contrast
  `NewOrderScreen.tsx:623-627`: `isSpecialFor(p) = effectiveTierFor(p.id) !== 1` (`:624`, comment: "SPECIAL
  (tier≠1) lines are the customer's permanent price — never overridable") and `lineUnitFor` (`:626-627`)
  **discards any stored override on a SPECIAL line at charge-time**, falling back to `tierPriceFor(p)`
  regardless of what was typed. `edit-items.tsx` has no equivalent discard — whatever `PriceOverrideModal` writes
  to `draft[productId].unitPrice` is sent as-is (see `save()` below). Whether `NewOrderScreen`'s `CartModal` price
  **input UI** itself additionally hides/disables for a SPECIAL line (as opposed to `lineUnitFor` just discarding
  the value at charge-time) was not traced — out of the file list this brief was scoped to.
- **`isSpecial` inside `addPickedToDraft`** (`:517-580`, a different mechanism from the above): `const isSpecial =
(cpMap.get(p.id) ?? customerTier ?? 1) !== 1` (`:533`) gates only whether a **fresh** line's price may prefill
  from `priceHistory` instead of the tier price (`:553-557`) — "never over a SPECIAL tier price, else start at
  the tier price." It says nothing about whether an _existing_ SPECIAL line's price stays editable afterward
  (that's `canEditPrice`, above, which has no such gate).
- **Boxed lines**: `DraftItemCard` computes `lineTotal` via `computeLineSubtotal({ unitPrice: item.unitPrice, qty,
boxes: item.boxes ?? null, pieces: item.pieces ?? null, unitsPerBox: item.unitsPerBox ?? null, freeUnits })`
  (`:1110-1117`), imported from `@routeflow/pricing` (`:28-37` import block, alongside `classifyMargin`,
  `computeMarginFraction`, `effectiveQty`, `getTierPrice`, `perUnitPrice`, `priceForMarginFloor`, `roundMoney`).
  `addPickedToDraft` (`:517-580`) increments an existing boxed line via `incrementLine`/`incrementLinePiece`
  (imported from `lib/sale-line`, `:40`) with `boxSplit: true` (`:541-546`), or seeds a fresh boxed line at
  `{qty:1, boxes:0, pieces:1, boxSplit:true}` for a piece-code scan (`:566-569ish`).
- **Propagation to the draft, then to the API on `save()`** (`:598-670+`): `PriceOverrideModal.onSave` →
  `setDraft` (in-memory only, `:737-744`). `save()` builds `catalog: DiffCatalogLine[]` from `Object.values(draft)`
  (`:604-616`), including `unitPrice: i.unitPrice`, `basePrice: i.catalogPrice`, `overrideReason: i.overrideReason`
  (`:611-613`), then calls `buildOrderItemDiff({ catalog, unlisted: unlistedLines, originals, pendingDeletes,
pendingCancels: [] })` (`:639-645`, imported from `lib/order-item-diff`, `:45-50`) and sends the result via
  `updateMut.mutate({ orderId: id, items, replaceAll: false, ... })` (`:652+`). `order-item-diff.test.ts` (see
  "Existing tests") confirms `unitPrice` + `overrideReason` reach the emitted `UPDATE` action only when the price
  actually differs from `basePrice` — a no-op edit sends no `unitPrice` at all.

### 5. Web golden reference (`apps/web/app/(dashboard)/orders/[id]/page.tsx`)

- **Permanent scan row** (`:1341-1406`): a keyboard-wedge text input (no camera on web at all),
  `placeholder="Scan barcode or type name…"`, `disabled={!pricingReady}` (`:1354`), Enter routes to
  `handleScanEnter()` (`:1363-1367`) which resolves the code, adds on an unambiguous hit
  (`:1028-1039`), opens a dropdown on ambiguity (`:1029-1036`, keeps the code **selected** so the next wedge scan
  overwrites it), or opens create-on-miss (`:1041-1043`).
- **Inline `PriceEditRow`** (`:1272-1283`, component defined `:741-785+`): renders **inside every line row**,
  never as a modal, never as a separate branch — `(canEditPrice || item.isUnlisted) && !item.cancelled`. Props:
  `basePrice`, `unitPrice`, `overrideReason`, `onPriceChange`, `onReasonChange`, `unitCost`, `unitsPerBox`,
  `floor` (`:741-759`). Owns its **own** margin-floor ack state (`floorAcked`, `:762`) and a cost-reveal toggle
  (`costRevealed`, `:764`) — independent per row, never persisted.
- **Refocus** (`:1004-1005`): `setTimeout(() => addInputRef.current?.focus(), 80)` +
  `setTimeout(() => ..., 200)` after every add — two timeouts, one as a fallback. Re-`select()` (not just focus)
  on archived (`:1025`), ambiguous (`:1035`), and network-error (`:1047`) so the next scan overwrites the field
  instead of appending.
- **Parity claim available to mobile, per this reading**: a scan entry point that coexists permanently with the
  editable line list, so a price edit costs zero navigation. **Not** available: a warm camera — web has none, so
  "camera cold start" carries no golden-reference obligation on web's side; that cost is mobile-only and has no
  web equivalent to match against.

## History

`git log -5 --format="%h %ad %s" --date=short --` for every file the launching task named (fewer than 5 shown
where a file has fewer total commits):

| File                         | Commits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edit-items.tsx`             | `7fc01298` 2026-09-08 fix(mobile): scan FAB on the order-edit line list opens the picker in scan mode (#668) · `22372911` 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613) · `e6d1ab34` 2026-09-01 fix(orders): updateOrderItems authorization and line build (F06) (#573) · `5219e620` 2026-08-31 fix(scan): mobile scan-loss hardening + order idempotency (F30) (#555) · `7e13fbf3` 2026-08-23 fix(invoices): honour sale terms and due date; stop calendar date day-shift (#416) |
| `BarcodeFab.tsx`             | `7fc01298` 2026-09-08 (#668) · `172a58b9` 2026-07-12 feat(mobile): mobile↔web parity waves (reconciled onto master) (#225) · `a9671398` 2026-06-19 fix(web): UX/UI audit fixes + lockfile resync + LF normalization (#93) · `0958565e` 2026-05-04 feat(mobile): floating draggable scan FAB + real invoice composer (#68) — 4 commits total                                                                                                                                                                                        |
| `ScanCamera.tsx` (native)    | `5219e620` 2026-08-31 (F30, #555) · `5be1dfac` 2026-08-11 fix: mobile-web scan, catalogue and credit-note defects (#323) · `4f5ed09b` 2026-08-07 feat: duplicate invoice detection, backdated orders, payment bank date, mobile scan rework (#322) — 3 commits total                                                                                                                                                                                                                                                               |
| `ScanCamera.web.tsx`         | `e2bc8b33` 2026-08-31 fix(mobile): port the F30 scan engine to the web camera path (#562) · `5be1dfac` 2026-08-11 (#323) · `4f5ed09b` 2026-08-07 (#322) — 3 commits total                                                                                                                                                                                                                                                                                                                                                          |
| `BarcodeScanner.tsx`         | `fa89e94d` 2026-08-17 feat(mobile): one scan ladder everywhere, and a quiet catalogue (#353) · `4f5ed09b` 2026-08-07 (#322) · `172a58b9` 2026-07-12 (#225) · `a9671398` 2026-06-19 (#93) · `41ab2803` 2026-03-24 fix(driver-app): resolve QA bugs found during full driver flow test                                                                                                                                                                                                                                               |
| `BarcodeScanner.web.tsx`     | `fa89e94d` 2026-08-17 (#353) · `4f5ed09b` 2026-08-07 (#322) · `172a58b9` 2026-07-12 (#225) · `c33a0075` 2026-06-22 feat: mobile fixes, money-math correctness, and autonomous regression pipeline (#99) · `a9671398` 2026-06-19 (#93)                                                                                                                                                                                                                                                                                              |
| `ScanOrderSheet.tsx`         | `5219e620` 2026-08-31 (F30, #555) · `5be1dfac` 2026-08-11 (#323) · `4f5ed09b` 2026-08-07 (#322) — 3 commits total                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ScanTray.tsx`               | `5be1dfac` 2026-08-11 (#323) · `4f5ed09b` 2026-08-07 (#322) — 2 commits total                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `NewOrderScreen.tsx`         | `22372911` 2026-09-04 (#613) · `5219e620` 2026-08-31 (F30, #555) · `26ec7183` 2026-08-24 feat(trips): ad-hoc order trips, fulfillment mode, driver-payments opt-in (#435) · `7e13fbf3` 2026-08-23 (#416) · `7e49b993` 2026-08-23 feat(invoices): MSRP on invoices — display-only suggested retail, flag-gated (#411)                                                                                                                                                                                                               |
| `lib/scan-fab-visibility.ts` | `7fc01298` 2026-09-08 (#668) — 1 commit total, new file from Option C                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PriceOverrideModal`         | Defined inline in `edit-items.tsx` (`:1392-1488`) — no separate file; history is `edit-items.tsx`'s, above.                                                                                                                                                                                                                                                                                                                                                                                                                        |

`edit-items.tsx`, `BarcodeFab.tsx`, and `lib/scan-fab-visibility.ts` all carry `7fc01298` (#668, today) as their
most recent commit — Option C. Every scan-hardening commit (F30: `5219e620`; the web port: `e2bc8b33`) predates it
by at least a week and touched none of Option C's new code.

## Existing tests around this behavior

**Primary-source structural fact**, `apps/mobile/jest.config.js` (unchanged since B246's brief): `testEnvironment:
"node"` (`:4`), `testMatch: ["**/__tests__/**/*.test.ts"]` (`:11`, `.ts` only), comment at `:10` "Only run the
pure-logic unit tests — not the Expo/RN component files," `moduleNameMapper` (`:30-38`) maps only
`@routeflow/pricing` (to source), `expo-secure-store`, `@routeflow/ui`, `@routeflow/types` — no `react-native` or
`react-test-renderer`. Nothing in the suite renders `BarcodeFab`, `ProductPicker`, `ScanOrderSheet`, `ScanTray`,
`BarcodeScanner`, or `ScanCamera`/`ScanCamera.web`.

**Four test files landed with Option C** (`apps/mobile/__tests__/`, all dated today per git history above):

- **`edit-items-scan-fab.test.ts`** (135 lines) — source-text spec (`readFileSync` + regex, no render), in the
  style of `scan-camera-buffer.test.ts:141-155`. Splits `edit-items.tsx`'s source at `"function ProductPicker"`
  into a parent half and a picker half (`:36-39`) so parent-only assertions can't accidentally match picker code.
  Pins: exactly one `<BarcodeFab` mount in the parent branch (`:49-54`); its `hidden` expression routes through
  `scanFabHidden(` and references `pricingReady`/`showPicker`/`priceEditItem` (`:56-70`); `ProductPicker` declares
  `initialScanOpen?: boolean` and seeds `scanOpen` from it (`:72-80`); the FAB's `onPress` sets both
  `pickerScanIntent` and `showPicker`, and does **not** use `onScanned` (`:82-101`); `BarcodeFab.tsx` itself
  prioritizes `onPress` over its own scanner (`:103-112`); `pickerScanIntent` resets on both `onPick` and
  `onClose`, and exactly one call site ever arms it true (`:114-134`).
- **`scan-fab-visibility.test.ts`** (81 lines) — real unit tests (not source-text) against
  `scanFabHidden` from `lib/scan-fab-visibility.ts`. Five cases, each flipping exactly one input via `toBe` (never
  a truthiness matcher, so a constant-`true`/`false` implementation can't pass): hidden when `pricingReady=false`
  even with nothing else open (the REG-B62 guard); hidden while the picker is open; hidden while the price modal
  is open; hidden while any other blocking modal is open; visible only when none hold.
- **`barcode-fab-props.test.ts`** (42 lines) — a **type-level** test (checked by `tsc --noEmit`, not by
  `ts-jest`'s runtime, which runs with `diagnostics: false`, `:16-17` of the file's own comment). Pins
  `BarcodeFab`'s discriminated-union `Props` (from `L-095`, see "Relevant lessons"): `@ts-expect-error` on neither
  handler and on both handlers supplied; two accepted shapes (`onScanned`-only, `onPress`-only).
- **`scan-camera-web-sequencing.test.ts`** (75 lines) — the **B245 pin**, explicitly labelled "no REG token —
  outside the red gate" and "green-by-design... must not be rewritten to fail" (file header comment). Source-text
  regex counts (`>= 1`, not exact) against `ScanCamera.web.tsx` for: `handleFrame` called inside a `.then()`
  (`:337-338`), the `inFlightRef` release inside `.finally()` (`:341-344`), `scanSettled` drain (`:248-252`),
  `playScanCue` (`:245`), and `track.stop()` reached from the unmount cleanup (`:505-508` → `:197`). None of this
  exercises `active`/`paused` semantics — it pins frame/resolve/teardown sequencing only.

**Other coverage directly touching this brief's money/tray claims**:

- **`order-item-diff.test.ts`** — asserts the exact propagation path cited in "Code path" §4: a price-only change
  emits `{ id, action: "UPDATE", qty, unitPrice, overrideReason }` (line ~64-71: `unitPrice: 4, overrideReason:
"deal"` in → identical values out); a **new** catalog line priced exactly at `basePrice` sends **no**
  `unitPrice` at all (line ~74-77); a substitution with an operator override emits both `unitPrice` and
  `overrideReason` (line ~139-166), while a substitution landing at the substitute's own list price sends neither
  (line ~169-181).
- **`scan-tray.test.ts`** (194 lines, all pure-logic against `lib/scan-tray.ts`'s `trayRowsFrom`) — the pure data
  layer already models a per-line price **override** (`{ single: { qty: 3, unitPrice: 1.99 } }`,
  `:137-140`, priced via the shared `computeLineSubtotal` from `@routeflow/pricing`) and a SPECIAL-tier
  **lock** via an `overridable: (p) => boolean` callback (`:142-154`: a SPECIAL line's stored override is ignored
  and it's priced at the tier price instead). **This plumbing has no UI trigger today** — `ScanTray`'s own
  component props (`:25-35` of `ScanTray.tsx`, cited above) expose no way to set a line's `unitPrice` or call
  `overridable`; `trayRowsFrom`'s `overridable` parameter has no caller in `NewOrderScreen.tsx` today (not
  grepped further — flagged as an open unknown below, since confirming "no caller" needs a repo-wide grep for
  `overridable:` outside this brief's file list).
- No test file's name or content matches `paused`, `ScanOrderSheet`'s mount/unmount behavior, or `BarcodeScanner`'s
  `guardedScan` — confirmed by grep across `apps/mobile/__tests__/` for `paused|ScanOrderSheet|ScanTray` (hits:
  `order-templates-helpers.test.ts`, `recurring-invoices-helpers.test.ts`, `row-layout.test.ts`,
  `scan-camera-buffer.test.ts` — none of these actually test `BarcodeScanner`/`ScanOrderSheet`; the matches are
  incidental substring hits, e.g. on unrelated words).

## Relevant lessons (`.claude/lessons/LESSONS.md`)

Grepped case-insensitively for `scan|camera|paused|tray|price override|margin floor|SPECIAL tier` across the whole
register. Two entries are on point (both already named by the launching task); nothing else surfaced:

- **L-025** (2026-09-01, testing): "A `Platform`/`isWeb` branch is untested code unless something runs that
  platform. When you touch one side of such a branch, either exercise the other side or state plainly that it is
  unverified." Guard: none (judgment) — grep `isWeb`/`Platform.OS` in any touched file. Directly on point: this
  brief covers a native/web pair (`ScanCamera.tsx` / `.web.tsx`, `BarcodeScanner.tsx` / `.web.tsx`) where the two
  sides already behave differently (native's `active` gates the CameraView callback directly; web's `active`
  leaves the decode loop running) and mobile Jest cannot render either.
- **L-095** (2026-09-08, domain, `#668` — Option C's own lesson): "Model mutually exclusive handlers on a shared
  component as a discriminated union (exactly one of `onScanned` / `onPress`), so a no-op mount is a TYPE error —
  pin it with a props test." Guard: `barcode-fab-props.test.ts` (`tsc --noEmit`) + `BarcodeFab.tsx`'s
  discriminated-union `Props`. Symptom it recorded: Option C's own first round wired the FAB's tap to the wrong
  prop, compiling clean but inert; both handlers being optional let `<BarcodeFab />` compile into a dead control
  across all 5 existing mounts. Directly relevant if any B263 design reuses or extends `BarcodeFab`'s prop shape.

(L-071, OCR-gate, matched "scan" only because it concerns document/invoice OCR scanning — unrelated to barcode
scanning, not on point.)

## Production evidence

None. `bugs.jsonl:263` carries `"source":"filed"` and the row's own History section says "2026-09-08 · **filed**
· filed directly via `bugs.mjs file`" — not from a production incident. No log lines, row counts, or ids attached.

## Open unknowns

- **`files:` frontmatter names `ScanOrderSheet.tsx`; the row's own prose says "into ScanTray."** `ScanTray.tsx`
  itself is absent from `files:`. Whether the intended target is the `ScanOrderSheet` container, the `ScanTray`
  list specifically, or both, is not resolved by the row text — S2/S3 should treat the prose ("into ScanTray") as
  more specific than the frontmatter, per the same precedent B246's own brief set for its stale `files:` list.
- **Native `active=false`'s actual hardware effect is unverified.** `ScanCamera.tsx:149`
  (`onBarcodeScanned={active ? handleBarcodeScanned : undefined}`) stops the JS callback from firing, and the
  `<CameraView>` stays mounted — but whether `expo-camera` itself throttles/preserves the underlying camera
  session identically to the `active=true` case cannot be confirmed from source alone (no test exercises it; see
  "Existing tests").
- **Whether `CartModal`'s price input UI-gates a SPECIAL line**, beyond `NewOrderScreen.tsx:626-627`'s
  charge-time discard of any stored override — not traced (would require reading `CartModal`/its line-editor
  component, outside this brief's named file list).
- **Whether `trayRowsFrom`'s `overridable` parameter (`lib/scan-tray.ts`, exercised at `scan-tray.test.ts:142-154`)
  has any caller today outside the test file** — not grepped repo-wide; if uncalled, the SPECIAL-lock plumbing in
  the pure tray-row layer is presently dead code from the app's perspective, exercised only by its own test.
- **Bringing `ScanOrderSheet`/`ScanTray` onto `edit-items.tsx` (if that turns out to be the direction) is new
  composition, not a reuse of an existing wiring.** Confirmed by grep: `edit-items.tsx` imports neither name today
  (§1 above), and `ScanOrderSheet`'s only two current render call sites are `NewOrderScreen.tsx` and
  `apps/mobile/app/(operator)/(tabs)/invoices/new.tsx` (grepped; the latter was not otherwise examined — outside
  this brief's scope).

## Facts the ruling needs

1. **On the edit screen, no control anywhere prices a line without first leaving the live scanner**: neither the
   price chip (`edit-items.tsx:937`) nor the margin-floor one-tap fix (`:1220-1228`, corrected from the launching
   task's stale `~:1189`) renders inside `ProductPicker`'s JSX (`:1915-2030`) — both exist only in the mutually
   exclusive line-list branch.
2. **Measured cost of "scan → price-edit → scan next" today (post-Option-C): 4 taps (Cancel, price chip, Apply,
   BarcodeFab) and 2 independent camera lifecycle events** (a teardown to reach the price control, a fresh
   acquisition to resume scanning) — not the 1-tap/0-extra-teardown figure Option C achieved for the _narrower_
   case B246 measured (price editor already open, picker already closed).
3. **`ScanCamera`'s `active` prop is real and does what the registry claims, on both platforms, but is
   unreachable through `BarcodeScanner`** (`BarcodeScanner.tsx:80-85`, `.web.tsx:60-73` pass `onScanned`/
   `onOutcome`/`continuous` only). Web's `active` additionally leaves the decode loop running when "paused"
   (`ScanCamera.web.tsx:317-346` never reads `activeRef`) — only unmount fully releases the camera on web.
4. **Two "pause, don't tear down" mechanisms already exist and both work today**: `ScanOrderSheet.tsx:137`
   (`active={!paused}` straight to `ScanCamera`) and `ProductPicker`'s own camera inside `edit-items.tsx:1990`
   (`paused={pickCode !== null || createCode !== null}` through `BarcodeScanner`'s code-swallowing `guardedScan`).
   Neither is currently wired to survive a price edit on any screen.
5. **`ScanTray`/`ScanOrderSheet` carry no price control today** (`ScanTray.tsx:25-35`, `ScanOrderSheet.tsx:16-44`)
   — the only price control (`setLinePrice` via `CartModal`) is reached by fully leaving the scan surface
   (`onReview`/`onScanMore`, `NewOrderScreen.tsx:2238-2241`/`:2333-2336`), and that round trip **also** pays a full
   camera teardown+reacquire, via `ScanOrderSheet.tsx:131`'s explicit `{visible && granted ? <ScanCamera/> : ...}`
   gate — the same unfixed shape B246 fixed on `edit-items.tsx`, still open here.
6. **The pure `lib/scan-tray.ts` layer already has an `unitPrice`-override + SPECIAL-lock (`overridable`) concept**
   (`scan-tray.test.ts:137-154`), but no `ScanTray`/`ScanOrderSheet` component prop currently exposes a way to
   invoke it — the money-shape exists in the data layer; the UI trigger does not.
7. **`edit-items.tsx`'s price control has no SPECIAL/tier lock** (`canEditPrice`, `:922`, checks only
   driver-role + order status) — unlike `NewOrderScreen.tsx:624-627`, which discards any override on a SPECIAL
   line at charge-time (`lineUnitFor`). Any new price-control surface should have this asymmetry named explicitly
   rather than silently inheriting one behavior or the other.
8. **`PriceOverrideModal` (`edit-items.tsx:1392-1488`) writes exactly `unitPrice` + `overrideReason`**, propagated
   unconditionally to `draft`, then diffed by `buildOrderItemDiff` (`:639-645`) — confirmed by
   `order-item-diff.test.ts` — and sent via `updateMut.mutate` (`:652+`) only when it actually changed.
9. **Mobile Jest cannot render any component named in this brief** (`jest.config.js:4/:11`, `.ts`-only,
   `testEnvironment: "node"`) — any new coverage is necessarily source-text pins (per the
   `edit-items-scan-fab.test.ts`/`scan-camera-web-sequencing.test.ts` precedent) or pure-logic unit tests (per
   `scan-fab-visibility.test.ts`/`scan-tray.test.ts`), never a rendered interaction test.
10. **B263's own `files:` frontmatter (`ScanOrderSheet.tsx`) and its prose ("into ScanTray") disagree**, and
    `edit-items.tsx` imports neither today — whichever direction the ruling takes, it is new composition on this
    screen, not an extension of existing wiring.
11. **Web's parity obligation, per the golden reference, is "permanent, zero-navigation price edit," not "a warm
    camera"** (`apps/web/.../page.tsx:1272-1283` inline `PriceEditRow`, `:1341-1406` permanent scan row) — web has
    no camera to keep warm, so a mobile fix's camera-liveness goal has no golden-reference precedent to match,
    only the "don't navigate away" one.
12. **L-095's discriminated-union lesson applies directly if `BarcodeFab`'s prop shape is touched or extended
    again**; **L-025 applies to any change on the native/web `ScanCamera`/`BarcodeScanner` pair**, since mobile
    Jest exercises neither platform's rendering behavior.
