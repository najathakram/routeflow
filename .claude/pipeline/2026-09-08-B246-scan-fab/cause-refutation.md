# Cause refutation — B246 (+ B245) scan-fab

> S2, Opus @ high, read-only. Method: assume the S1 brief and the Lead's Option C are WRONG and look for the
> disproof. Every line below was read in `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F25` (verified
> `git diff --stat master -- apps/mobile` = EMPTY, so the `fix/marketing-distributors-redirect` checkout is
> byte-identical to master for every file cited). Nothing was run; no file was modified outside this run dir.

## Verdicts at a glance

| #   | Sub-claim                                                                   | Verdict                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a  | B246's behaviour is real: no path back to a camera after a price edit       | **confirmed**                                                                                                                                                                           |
| 1b  | "6 taps"                                                                    | **refuted as stated** — 3 explicit `onPress` (4 counting the price chip); 6 is not derivable from source                                                                                |
| 1c  | The camera truly cold-starts                                                | **confirmed** — and the brief's mitigating `active` prop is NOT on this path (sub-refutation)                                                                                           |
| 2   | "The picker and the line list are exclusive branches" is the cause          | **refuted as the operative cause** — the cause is ProductPicker's _local ownership of every scan primitive_                                                                             |
| 3   | Option C shortens the path                                                  | **confirmed in part / refuted in part** — removes the branch swap + 1 tap; does NOT remove the cold start, cannot reuse the existing `makeScanHandler`, and dead-ends on ambiguous/miss |
| 4   | Registry frontmatter (`ScanTray.tsx`/`BarcodeScanner.tsx`) matches Option C | **confirmed stale** (S1's finding stands); B245 belongs to neither option and cannot be a REG repro                                                                                     |
| 5   | Web-parity claim                                                            | **confirmed, but narrower than the registry implies** — parity = permanent coexistence / zero navigation, NOT a warm camera                                                             |

---

## 1. Is the wrong behaviour real as stated?

### 1a. No return path — **confirmed**

I read the entire non-picker branch (`edit-items.tsx:838-999`) and enumerated every `Pressable` in it:
`+ New credit note` (:858), a credit row (:870), `DraftItemCard`'s own controls, `Add product` (:959),
`Add unlisted item` (:973), `Save changes` (:988) — plus `DraftItemCard`'s `Substitute` (:1238) and price chip
(:1248). **None of them opens a camera.** The only camera mount on this screen is
`{scanOpen ? <BarcodeScanner .../> : null}` at :1949-1958, inside `ProductPicker`. Confirmed.

### 1b. Tap count — **refuted as stated**

From Apply to a mounted camera the code supports exactly **three** explicit `onPress` hops:

- `PriceOverrideModal` Apply — :1445-1451 (Cancel :1442-1444 is the only sibling; there is no third control)
- `Add product` — :959-972, `onPress={() => setShowPicker(true)}`
- barcode icon in `ProductPicker`'s `SearchBar` trailing slot — :1890-1897, `onPress={() => setScanOpen(true)}`

Counting the price chip that _opened_ the modal (`onPressPrice` :928 → the chip at :1248-1250) gives **four**.
Six is only reachable by counting a scroll-to-bottom gesture (the ScrollView puts `Add product` after N draft
cards) and a keyboard/field interaction — neither is a `Pressable` and neither is derivable from source.
**S1's count of 3 is the defensible number; the ruling must not repeat "6 taps" as a fact.** The defect does not
depend on the count.

### 1c. Cold start — **confirmed**; the brief's mitigating primitive is **not on this path**

Cold start confirmed exactly as the brief states: `ScanCamera.web.tsx` `stop()` (:183-200) runs
`for (const track of stream.getTracks()) track.stop()` (:197) and is called from the acquisition effect's
cleanup (:505-508, `return () => { cancelled = true; stop(); }`). `active` (default `true`, :135; mirrored to
`activeRef` :174-175) only guards `handleFrame` (:267) and `handleManual` (:291); the decode `loop` (:317-346)
never reads it. Native `ScanCamera.tsx:25-26` documents the same contract ("pause without tearing the camera
down").

**Sub-refutation the brief missed.** `active` is unreachable from B246's surface:

- `BarcodeScanner.tsx:30-35` and `BarcodeScanner.web.tsx:27-32` implement `paused` by **swallowing the code**
  (`const guardedScan = (code) => (paused ? undefined : onScanned(code))`) and render
  `<ScanCamera onScanned={guardedScan} onOutcome={...} continuous={...} />` (native :80-85, web :60-73) —
  **no `active` prop is ever passed.**
- `BarcodeFab.tsx:155-168` does not even expose `paused`, so the FAB path has no pause lever at all.
- `ScanOrderSheet.tsx:137` is the _only_ consumer of `active` (`active={!paused}`), and it talks to `ScanCamera`
  directly, not through `BarcodeScanner`.

**And `ScanOrderSheet` is not a keep-warm precedent either**: `ScanOrderSheet.tsx:128-131` renders
`<Modal visible={visible}>` … `{visible && granted ? <ScanCamera .../> : …}` — so `NewOrderScreen`'s
`onScanMore` (:2333-2336) flipping `scanOpen` off then on unmounts the camera and pays the same cold start.
**This resolves S1's open unknown #3: nothing in this app keeps a camera warm across a close/reopen.**

---

## 2. Is "exclusive branches" the actual cause?

**Refuted as the operative cause.** The ternary at `edit-items.tsx:799` is real
(`{showPicker ? (<ProductPicker …/>) : (<>… line list …</>)}`) — but exclusivity alone would be harmless if a
scan entry point existed at parent scope. It doesn't, because **`ProductPicker` owns every scan primitive
locally**:

| Primitive                                                                | Line          | Scope             |
| ------------------------------------------------------------------------ | ------------- | ----------------- |
| `scanOpen`                                                               | :1758         | ProductPicker     |
| `pickCode` / `createCode`                                                | :1769-1770    | ProductPicker     |
| `useProductSearch()` (the ladder's local fast-path rows)                 | :1784         | ProductPicker     |
| `onScanned = makeScanHandler({...})`                                     | :1800-1819    | ProductPicker     |
| wedge handler + auto-add effect                                          | :1831-1879    | ProductPicker     |
| `<BarcodeScanner>`                                                       | :1949-1958    | ProductPicker     |
| `<InlineToast>` (the iOS toast host, REG-B151)                           | :1961         | ProductPicker     |
| `<ProductPickerSheet>` (ambiguous) / `<InlineCreateProductSheet>` (miss) | :1964 / :1981 | ProductPicker     |
| **`addPickedToDraft`**                                                   | **:511-568**  | **parent screen** |

Grep confirms the split: `useProductSearch` is imported at :25 and called **only** at :1784;
`ProductPickerSheet`/`InlineCreateProductSheet`/`InlineToast` are imported at :55-57 and rendered **only** at
:1964 / :1981 / :1961.

**Diverging structure to name in the ruling:** the screen's draft writer is at parent scope (:511) while the
entire scan ladder that feeds it is at picker scope (:1758-1819). The `:799` ternary is the _symptom surface_,
not the cause. This distinction is load-bearing: it is exactly why Option C is not "mount the FAB and pass the
existing handler".

---

## 3. Would Option C actually shorten the path?

### What `BarcodeFab` does at its 4 call sites (all read)

| #   | Call site                                              | Props                                                                           | Handler                                                                                                                                                              |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `app/(driver)/route/stop/[stopId]/adjust.tsx:474`      | `onScanned` + `hidden={!!licenseBlock}` (no `continuous`)                       | hand-rolled `resolveProductByCode`                                                                                                                                   |
| 2   | `app/(operator)/products/stock-count/[id].tsx:565-569` | `continuous`, `hidden={pickerOpen ‖ reviewOpen ‖ !!createSheet ‖ !!attachCode}` | `wrappedHandleScanned` (:288-292) then `handleScanned` (:263-286): direct `resolveProductByCode`, hand-built `ScanOutcome`, miss handed to `chooseAction` (:294-300) |
| 3   | `app/(operator)/products/adjust-picker.tsx:86`         | `onScanned` + `hidden={scanOpen}`                                               | shared with the screen's own `<BarcodeScanner>` (:83)                                                                                                                |
| 4   | `app/(operator)/movements.tsx:157`                     | `onScanned` + `hidden={scanOpen}`                                               | direct `resolveProductByCode`; only sets a filter                                                                                                                    |

`onPress` (`handlePress`, :126-132) flips the FAB's **own local `scanOpen`** and mounts
`<View style={scannerOverlay}><BarcodeScanner continuous={continuous} …/></View>` (:155-168) — an absolutely
positioned View at `zIndex: 2000`, **not** a `Modal`. `hidden` short-circuits with `if (hidden) return null`
(:134), which destroys that overlay (and the camera) while preserving `scanOpen`, so un-hiding re-opens a
**cold** camera.

The mount shape Option C needs is precedented verbatim at `movements.tsx:152-158`: `<BarcodeFab/>` as the last
child of `SafeAreaView`, after the scroll content.

### Does it shorten the path? — partly

After Apply: **FAB tap then camera** = 1 hop, vs `Add product` then barcode icon = 2 hops. **Option C removes
exactly one tap and the branch swap; it does NOT remove the cold start** (§1c — no keep-warm mechanism exists
anywhere in the app, and `BarcodeFab` has no pause lever). The registry title is "6 taps + camera cold start";
**Option C addresses the first half only.** The ruling must say so explicitly or the close-out proof will
overclaim.

### Reasons the FAB _cannot_ simply call the existing ladder

**(a) `makeScanHandler` is not reusable from the line-list branch.** The instance at :1800-1819 closes over
`products: () => products` (picker-local `useProductSearch`), `onAmbiguous: setPickCode`,
`onCreate: canCreateProducts ? setCreateCode : undefined` and an `accept` that calls `onPickAndStay` / `onPick` /
`setScanOpen`. A parent-scope handler needs its own rows source (or `products: []`, which disables the local
fast path and forces a server round-trip on **every** scan) **and** its own ambiguous/create sheets. This is a
new ladder, not a reused one. _(Resolves S1 open unknown #4: there is no hidden incompatibility between
`BarcodeFab`'s `continuous` / local `scanOpen` and the ladder — the incompatibility is scope, plus (b).)_

**(b) — the finding that most threatens Option C — `BarcodeScanner` renders NO `feedback.action` button.**
`scan-loop.ts:158-179` defines `ScanFeedbackAction` and documents it as rendering "a button in the pill instead
of stranding the operator", and the ladder returns exactly that on ambiguous
(`{label:"Choose", onPress: () => deps.onAmbiguous(trimmed)}`, `scan-ladder.ts:106`) and on miss
(`{label:"Create", …}`, :149). A grep for `.action` across every scan surface returns hits in
**`ScanOrderSheet.tsx` only** (:104, :165, :171-184). `BarcodeScanner.tsx:91-102` and
`BarcodeScanner.web.tsx:76-87` render the icon and `feedback.text` and **drop `feedback.action` entirely.**

Consequences the ruling must not get wrong:

- A `BarcodeFab` wired to `makeScanHandler` **dead-ends** on ambiguous and on miss — the operator sees
  `3 products match "…"` / `No product for "…"` with no button — the exact strand the ladder was built to
  prevent.
- This is **pre-existing**: `ProductPicker`'s own camera (`edit-items.tsx:1950`, `onScanned={onScanned}`) has the
  same dead end today. The ladder's hand-off currently works only via the wedge path, where
  `runWedgeSubmit` (`scan-ladder.ts:183-186`) invokes `action.onPress()` programmatically, and via
  `ScanOrderSheet`.
- `scan-ladder.test.ts:98-143` pins that the ladder _returns_ `Choose`/`Create`; nothing pins that a surface
  _renders_ them — which is how this shipped.
- So the ruling has a real fork: **(i)** scope the FAB to a single-candidate `resolveProductByCode` handler
  (matching all 4 existing FAB call sites) and accept a plain-pill miss, touching no shared component; or
  **(ii)** render `feedback.action` in `BarcodeScanner` — correct, but blast radius is 8 mounts
  (`BarcodeFab:157`, `edit-items:1950`, `ProductPickerSheet:170`, `movements:153`, `adjust-picker:83`,
  `vendor-bills/new:388`, `(operator)/products/scan:40`, `(customer)/scan:63`).

**(c) `BarcodeFab` has no `paused` prop.** If Option C mounts parent-level ambiguous/create sheets, they stack
over a **live, still-decoding** camera; the only lever, `hidden`, tears the camera down (:134). `ScanOrderSheet`
solves this with `active={!paused}`; the FAB path cannot express it without a new prop.

**(d) `pricingReady` is mandatory, not optional.** `addPickedToDraft` calls `tierPriceFor` (:318-319,
`getTierPrice(p, cpMap.get(p.id) ?? customerTier ?? 1)`) and the `isSpecial` gate (:527); both read `cpMap` /
`customerTier`, which default to tier 1 while the customer + customer-price queries are in flight — the exact
window `pricingReady` (:207-208) was added to close, in-code cited as **B62/REG-B62**, and why `Add product` is
`disabled={!pricingReady}` (:962). **An ungated FAB reintroduces REG-B62 on the mobile order editor.**
_(Resolves S1 open unknown #5: the FAB MUST be gated.)_

### Non-blockers (checked, and they are fine)

- **`addPickedToDraft` scope**: at parent scope (:511-568) and already handed down as `onPickAndStay` (:806) —
  **reachable from the line-list branch with no refactor.** S1's worry that "handlers only exist inside the
  picker's scope" is TRUE for the ladder and FALSE for the draft writer.
- **Boxed lines / SPECIAL lock**: `addPickedToDraft` already owns both — `incrementLine` / `incrementLinePiece`
  with `boxSplit: true` (:534-541), fresh boxed seeds (:560-565), `isSpecial` (:527) gating the remembered-price
  pre-fill (:547-551). The FAB adds no new money math.
- **`computeLineSubtotal`**: used by the render path (`DraftItemCard` / `UnlistedDraftCard`), never by the add
  path. Untouched by Option C.
- **Margin-floor ack** (:1189-1198): a render-time derivation off `floorAcked` / `canEditPrice`. Unaffected — but
  note it is a **second** price-change path on the same card, so any "did we restore scan access?" proof must
  cover it as well as `PriceOverrideModal`.
- **Z-order**: `ProductPickerSheet` / `InlineCreateProductSheet` are `Modal`-based, so they layer above the FAB's
  plain-View overlay on both platforms. The FAB overlay conversely sits _below_ `PriceOverrideModal` (:1402,
  a real `<Modal>`), which is why `hidden` must include `!!priceEditItem`.

---

## 4. `ScanTray.tsx` / `BarcodeScanner.tsx`, and where B245 belongs

- **`ScanTray.tsx`: Option C does not touch it, and Option B would be far wider than the registry implies.**
  `edit-items.tsx` imports neither `ScanTray` nor `ScanOrderSheet` (grep: zero hits); `ScanTray` is reachable
  only through `ScanOrderSheet.tsx:212` (NewOrderScreen and `invoices/new`). Its prop surface
  (`ScanTray.tsx:25-35`) is `rows / flash / onChangeQty / onIncrement / onDecrement / onRemove` — **no price
  control exists**, so Option B means adding one to a component shared by two other money surfaces. S1's
  "frontmatter is stale, prose is operative" verdict is **confirmed**.
- **`BarcodeScanner.tsx`: touched by Option C only under fork (ii) of §3(b).** Not otherwise.
- **B245 belongs to neither option's code change, and it cannot be a REG repro.** `apps/mobile/jest.config.js`
  is `testEnvironment: "node"` (:4) with `testMatch: ["**/__tests__/**/*.test.ts"]` (:11, `.ts` only), comment at
  :10 "Only run the pure-logic unit tests — not the Expo/RN component files", and no
  `react-test-renderer` / `@testing-library/react-native` mapping (:30-38). Nothing can render
  `ScanCamera.web.tsx`. The only precedent is the source-text regex assertion in
  `scan-camera-buffer.test.ts:141-155`. **A source-text pin can never fail today on its own wrong value, so B245
  must be classified as a PIN outside the red gate** — filing it as a REG test would make
  `redGate.behaviorallyRed` unsatisfiable for this run. Its natural content is the four sequencing facts S1
  already pinned exactly (`ScanCamera.web.tsx:337-338`, :341-344, :248-252, :245).

---

## 5. Web golden — what parity mobile may actually claim

`apps/web/app/(dashboard)/orders/[id]/page.tsx`:

- **:1341-1406** — the Add-Item / Scan row is a permanent sibling of the line rows inside the same edit list
  (`placeholder="Scan barcode or type name…"`, `disabled={!pricingReady}` :1354, Enter routes to
  `handleScanEnter()` :1363-1367). There is **no camera on web** — it is a keyboard-wedge input.
- **:1272-1283** — `PriceEditRow` renders **inline inside every line row**, never as a modal, never as a branch.
- **:937-947** — the scan input auto-focuses once `pricingReady` (with an explicit no-focus-stealing guard);
  **:1004-1005** refocuses after every add; **:1025 / :1035 / :1047** re-`select()` the code on
  archived / ambiguous / network-error so the next scan overwrites it.

**Parity mobile may claim: a scan entry point that coexists permanently with the editable line list, so a price
edit costs zero navigation.** Option C satisfies that. Parity mobile may **not** claim: a warm camera — web has
no camera, so "camera cold start" is a mobile-only cost with no golden-reference obligation. Note also that
web's price editor never occludes the scan input, whereas mobile's `PriceOverrideModal` is a real full-screen
`<Modal>`; mobile's honest parity target is therefore "the FAB is back the instant the modal closes", not
"scan while editing".

---

## Verdict

- **1a `confirmed`** · **1b `refuted as stated`** · **1c `confirmed`** (with the `active`-prop sub-refutation)
- **2 `refuted`** — the exclusive-branch ternary (:799) is real but is not the operative cause; the cause is
  `ProductPicker`'s local ownership of every scan primitive (:1758-1819, :1949-1994) against a parent-scope
  draft writer (:511-568).
- **3 `confirmed in part` / `refuted in part`** — Option C removes the branch swap and one tap; it does not
  remove the cold start, cannot reuse the existing `makeScanHandler`, and inherits a dead end on ambiguous/miss.
- **4 `confirmed`** (frontmatter stale) · B245 = pin, not REG, and independent of the B/C choice.
- **5 `confirmed`, narrowed** — parity is coexistence / zero-navigation, not a warm camera.

### The diverging lines

1. `edit-items.tsx:799` — the branch that makes the picker and the line list mutually exclusive (symptom surface).
2. `edit-items.tsx:1758` + `:1784` + `:1800-1819` — `scanOpen`, `useProductSearch()` and the ladder handler
   declared inside `ProductPicker`, so no scan capability survives `showPicker === false` (**the cause**).
3. `BarcodeScanner.tsx:91-102` / `BarcodeScanner.web.tsx:76-87` — `feedback.action` (`scan-loop.ts:179`,
   documented at :168-179) is never rendered, so any ladder-wired `BarcodeScanner` strands the operator on
   ambiguous/miss (**the trap Option C walks into**).
4. `edit-items.tsx:318-319` + `:527` vs `:207-208` / `:962` — the add path's tier lookups are exactly what
   `pricingReady` gates (**REG-B62 regression risk**).

### Minimal Option-C file list I would defend

1. **`apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx`** — the only mandatory file. Mount
   `<BarcodeFab continuous onScanned={…} hidden={showPicker ‖ !!priceEditItem ‖ unlistedModalOpen ‖
createCreditOpen ‖ !!licenseBlock ‖ !!creditBlock ‖ !pricingReady} />` as the last child of the
   `SafeAreaView` (after the `:799` ternary), mirroring `movements.tsx:157`; add the parent-scope handler that
   bridges `(code: string) => ScanOutcome` to `addPickedToDraft(p, kind)`.
2. **`apps/mobile/components/BarcodeScanner.tsx` + `.web.tsx`** — **only if** the ruling chooses the full ladder
   (fork (ii)); then render `feedback.action`. Blast radius: the 8 mounts listed in §3(b). If the ruling instead
   scopes the FAB to a single-candidate `resolveProductByCode` handler (fork (i), matching all 4 existing FAB
   call sites), **do not touch these files.**
3. **`apps/mobile/__tests__/<new>.test.ts`** — source-text pins only (the `scan-camera-buffer.test.ts:141-155`
   precedent) plus any extractable pure function; **plus B245's pin on `ScanCamera.web.tsx`**.
4. **Explicitly NOT**: `ScanTray.tsx`, `ScanOrderSheet.tsx`, `NewOrderScreen.tsx`, `lib/scan-ladder.ts`,
   `BarcodeFab.tsx` (unless a `paused` prop is added under fork (ii)).

### Facts the fix ruling must not get wrong

1. `addPickedToDraft` (:511) is parent-scope and already reachable; **`makeScanHandler` (:1800) is not** — a
   parent ladder is new code with a new rows source, not a reused handler.
2. **`BarcodeScanner` drops `feedback.action`** — a ladder-wired FAB strands on ambiguous and miss. Choose fork
   (i) or (ii) deliberately; do not assume the hand-off works.
3. **The FAB must be gated on `pricingReady`** or the fix reintroduces REG-B62 (:207-208, :318-319, :527, :962).
4. **Option C does not remove the camera cold start.** No keep-warm mechanism exists anywhere
   (`ScanCamera.web.tsx:197` / :505-508; `ScanOrderSheet.tsx:131` gates the camera on `visible`;
   `BarcodeFab.tsx:134` `hidden` returns `null`). Do not write "cold start fixed" into the close-out.
5. **The tap count is 3 (4 with the price chip), not 6.**
6. `hidden` must cover **`priceEditItem`** (a real `<Modal>` at :1402 that occludes the FAB's plain-View overlay)
   and every other modal on the screen, following the `stock-count/[id].tsx:565-569` precedent.
7. **Margin-floor ack (:1189-1198) is a second price-change path** on the same card — any proof of "scan access
   survives a price change" must cover it, not only `PriceOverrideModal`'s Apply.
8. **B245 cannot produce a behaviorally-red test** under `jest.config.js:4/:11`. File it as a pin outside the red
   gate, or `redGate.behaviorallyRed` cannot end true.
9. `ScanTray.tsx` has no price control (`ScanTray.tsx:25-35`) and is not imported by `edit-items.tsx` — Option B
   would widen into two other money surfaces. Recorded so the fork is a decision, not a discovery.
