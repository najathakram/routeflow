# Cause brief — B246 (+ B245 coverage row) scan-fab

> Written by the S1 evidence agent (Sonnet @ low, read-only). Facts with evidence only — every claim carries a
> file:line, a command output, or a quoted source. The suspected cause is recorded AS A CLAIM. No fix proposals.

**Scope note (from the launching task, not a judgment made here)**: this run scopes B246's eventual fix to
"Option C" — mount the existing `BarcodeFab` on `edit-items.tsx`'s non-picker branch, wired to the same scan
ladder + `addPickedToDraft`, hidden while the picker/modal is open. Option B (move the price control into
`ScanTray` over a paused camera) is quoted below only because it is verbatim part of the registry row's own
"suggested fix" text, not because this brief evaluates it. B245 rides along as a coverage-row bug.

Branch: `fix/B246-scan-fab` off `origin/master` @ `8a1f1eab`.

## The bugs as stated

### B246 — HIGH — Mobile order edit: no way back to the scanner after a price edit

**Source**, `.claude/campaign/bugs/B246.md` (frontmatter + body, quoted verbatim):

```
id: B246
title: Mobile order edit: no way back to the scanner after a price edit (6 taps + camera cold start)
location: Orders · mobile operator order edit
severity: high
batch:
tier:
state: uncampaigned
proof:
sensitive: true
sensitiveFor: money
closed:
files: apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx apps/mobile/components/ScanTray.tsx apps/mobile/components/BarcodeScanner.tsx
```

> ## Reported evidence
>
> edit-items.tsx:799 renders the ProductPicker (which owns the scanner behind its own local scanOpen state,
> :1758) and the line list as EXCLUSIVE branches. The only price control is DraftItemCard's onPressPrice (:928)
> opening PriceOverrideModal (:1361, actions Cancel/Apply only) -- after Apply the operator has no path back to
> the camera except: close the modal, leave the line list, tap Add product, tap the barcode icon, and wait
> through a full camera cold start (ScanCamera.web.tsx stops every track on unmount, so nothing is kept warm)
> -- 6 taps plus a cold start to resume scanning after ONE price edit. onScanMore exists as a pattern already,
> but only inside NewOrderScreen.tsx, never wired into edit-items.tsx. The web golden reference edits price
> inline and auto-refocuses its scan input -- zero navigation. Suggested fix AS A CLAIM: C = mount the existing
> BarcodeFab on edit-items' non-picker branch; B = move the price control into ScanTray over a PAUSED (not
> torn down) camera.

Ledger shard `.claude/campaign/bugs.jsonl:246` carries the identical `symptom` text plus
`"register":"open"`, `"batch":null`, `"source":"filed"`, `"filedAt":"2026-09-07T17:18:18.287Z"`,
`"sensitive":true`, `"sensitiveFor":["money"]`.

**Repro, independently walked against the code** (task asked to verify the prior trace, not trust it — every
hop below is a file:line this agent read directly, not copied from the registry text):

Starting state: operator is on the line list, `showPicker` is `false`, `priceEditItem` is `null`.

1. Tap a `DraftItemCard`'s price — `onPressPrice={() => setPriceEditItem(it)}`, edit-items.tsx:928 (the only
   `setPriceEditItem` call site in the file) → `PriceOverrideModal` mounts (edit-items.tsx:727-743, a real RN
   `<Modal transparent>`, :1402).
2. Tap **Apply** — edit-items.tsx:1445-1451 (Cancel is the only other control, :1442-1444) → `onSave` fires →
   `setDraft(...)` + `setPriceEditItem(null)` (edit-items.tsx:730-739) → modal closes.
3. Tap **Add product** — edit-items.tsx:959-972, `onPress={() => setShowPicker(true)}`, `disabled={!pricingReady}`
   → `showPicker` becomes `true` → the line-list branch (edit-items.tsx:838-979) unmounts and `ProductPicker`
   (edit-items.tsx:799-837 mount point, body :1737+) mounts in its place. Confirmed **mutually exclusive**:
   `{showPicker ? (<ProductPicker .../>) : (<>… line list …</>)}` — edit-items.tsx:799.
4. Tap the barcode icon in `ProductPicker`'s `SearchBar` trailing slot — edit-items.tsx:1890-1897,
   `onPress={() => setScanOpen(true)}` (`scanOpen` is `ProductPicker`'s own local state, declared :1758) →
   `{scanOpen ? (<BarcodeScanner .../>) : null}` (edit-items.tsx:1949-1950) mounts `BarcodeScanner` →
   `ScanCamera`/`ScanCamera.web` mounts → the camera-acquisition effect runs cold (below).

**Independently traced count: 3 explicit `Pressable`/`onPress` taps (Apply → Add product → barcode icon)
between the price edit and a live camera view — not 6.** See "Open unknowns."

**Structural fact**: the scanner isn't lost _because of_ the price edit — it's already gone the instant the
operator is anywhere on the line list, because `DraftItemCard.onPressPrice` (edit-items.tsx:908-928) only
renders in the non-picker branch, which by construction (edit-items.tsx:799) never coexists with
`ProductPicker`'s scanner. The price edit is the bug report's occasion, not a separate cause.

**Camera cold start, confirmed**: `ScanCamera.web.tsx`'s camera-acquisition `useEffect` (:348-509) calls
`start()` on mount (invoked :503); its cleanup (:505-508, `return () => { cancelled = true; stop(); }`) calls
`stop()` (defined :183-200) on unmount, which runs `for (const track of stream.getTracks()) track.stop()`
(:197) — every `MediaStreamTrack` is stopped, not paused. Because `BarcodeScanner`'s overlay is conditionally
mounted/unmounted (`{scanOpen ? (<BarcodeScanner/>) : null}` — edit-items.tsx:1949-1950 inside `ProductPicker`;
`BarcodeFab.tsx:155-168` inside the FAB, same pattern), every scanner close-then-reopen is a fresh
`getUserMedia` acquisition, never a resume.

**Refinement of the registry's "nothing is kept warm" claim**: `ScanCamera.web.tsx` DOES have a pause-only
primitive already — an `active` prop, mirrored into `activeRef` (:174-175), which gates `handleFrame` (:267,
`if (!activeRef.current) return;`) and `handleManual` (:291, same guard). But the decode `loop` itself
(:317-346) does **not** check `activeRef` — it keeps calling `detect()` regardless — and the camera-acquisition
effect (:348-509) is not gated by `active` at all. So `active=false` only discards decoded results; it does not
release the camera hardware. Only unmount (:505-508 → `stop()` → :197) does that. `ScanOrderSheet.tsx:137`
passes `active={!paused}` into its camera — i.e. the existing `NewOrderScreen.tsx` flow already uses this
logical-pause primitive for its ambiguous-pick/create-on-miss detours (see below), but that is a different
mechanism from "kept warm across a full close/reopen of the scan surface."

**Suspected cause (claim, unverified, quoted from the registry)**: "Suggested fix AS A CLAIM: C = mount the
existing BarcodeFab on edit-items' non-picker branch; B = move the price control into ScanTray over a PAUSED
(not torn down) camera." (B246.md, "Reported evidence"). This run is scoped to **C only** per the launching
task.

### B245 — LOW — Mobile-web scanner adapter wiring is unpinned (coverage row)

**Source**, `.claude/campaign/bugs/B245.md` + `bugs.jsonl:245` (quoted verbatim):

```
id: B245
title: Mobile-web scanner adapter wiring is unpinned: mobile Jest is pure-logic, so nothing tests
       ScanCamera.web.tsx's own sequencing
location: Scanning · mobile web (camera)
severity: low
sensitive: false
```

> ## Reported evidence
>
> ScanCamera.web.tsx's own adapter wiring -- the synchronous handleFrame call inside the decode .then(), the
> inFlightRef release in .finally(), the unconditional scanSettled drain, and the playScanCue call site -- has
> no coverage of its own: apps/mobile/**tests**/scan-engine.test.ts and scan-feedback.test.ts pin the pure
> lib/scan-engine.ts and lib/scan-feedback.ts logic those pieces call into, but mobile Jest never renders or
> exercises the component itself (pure-logic only, no camera/DOM harness). A refactor that re-nests the resolve
> call back inside the decode chain -- reintroducing the exact REG-B202 decode-starvation defect -- would keep
> every existing spec green.

**"Repro"**: this is a coverage-gap bug, not a wrong-value repro — there is no today-vs-expected VALUE
divergence to state as "input X gives Y, should give Z." The observable gap: a specific regression (re-nesting
the resolve call back inside the `.then()` decode chain, reintroducing the REG-B202 decode-starvation defect)
would ship with every existing mobile spec still green, because nothing in the suite renders
`ScanCamera.web.tsx`.

**Suspected cause (claim, unverified)**: implicit in the registry text — mobile Jest's harness is configured
pure-logic-only (see "Existing tests" below, primary-source config citation), so `ScanCamera.web.tsx`'s own
internal sequencing (as opposed to the pure `lib/scan-engine.ts`/`lib/scan-feedback.ts` functions it calls into)
has structurally never been exercised by any automated test.

## Code path

### B246

- `edit-items.tsx:799` — `{showPicker ? (<ProductPicker .../>) : (<>… line list …</>)}` — the exclusive-branch
  root of the bug.
- `edit-items.tsx:908-928` — `DraftItemCard` mapped from `draft`; `onPressPrice={() => setPriceEditItem(it)}`
  at :928.
- `edit-items.tsx:727-743` — `PriceOverrideModal` mount; `onSave`/`onCancel` both call `setPriceEditItem(null)`.
- `edit-items.tsx:1361-1457` — `PriceOverrideModal` body; Cancel :1442-1444, Apply :1445-1451, no third control.
- `edit-items.tsx:959-972` — "Add product" button.
- `edit-items.tsx:1737-1919` — `ProductPicker`; own `scanOpen` at :1758; barcode icon :1890-1897;
  `{scanOpen ? <BarcodeScanner/> : null}` :1949-1950.
- `edit-items.tsx:1800-1819` — `ProductPicker`'s `onScanned` built via `makeScanHandler` (from `lib/scan-ladder`,
  imported :58) with `onPickAndStay` wired to `addPickedToDraft` (:806, :829) for continuous add-without-closing.
- `edit-items.tsx:511-563` — `addPickedToDraft(p, kind)`: takes a resolved product object + `"case"|"piece"`,
  returns nothing (no `ScanOutcome`); increments an existing boxed line via `incrementLine`/`incrementLinePiece`
  or seeds a fresh `DraftItem`. `isSpecial = (cpMap.get(p.id) ?? customerTier ?? 1) !== 1` (:527) gates whether a
  remembered historical price may pre-fill a fresh line.
- `ScanCamera.web.tsx:348-509` — camera-acquisition effect; `start()` invoked :503; cleanup :505-508 calls
  `stop()`; `stop()` (:183-200) stops every `MediaStreamTrack` (:197).
- `BarcodeFab.tsx` (full file, 203 lines) — the registry's Option C mount target. Props (:9-19):
  `onScanned: (code: string) => ScanOutcome | Promise<ScanOutcome>`, `hidden?: boolean`, `continuous?: boolean`.
  Draggable FAB (`PanResponder` + `Animated.ValueXY`, position persisted via `useFabPositionStore`, :50); tap
  (:126-132, suppressed if the tap followed a drag past `DRAG_THRESHOLD=5`) opens
  `{scanOpen ? (<View style={styles.scannerOverlay}><BarcodeScanner continuous={continuous} onScanned={...}
onClose={...}/></View>) : null}` (:155-168) — its OWN local `scanOpen`, independent of any host screen's
  state.

### B245 — the four named call sites, pinned exactly

- **"the synchronous handleFrame call inside the decode .then()"** — `ScanCamera.web.tsx:337-338`:
  ```
  .then((code) => {
    if (code) handleFrame(code);
  })
  ```
  (part of the `loop` callback, :317-346; `handleFrame` itself defined :265-281 and documented at :258-264 as
  "SYNCHRONOUS: it only threads the code through the engine … nothing here is awaited").
- **"the inFlightRef release in .finally()"** — `ScanCamera.web.tsx:341-344`:
  ```
  .finally(() => {
    // Releases as soon as the DECODE settles, not the resolve — handleFrame
    // is synchronous, so this chain no longer awaits the code lookup.
    inFlightRef.current = false;
  });
  ```
- **"the unconditional scanSettled drain"** — `ScanCamera.web.tsx:248-252`, inside `resolveCode`'s `finally`:
  ```
  } finally {
    const step = scanSettled(engineRef.current);
    engineRef.current = step.next;
    if (step.indicator) onResolvingChangeRef.current?.(step.indicator === "on");
    if (step.startResolving) void resolveCode(step.startResolving);
  }
  ```
  (comment at :221-227 confirms it's deliberately unconditional — "the drain below is UNCONDITIONAL, same as
  native: a close must never strand a buffered code unresolved.")
- **"the playScanCue call site"** — `ScanCamera.web.tsx:245`: `playScanCue(cueForOutcome(outcome));` inside
  `resolveCode`'s `try` block (:236-247), commented (:239-244) as "purely observational … so this can't alter
  what happens next."

All four sit inside `resolveCode` (:235-256) and `loop` (:317-346), neither of which is called from any test —
see "Existing tests."

## History

`git log -3 --format="%h %ad %s" --date=short --` for every file named by the task:

| File                                | Last 3 commits                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edit-items.tsx`                    | `22372911` 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613) · `e6d1ab34` 2026-09-01 fix(orders): updateOrderItems authorization and line build (F06) (#573) · `5219e620` 2026-08-31 fix(scan): mobile scan-loss hardening + order idempotency (F30) (#555)   |
| `BarcodeFab.tsx`                    | `172a58b9` 2026-07-12 feat(mobile): mobile↔web parity waves (reconciled onto master) (#225) · `a9671398` 2026-06-19 fix(web): UX/UI audit fixes + lockfile resync + LF normalization (#93) · `0958565e` 2026-05-04 feat(mobile): floating draggable scan FAB + real invoice composer (#68)                 |
| `NewOrderScreen.tsx`                | `22372911` 2026-09-04 (#613) · `5219e620` 2026-08-31 (F30, #555) · `26ec7183` 2026-08-24 feat(trips): ad-hoc order trips, fulfillment mode, driver-payments opt-in (#435)                                                                                                                                  |
| `ScanCamera.web.tsx`                | `e2bc8b33` 2026-08-31 fix(mobile): port the F30 scan engine to the web camera path (#562) · `5be1dfac` 2026-08-11 fix: mobile-web scan, catalogue and credit-note defects (#323) · `4f5ed09b` 2026-08-07 feat: duplicate invoice detection, backdated orders, payment bank date, mobile scan rework (#322) |
| `lib/scan-ladder.ts`                | `5219e620` 2026-08-31 (F30, #555) · `fa89e94d` 2026-08-17 feat(mobile): one scan ladder everywhere, and a quiet catalogue (#353)                                                                                                                                                                           |
| `lib/scan-loop.ts`                  | `5219e620` 2026-08-31 (F30, #555) · `5be1dfac` 2026-08-11 (#323) · `f344a873` 2026-07-16 fix(mobile): hands-free repeat-scan increments qty + preserve line fields (#278)                                                                                                                                  |
| `lib/scan-engine.ts`                | `e2bc8b33` 2026-08-31 (#562) — one commit total (introduced in the F30 web-scan port)                                                                                                                                                                                                                      |
| `lib/scan-feedback.ts`              | `e2bc8b33` 2026-08-31 (#562) — one commit total                                                                                                                                                                                                                                                            |
| `lib/scan-tray.ts`                  | `22372911` 2026-09-04 (#613) · `df529bea` 2026-08-12 feat(mobile): piece-barcode scans, order sections, credit remainders, pricing parity (#340) · `4f5ed09b` 2026-08-07 (#322)                                                                                                                            |
| `components/ScanTray.tsx`           | `5be1dfac` 2026-08-11 (#323) · `4f5ed09b` 2026-08-07 (#322) — two commits total                                                                                                                                                                                                                            |
| `components/BarcodeScanner.tsx`     | `fa89e94d` 2026-08-17 (#353) · `4f5ed09b` 2026-08-07 (#322) · `172a58b9` 2026-07-12 (#225)                                                                                                                                                                                                                 |
| `components/BarcodeScanner.web.tsx` | `fa89e94d` 2026-08-17 (#353) · `4f5ed09b` 2026-08-07 (#322) · `172a58b9` 2026-07-12 (#225)                                                                                                                                                                                                                 |

`BarcodeFab.tsx`'s most recent commit (172a58b9, 2026-07-12) predates `edit-items.tsx`'s and `ScanCamera.web.tsx`'s
most recent scan-hardening work (F30, #555/#562/#573, all 2026-08-31) by 6+ weeks — `BarcodeFab.tsx` has not been
touched by any of the F30/REG-B202 scan-loss hardening pass.

## How `BarcodeFab` is used today (every call site)

Exactly 4 render call sites in the whole mobile app (grep for `BarcodeFab` returns 6 file hits total: the 4
below, `BarcodeFab.tsx` itself, and `lib/fab-position-store.ts`, which `BarcodeFab.tsx` imports — not a caller).
**`NewOrderScreen.tsx` does not import or render `BarcodeFab`** — confirmed by grep, zero matches.

1. `apps/mobile/app/(driver)/route/stop/[stopId]/adjust.tsx:474` —
   `<BarcodeFab onScanned={handleScanned} hidden={!!licenseBlock} />` (no `continuous` → single-shot).
   `handleScanned` (:192-…) is hand-rolled: calls `resolveProductByCode` directly, no `makeScanHandler`,
   returns `Promise<void>`.
2. `apps/mobile/app/(operator)/products/stock-count/[id].tsx:565-569` —
   `<BarcodeFab continuous onScanned={wrappedHandleScanned} hidden={pickerOpen || reviewOpen || !!createSheet
|| !!attachCode} />`. `wrappedHandleScanned` (:288-292) wraps `handleScanned` (:263-287), which calls
   `resolveProductByCode` directly and hand-builds `ScanOutcome` shapes (e.g.
   `{ feedback: { kind: "error", text: archivedMessage(res.product) } }`) — no `makeScanHandler`.
3. `apps/mobile/app/(operator)/products/adjust-picker.tsx:86` —
   `<BarcodeFab onScanned={onScanned} hidden={scanOpen} />`; the same screen also renders a second, non-FAB
   `<BarcodeScanner onScanned={onScanned} onClose={...} />` (:82-84) sharing the identical handler.
4. `apps/mobile/app/(operator)/movements.tsx:157` — `<BarcodeFab onScanned={onScanned} hidden={scanOpen} />`;
   `onScanned` (:76-…) calls `resolveProductByCode` directly and only sets a list filter (`setProductFilter`) —
   doesn't add a line at all.

**Fact**: none of the 4 existing `BarcodeFab` call sites wire it to `makeScanHandler` (the shared ladder
`ProductPicker` and `NewOrderScreen.tsx` both use for ambiguous-match/create-on-miss handling). Every existing
integration is a direct, single-candidate `resolveProductByCode` call. Wiring `BarcodeFab` to `makeScanHandler` +
a draft-add function (as the launching task frames Option C) has no precedent anywhere in this codebase today.

**Established, precedented pattern**: all 4 call sites pass `hidden={<some overlay-open flag>}` to suppress the
FAB while their own picker/modal/sheet is up — the same shape the launching task describes wanting for Option C.

## `onScanMore` / how `NewOrderScreen` wires its scan ladder + add-to-draft equivalent

`onScanMore` exists at exactly one place in the mobile app: `NewOrderScreen.tsx`. It is **not** a `BarcodeFab`
prop — `NewOrderScreen.tsx` doesn't render `BarcodeFab` at all. Instead:

- `NewOrderScreen.tsx:1108-1116` —
  ```
  const handleBarcodeScanned = makeScanHandler<Product>({
    products,
    accept: acceptScannedProduct,
    resolve: (c, signal) => resolveProductByCode<Product>(c, signal),
    onAmbiguous: setPickCode,
    onCreate: canCreateProducts ? setCreateCode : undefined,
  });
  ```
  This IS the shared ladder; `acceptScannedProduct` is this screen's `addPickedToDraft` equivalent.
- `NewOrderScreen.tsx:2223-2243` — `<ScanOrderSheet visible={scanOpen} paused={createCode != null || pickCode
!= null} … onScanned={handleBarcodeScanned} onDone={() => setScanOpen(false)} />` — a full-screen scan sheet
  (not a FAB). `ScanOrderSheet.tsx:137` passes `active={!paused}` to its inner camera — kept mounted, logically
  paused (see the `active`-prop nuance above), while an ambiguous-pick or create-on-miss sub-sheet is up.
- `NewOrderScreen.tsx:2333-2336` — the actual `onScanMore` prop, passed to `<CartModal onScanMore={() => {
setCartOpen(false); setScanOpen(true); }} .../>` (prop declared :2726, invoked on tap :2840). It closes the
  cart review modal and re-opens `ScanOrderSheet` by flipping the SAME `scanOpen` boolean that originally opened
  it. This is a "return from the cart to the scan sheet" button, not a FAB — and whether it keeps the camera
  warm across that close/reopen depends on whether `visible=false` on `ScanOrderSheet` tears down
  `ScanCamera.web` the same way unmount does; not traced further here (open unknown below).

## The state `edit-items.tsx` keeps

All `useState` hooks, file order:

- `floorAcked` (:230) — `Set<string>` of margin-floor "sell anyway" acks, keyed by `lineId ?? productId`.
- `draft` (:232) — `Record<string, DraftItem>` keyed by `productId`. `DraftItem` shape (:83-…): `productId`,
  `qty`, `boxes?`, `pieces?`, `unitsPerBox?`, `unitPrice`, `catalogPrice`, `name`, `unit?`, `overrideReason?`,
  `notes?`, `lineId?`, `boxSplit?`, `substituteProductId?`.
- `unlisted` (:235) — ad-hoc (no `productId`) lines, kept separate from `draft`.
- `pendingDeletes` (:239) — existing line ids removed this session.
- `unlistedModalOpen` (:240), `showPicker` (:241), `substituteFor` (:242), `priceEditItem` (:243) — the four
  modal/branch toggles.
- `licenseBlock` (:244), `creditBlock` (:245) — guard-modal payloads.
- `selectedCreditIds` (:252), `creditsTouched` (:253), `createCreditOpen` (:262), `justCreatedCredits` (:263) —
  apply-credit section state.

Other facts directly relevant to a fix's blast radius:

- `pricingReady` (:207-208) gates "Add product"/Substitute until the customer + customer-price queries settle
  (in-code cite: B62/REG-B62).
- `isSpecial = (cpMap.get(p.id) ?? customerTier ?? 1) !== 1` (:527) — the SPECIAL/tier-lock check inside
  `addPickedToDraft`, guarding whether a remembered historical price may pre-fill a fresh line (never over a
  SPECIAL tier price).
- Boxed-line totals: `DraftItemCard` (:1079-1086) and `UnlistedDraftCard` (:1478) both compute line totals via
  `computeLineSubtotal(...)`, imported from `@routeflow/pricing` (:30).
- Margin-floor ack UI (:1189-1194, `{canEditPrice && below && !acked && floorPrice != null ? (<View>… "Set to
floor $…" …</View>) : null}`) lives inside `DraftItemCard` — a second, one-tap price-fix path alongside
  `PriceOverrideModal`, independent of it.

## Existing tests around this behavior

**Primary-source structural fact** — `apps/mobile/jest.config.js`:

```
testEnvironment: "node",                              // :4
testMatch: ["**/__tests__/**/*.test.ts"],              // :11 — .ts only, NOT .tsx
```

Comment at :10: "Only run the pure-logic unit tests — not the Expo/RN component files." `moduleNameMapper`
(:30-38) stubs only `expo-secure-store`, `@routeflow/ui`, `@routeflow/types` — no `react-native` or
`react-test-renderer` mapping. Grep for `react-test-renderer|@testing-library/react-native|render\(` across all
of `apps/mobile/__tests__/` returns **zero files**.

**Nothing in the suite renders `BarcodeFab`, `ProductPicker`, `edit-items.tsx`, or `ScanCamera`/`ScanCamera.web`.**
The closest thing to a "component" assertion is `scan-camera-buffer.test.ts:141-155`
(`describe("ScanCamera delegates to the pending buffer (REG-B192 wiring)")`), which does **not** render
`ScanCamera.tsx` — it `readFileSync`s the file as text (:142) and regex-`toMatch`es the source, e.g.:

```
expect(scanCameraSrc).toMatch(/from\s+["']\.\.\/lib\/scan-pending-buffer["']/);
expect(scanCameraSrc).not.toMatch(/if\s*\(\s*busyRef\.current\s*\)\s*return\s*;/);
```

Grep for `edit-items|editItems|BarcodeFab` across `__tests__/` returns exactly 3 hits, none a behavior test:

- `substitute-line.test.ts:21` — comment: "Verbatim mirror of edit-items.tsx `save()`'s draft → DiffCatalogLine
  map" — a hand-copied pure function, pinned independently of the real file (not exercising the real one).
- `toast-ios.test.ts:6` — lists `edit-items.tsx` only as one of several call sites in a comment about the iOS
  toast fallback fix.
- `operator-tabs.test.ts:29-32` — asserts only that tab-bar highlight logic recognizes the route-segment array
  `["(operator)","(tabs)","orders","[id]","edit-items"]` — pure string routing, unrelated to scan or price.

Scan-related pure-logic specs and what each asserts (`describe(` titles, file:line):

- `scan-tray.test.ts` — `bumpScanOrder` (:29), `nextFlash` (:52), `trayRowsFrom` (:64) — pure functions in
  `lib/scan-tray.ts` (tray ordering/flash — not rendering).
- `scan-engine.test.ts` — `"scan-engine (REG-B202)"` (:27), `"scan-engine shape"` (:512) — pins `lib/scan-engine.ts`'s
  pure decode-loop logic.
- `scan-feedback.test.ts` — `cueForOutcome` (:21), `safePlay` (:69), `"scan-cue.web … the SHIPPED player is
total"` (:110) — pins `lib/scan-feedback.ts`/`lib/scan-cue.web.ts`.
- `scan-camera-buffer.test.ts` — `"scan-pending-buffer (REG-B192)"` (:29, pure buffer functions) plus the
  source-text regex check above (:141).
- `scan-ladder.test.ts` — `makeScanHandler` local fast path (:56) / server fallback (:84) / miss (:132) /
  products getter (:156); `runWedgeSubmit` (:168) — the shared ladder both `ProductPicker` and `NewOrderScreen`
  call into.
- `scan-fallback.test.ts` — `scanFallbackContent` (:21).
- `wedge-scan.test.ts` — `looksLikeScanCode` (:8), `findExactScanMatch` (:22), `scanUnitKind` (:58) — used by
  `edit-items.tsx`'s auto-add-on-search effect (:1862-1879).
- `scan-loop.test.ts` — `gateScan` (:22, :143 — dedupe/cooldown gate).
- `barcode-normalize.test.ts` — `upcEToUpcA` (:17), `normalizeScanCode` (:32), `pickBestScanMatch` (:66),
  "mirror integrity" (:95).
- `barcode-resolve-archived.test.ts` — `resolveProductByCode` archived-product handling (:34).
- `scan-line-units.test.ts` — `toBillLine` variants: pieces (:13), boxes-exact (:33), NOT_DIVISIBLE (:52),
  PPB_MISMATCH (:81), money invariant (:101), round-trip (:117).

None of the above assert anything about `BarcodeFab`'s drag/position/hidden behavior, `PriceOverrideModal`, or
the picker↔line-list branch toggle.

## Production evidence

None. Both rows carry `"source":"filed"` in `bugs.jsonl` (filed directly via `bugs.mjs file`, per each row's
History section: "2026-09-07 · **filed** · filed directly via `bugs.mjs file`") — not from a production
incident. No log lines, row counts, or ids are attached to either row.

## Relevant lessons (`.claude/lessons/LESSONS.md`)

Grepped case-insensitively for `scan|mobile|pure-logic|pure logic` across the whole register. A literal
`pure-logic`/`pure logic` string does **not** occur anywhere in it. Exactly one entry is genuinely on-topic:

- **L-025** (2026-09-01, testing): native Google Sign-In was dead because its failure sat inside a `!isWeb`
  branch that no automated surface ever runs (everything automated takes the web/`localStorage` branch).
  **Lesson (quoted): "A `Platform`/`isWeb` branch is untested code unless something runs that platform. When you
  touch one side of such a branch, either exercise the other side or state plainly that it is unverified."**
  Guard: none (judgment) — grep `isWeb`/`Platform.OS` in any touched file. Directly on point for B245
  (`ScanCamera.web.tsx` is exactly this shape of platform-conditional file, paired with native `ScanCamera.tsx`)
  and relevant to any B246 fix touching `BarcodeFab` → `BarcodeScanner`, which itself resolves to `.web`/native
  variants (`BarcodeScanner.tsx` / `BarcodeScanner.web.tsx`).

Tangential (mentions "mobile jest" but is about enum mirrors, not scan or render testing): **L-072**
(2026-09-03, domain) — guard note: "the mobile jest stub that can't `require` the shared package directly" — a
module-resolution fact about the same harness, unrelated to component rendering.

## Open unknowns

- **Tap-count discrepancy**: the registry claims "6 taps"; this brief's static trace finds 3 explicit
  `Pressable.onPress` calls between Apply and a mounted camera (Apply itself, Add product, barcode icon). S2
  should determine whether the extra taps are real (e.g. scrolling to reach "Add product" past a long draft
  list — not verifiable from source alone) or whether "6" is an approximate/rhetorical count in the filed
  report.
- **Registry `files:` frontmatter doesn't match the task's Option C target**: `B246.md`'s YAML `files:` lists
  `edit-items.tsx`, `ScanTray.tsx`, `BarcodeScanner.tsx` — but `edit-items.tsx` imports neither `ScanTray` nor
  `ScanOrderSheet` today (grep: zero matches for either name in the file); it imports `BarcodeScanner` directly
  (already used by `ProductPicker`'s own scanner). `ScanTray.tsx` is currently reachable only via
  `ScanOrderSheet.tsx` (`NewOrderScreen.tsx`'s flow). `BarcodeFab.tsx` — the actual Option C mount target per
  the launching task — is not in the registry row's own `files:` list at all. Treat the row's prose, not its
  frontmatter, as the operative description.
- **Whether `NewOrderScreen`'s `onScanMore` path keeps the camera warm**: `CartModal`'s `onScanMore`
  (:2333-2336) flips `scanOpen` off→on via the same state `ScanOrderSheet`'s `visible` prop is bound to
  (:2223). Whether `ScanOrderSheet` tears down `ScanCamera.web`'s stream on `visible=false` the same way
  `ScanCamera.web.tsx`'s own unmount effect does (:505-508) was not traced in this brief (would need reading
  `ScanOrderSheet.tsx`'s full mount logic, out of the file list this run was scoped to) — if it does, "the
  pattern already exists in NewOrderScreen" pays a cold start on every cart-review round-trip too; if it
  doesn't, `ScanOrderSheet` has a keep-warm mechanism `BarcodeFab`/`BarcodeScanner` currently lack.
- **No precedent for `BarcodeFab` + `makeScanHandler` together**: every existing `BarcodeFab` call site
  hand-rolls a direct `resolveProductByCode` call; none uses the shared ladder or its `continuous`-mode
  add-and-stay path (`onPickAndStay`). S2 should confirm there's no hidden incompatibility between
  `BarcodeFab`'s own `continuous` prop/local `scanOpen` and `makeScanHandler`'s ladder before ruling on the
  wiring shape.
- Whether `pricingReady=false` (customer/price queries still in flight) should gate a newly-mounted
  `BarcodeFab` on `edit-items.tsx` the same way it gates "Add product" today (:960-962) — not addressed by the
  registry, not decided here.

## Facts the ruling needs

1. `edit-items.tsx:799` makes `ProductPicker` and the line list mutually exclusive branches — the picker's
   scanner and `DraftItemCard`'s price control can never be on screen together today.
2. `PriceOverrideModal` (edit-items.tsx:1361-1457) has exactly two controls, Cancel (:1442-1444) and Apply
   (:1445-1451) — no third "scan more"/return-to-camera control exists there today.
3. Independently traced tap count from Apply to a mounted (cold-starting) camera is **3** explicit taps (Apply,
   Add product :959-972, barcode icon :1890-1897), not the registry's stated 6 — flagged as an open unknown,
   not resolved here.
4. `ScanCamera.web.tsx` tears the camera down completely on unmount: `stop()` (:183-200) calls `track.stop()`
   on every `MediaStreamTrack` (:197), invoked from the mount-effect's cleanup (:505-508). Its `active` prop
   (:174-175, :267, :291) only gates whether a decoded frame is acted on — it does not release the camera
   hardware; only unmount does that.
5. `BarcodeFab.tsx` (203 lines, full file read) is self-contained: draggable position (persisted via
   `useFabPositionStore`), its own local `scanOpen`, and a `hidden`/`continuous` prop contract (:9-19) — it owns
   nothing about scan-ladder resolution; the caller's `onScanned: (code) => ScanOutcome` must supply that.
6. All 4 existing `BarcodeFab` render call sites (adjust.tsx:474, stock-count/[id].tsx:565-569,
   adjust-picker.tsx:86, movements.tsx:157) pass a `hidden={<overlay-open flag>}` prop — established precedent
   for "hide the FAB while a picker/modal is open," matching what Option C needs.
7. None of the 4 existing `BarcodeFab` call sites use `makeScanHandler` (the shared scan ladder) — each
   hand-rolls a direct `resolveProductByCode` call. There is no existing example of `BarcodeFab` wired to the
   ladder plus a draft-add function.
8. `NewOrderScreen.tsx` does not import `BarcodeFab` at all; its `onScanMore` (:2333-2336) is a `CartModal`
   prop that reopens the same `ScanOrderSheet`/`scanOpen` state the screen already had, not a FAB-based pattern.
9. `edit-items.tsx`'s `addPickedToDraft(p, kind)` (:511-563) takes a resolved product object +
   `"case"|"piece"`, not a raw scanned code string, and returns nothing — `BarcodeFab.onScanned` expects
   `(code: string) => ScanOutcome`; bridging the two needs the same `makeScanHandler` wrapper `ProductPicker`
   already builds at edit-items.tsx:1800-1819.
10. `apps/mobile/jest.config.js:11` matches only `**/__tests__/**/*.test.ts` (not `.tsx`) under
    `testEnvironment: "node"` (:4) — no test in this repo can render `BarcodeFab`, `ProductPicker`, or
    `edit-items.tsx` today. Any new coverage for Option C is necessarily pure-logic (e.g. pinning a wiring
    function's shape or, per the `scan-camera-buffer.test.ts:141-155` precedent, a source-text regex check) —
    not a real render/interaction test.
11. Margin-floor ack (edit-items.tsx:1189-1194) is a second, independent price-change path on the same line,
    separate from `PriceOverrideModal` — a fix should account for both re-losing scanner access, not just the
    modal's Apply.
12. B246.md's own `files:` frontmatter names `ScanTray.tsx`/`BarcodeScanner.tsx`, not `BarcodeFab.tsx`/
    `NewOrderScreen.tsx` — the registry metadata doesn't match the launching task's stated Option C target;
    the row's prose (not its frontmatter) is the operative description.
