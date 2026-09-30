# Cause refutation — B263 mobile-scan-price-tray

> S2, Opus @ high, read-only. Method: assume the registry's suggested direction (adopt `ScanOrderSheet` on
> `edit-items.tsx`, put a price control in `ScanTray`) is WRONG, and assume S1's measurement and causal story are
> wrong, then try to break both against current source on `fix/B263-scan-price-tray` (`eb2b815e`, post-Option-C
> `7fc01298`). Every line number below was read in this tree today. Where I could not disprove a claim I say so.

---

## Verdict summary

| #   | Sub-claim (as stated to S2)                                                          | Verdict                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Wrong behaviour = **4 taps + 2 camera lifecycles**                                   | **refuted (direction confirmed, number wrong)** — it is **5 taps**; S1 double-counts one tap as doing two jobs                                                                                                  |
| 2a  | Cause = "no price control reachable from the scanning state"                         | **confirmed** — diverging line `edit-items.tsx:806`                                                                                                                                                             |
| 2b  | Cause = "any price control unmounts the camera"                                      | **refuted** — the camera is unmounted by _leaving the picker_, not by _opening a price control_; sheets already stack over a live camera at `:1998`/`:2015`                                                     |
| 2c  | `ProductPicker` owns the camera / the modal stack blocks layering                    | **refuted** — the picker's scanner is an inline `absoluteFill` swap (`:1983`, comment `:1982`), and two sub-sheets already layer above it                                                                       |
| 2d  | `active` is unreachable through `BarcodeScanner`                                     | **confirmed** — `BarcodeScanner.tsx:80-85`, `.web.tsx:60-73`                                                                                                                                                    |
| 3a  | `ScanOrderSheet.tsx:137` `active={!paused}` can keep hardware warm across an overlay | **confirmed** (native + web, with the web caveat below)                                                                                                                                                         |
| 3b  | `ProductPicker`'s `paused` is "a live, working pattern on this exact screen"         | **REFUTED — and this is the run's biggest finding**: it is **unreachable from the camera**, because `BarcodeScanner` never renders `ScanFeedback.action`                                                        |
| 4   | Host choice: adopt `ScanOrderSheet` on `edit-items.tsx`                              | **refuted as the minimal host** — it is new composition, it drags a second scan engine onto the screen, and the tray's money semantics differ per host                                                          |
| 5   | The SPECIAL/tier-lock asymmetry at `edit-items.tsx:922` is a live money defect       | **refuted** — the edit screen matches the web golden reference _and_ the server; the outlier is `NewOrderScreen` (stricter). A **different** money gap is confirmed: `PriceOverrideModal` does not `roundMoney` |
| 6   | Test-oracle feasibility on node-only mobile Jest                                     | **confirmed**, with a stronger option than S1 found (`scan-ladder.test.ts` precedent)                                                                                                                           |
| 7   | `files:` frontmatter (`ScanOrderSheet.tsx`) vs prose (`ScanTray`)                    | **both refuted for the edit screen** — neither file is in `edit-items.tsx`'s tree                                                                                                                               |

**Overall: `confirmed` that B263 describes a real defect; `refuted` on its stated cause-shape, its measurement, and
its suggested fix host.** The minimal correct fix is smaller than the registry proposes and lives in files the
registry's `files:` list does not name.

---

## 1. Re-counting the wrong behaviour — S1's "4 taps" is an undercount

S1 counts: Cancel → price chip → Apply → BarcodeFab. **"Cancel" cannot be tapped from the scanning state.**

- `ProductPicker` renders, in order: `<NavBar leading={<NavBackButton label="Cancel" onPress={onClose}/>}>`
  (`edit-items.tsx:1917`), `<SearchBar>` (`:1918`), `<ScrollView>` (`:1934`), then
  `{scanOpen ? <BarcodeScanner .../> : null}` (`:1983-1992`).
- `BarcodeScanner`'s root is `<View style={StyleSheet.absoluteFill}>` (`BarcodeScanner.tsx:79`, `.web.tsx:59`) —
  a later sibling filling the whole `SafeAreaView`. Its top surround (`styles.dark`,
  `backgroundColor: "rgba(0,0,0,0.65)"`, `BarcodeScanner.tsx:90`) sits over the NavBar and is `pointerEvents:auto`
  (only the intermediate `styles.overlay` is `box-none`, `:88`).
- So from a live camera the operator must first tap the scanner's own **X** (`:129`) or **Done** (`:121`), both of
  which call `onClose` = `setScanOpen(false)` (`edit-items.tsx:1985`) — this closes the **scanner**, not the
  **picker**. Only then is `Cancel` reachable.

**Corrected repro (post-Option-C):**

| #   | Tap                                    | Effect                                                                                                                                                                                              |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scanner **X / Done**                   | `setScanOpen(false)` → `<BarcodeScanner>` unmounts → **camera teardown** (web: `ScanCamera.web.tsx:505-508` cleanup → `stop()` `:183-200` → `track.stop()` `:197`; native: `<CameraView>` unmounts) |
| 2   | **Cancel** (`:1917`)                   | `onClose` (`:841-845`) → `showPicker=false` → the `:806` ternary swaps the picker for the line list                                                                                                 |
| 3   | **Price chip** (`:1279`, wired `:937`) | `setPriceEditItem(it)` → `PriceOverrideModal` (`:734-748`)                                                                                                                                          |
| 4   | **Apply** (`:1476-1482`)               | `onSave` writes `draft[productId].unitPrice/overrideReason` (`:736-744`)                                                                                                                            |
| 5   | **BarcodeFab** (`:1016-1028`)          | `pickerScanIntent=true; showPicker=true` → fresh `ProductPicker` → `initialScanOpen` seeds `scanOpen` (`:1792`) → **fresh `getUserMedia`/`CameraView` acquisition**                                 |

**Measured: 5 taps, 2 camera lifecycle events.** The bug is real and worse than S1 measured. The ruling must not
copy S1's "4" into a REG test's expected value.

## 2. The cause — one of the two halves is wrong

### 2a. "No price control reachable from the scanning state" — CONFIRMED

**Diverging line: `edit-items.tsx:806`** — `{showPicker ? (<ProductPicker … />) : (<> …line list… </>)}`.
The picker and the line list are **mutually exclusive branches of one ternary**, not layers. Every price affordance
lives in the `else` branch:

- price chip — `DraftItemCard` `:1278-1284`, wired `onPressPrice={() => setPriceEditItem(it)}` `:937`;
- margin-floor one-tap fix — `:1220-1228` (`{canEditPrice && below && !acked && floorPrice != null ? … : null}`;
  S1 is right that the launching task's `~:1189` is stale, and `:1220` is correct in this tree);
- `PriceOverrideModal` mount — `:734-748`.

`ProductPicker`'s own JSX (`:1915-2030`) contains no price control and receives no draft state — it gets
`onPick`/`onPickAndStay`/`onClose`/`title`/`canCreateProducts`/`initialScanOpen` only (`:1767-1791`). It cannot
read `draft[id].unitPrice`, `catalogPrice`, `averageCost`, `marginConfig` (`:229`) or call `setLinePrice` (`:495`).

### 2b. "Any price control unmounts the camera" — REFUTED

Nothing about _opening a price control_ tears the camera down. The camera dies because the operator must **leave
the picker** (tap 1 closes the scanner; tap 2 closes the picker). Proof that an overlay does **not** need to
unmount it: `ProductPickerSheet` (`:1998-2013`) and `InlineCreateProductSheet` (`:2015-2028`) are mounted **after**
`<BarcodeScanner>` in the same fragment precisely so they layer above the camera, and the scanner stays mounted
(`paused` prop, `:1990`). A price sheet mounted in the same position would behave identically.

This distinction changes the fix: the defect is a **missing affordance + missing state plumbing inside
`ProductPicker`**, not a camera-lifecycle bug.

### 2c. "`ProductPicker` owns the camera / the modal stack is the obstacle" — REFUTED

The picker's scanner is **not** a `Modal`. `edit-items.tsx:1982` says so verbatim: _"Inline full-screen swap, not a
Modal — absoluteFill covers the screen."_ So none of react-native-web's `Modal`-portal z-index problems
(documented at `scan-loop.ts:170-177` and `NewOrderScreen.tsx:2245-2247`) apply here. Layering is already solved on
this screen.

### 2d. `active` unreachable through `BarcodeScanner` — CONFIRMED

`BarcodeScanner.tsx:80-85` mounts `<ScanCamera style onScanned={guardedScan} onOutcome={handleOutcome}
continuous={continuous}/>`; `.web.tsx:60-73` adds `onModeChange`/`footer`. **Neither passes `active`.** The registry
claim is exactly right on this point.

## 3. What the two pause mechanisms actually do

### 3a. `ScanCamera.active` — a genuine pause; `ScanOrderSheet.tsx:137` is its only reachable user

- **Native** (`ScanCamera.tsx:149`): `onBarcodeScanned={active ? handleBarcodeScanned : undefined}`. `<CameraView>`
  (`:138-150`) stays mounted with the same session; the effect list is unchanged, so no remount. `active=false`
  gates **before** the scan gate — `gateScan` (`scan-loop.ts:118`) never sees the code, so the per-code
  cooldown/absence clocks (`SCAN_COOLDOWN_MS=600`, `ABSENCE_GAP_MS=300`, `:82-84`) are not polluted.
  Still unverified from source (S1's open unknown stands): whether `expo-camera` internally disables the detector
  when `onBarcodeScanned` is `undefined`. Nothing in-repo can answer that, and no test exercises it (L-025).
- **Web** (`ScanCamera.web.tsx`): `active` (default `true`, `:135`) is mirrored to `activeRef` (`:174-175`) and read
  **only** in `handleFrame` (`:267`) and `handleManual` (`:291`). What stays alive at `active=false`:
  - the `MediaStream` and every `MediaStreamTrack` (the acquisition effect `:348-509` has deps `[loop, stop]` —
    `activeRef` is a ref, so flipping `active` never re-runs it and never calls `stop()`);
  - the `requestAnimationFrame` decode loop (`:317-346`), which keeps calling `detect()` at `DETECT_INTERVAL_MS`
    and discards the result — **CPU burns while "paused"**;
  - any in-flight `resolveCode` (`:235-256`) — `active` is not consulted there, so a lookup already started
    completes and its `onScanned` handler still runs.
    Only unmount releases the camera (`:505-508` → `stop()` `:183-200` → `track.stop()` `:197`).
    **So on web, `active=false` is "discard decodes", not "release hardware" — the exact property B263 wants, at the
    cost of an idle decode loop. That cost is worth naming in the ruling.**

### 3b. `ProductPicker`'s `paused` is DEAD on the camera path — the run's biggest finding

S1's Fact #4 calls `edit-items.tsx:1990` (`paused={pickCode !== null || createCode !== null}`) _"a live, working
pattern on this exact screen."_ **It is not reachable from the camera.** Trace:

1. The picker's handler is the shared ladder: `makeScanHandler({ …, onAmbiguous: setPickCode, onCreate:
canCreateProducts ? setCreateCode : undefined })` (`edit-items.tsx:1834-1843`).
2. `setPickCode`/`setCreateCode` are **never called directly** by the ladder. They are only invoked from a feedback
   pill's button: `action: { label: "Choose", onPress: () => deps.onAmbiguous(trimmed) }`
   (`lib/scan-ladder.ts:106`) and `action: { label: "Create", onPress: () => create(trimmed) }` (`:149`).
   `scan-ladder.test.ts:113-114` and `:137-138` pin exactly this shape.
3. **`BarcodeScanner` never renders `feedback.action`.** Native `:90-101` renders an `Ionicons` + `Text` only; web `:76-87` the same. `grep -n "action" components/BarcodeScanner.tsx` returns **zero** hits (only `onClose`
   handlers). By contrast `ScanOrderSheet.tsx:171-184` _does_ render `error.action` as a `Pressable`, and holds it
   for `ACTION_PILL_MS = 8000` vs `ERROR_PILL_MS = 2600` (`:12-14`).

Consequence: on the edit screen's camera path an ambiguous hit or a miss shows a pill with **no button**, so
`pickCode`/`createCode` stay `null`, so `paused` at `:1990` is **always false whenever the camera is up**. The only
route that sets them is `runWedgeSubmit` (`scan-ladder.ts:183-186`, which auto-presses the action) — and that runs
off the `SearchBar`, which the `absoluteFill` scanner covers.

`makeScanHandler` has exactly three app call sites: `NewOrderScreen.tsx:1108` and `invoices/new.tsx:628` (both
render into `ScanOrderSheet`, which shows the action) and `edit-items.tsx:1834` (renders into `BarcodeScanner`,
which drops it). **The one host that drops the ladder's hand-off is the one Option C's new FAB now routes the
operator into.** This is an independent HIGH-severity defect that belongs in the registry regardless of what B263
does, and it invalidates any fix design that assumes "the picker already pauses across a hand-off."

## 4. Host choice — what each option breaks

**Option H1 — adopt `ScanOrderSheet`/`ScanTray` on `edit-items.tsx`** (the registry's suggestion). Rejected:

- New composition, not reuse: `edit-items.tsx` imports neither name (confirmed by grep; only two render sites exist
  today, `NewOrderScreen.tsx:2223` and `invoices/new.tsx:77`). It would put a **second** scan engine on a screen
  that already has one (`ProductPicker`'s `BarcodeScanner`), with two `useScanCameraPermission` owners.
- `ScanTray` needs a whole data layer the edit screen doesn't have: `trayRowsFrom` consumes
  `{items, unlisted, scanOrder, lookup, priceFor, overridable}` (`lib/scan-tray.ts:113-127`) — `edit-items.tsx`
  maintains no `scanOrder`, no `productById`, and its `draft` is keyed differently (`DraftItem`, `:85-125`).
- `TrayRow` (`:34-45`) carries `{id,name,qty,qtySummary,subtotal,unitsPerBox,unlisted}` — **no `unitPrice`, no
  `basePrice`, no `floor`, no lock flag**. A price control needs all four, so `TrayRow` and `ScanTrayProps`
  (`ScanTray.tsx:25-35`) must both grow — and `NewOrderScreen` + `invoices/new.tsx` inherit every change.
- **The same tray control would mean different things on the two hosts** (see §5): on `NewOrderScreen` a write to a
  SPECIAL line's `unitPrice` is discarded twice over (display via `overridable`, charge via `lineUnitFor`), so the
  control would be a **silent no-op**; on `edit-items.tsx` the same write takes effect. Shipping one component with
  that split is how a money bug gets built.

**Option H2 — a price surface inside `ProductPicker`'s existing camera path.** The minimal host.
Mount a price sheet as a third sibling after `<BarcodeScanner>` (beside `:1998`/`:2015`), extend `paused` to
include it, and thread the missing state in as props from the parent (the just-added line + `catalogPrice`,
`marginFloor`, `averageCost`, and a `setLinePrice`/`onSavePrice` callback — all already computed in the parent at
`:229`, `:495`, `:924`). Cost: `ProductPicker`'s prop surface grows; `pickerScanIntent`/`scanFabHidden`
(`lib/scan-fab-visibility.ts:31-37`) may need the new sheet added to `blockingModalOpen`; `edit-items-scan-fab.test.ts`
splits the file at `"function ProductPicker"` (`:36-39`) so parent/picker source-text pins stay valid.
**Blocked on §3b**: if the fix keeps using `BarcodeScanner.paused`, the price sheet inherits the swallow semantics
— `guardedScan` returns `undefined` **after** `gateScan` has already accepted and recorded the code
(`ScanCamera.tsx:125-133` → `resolveCode` → `guardedScan`), so a scan during a price edit is **silently eaten with
no feedback**. Forwarding `active` through `BarcodeScanner` to `ScanCamera` (2 files, ~4 lines) gates before the
gate and is the correct pause.

**Option H3 — a price overlay above the picker, owned by the parent.** Mechanically possible but worse than H2:
the parent's `PriceOverrideModal` is an RN `Modal` (`:1433`), and the picker's scanner is a non-Modal
`absoluteFill` inside the same `SafeAreaView` — on react-native-web the `Modal` portal goes to `document.body`
with no z-index (`scan-loop.ts:170-177`), i.e. the documented reason the old miss path had to close the scanner.
An overlay owned by the parent would have to be re-authored as a non-Modal absolute layer anyway, at which point
H2 is strictly simpler.

**Not in scope but adjacent:** the identical "leave the camera to price a line" round trip is **unfixed on
`NewOrderScreen`** — `onReview` (`:2238-2241`) sets `scanOpen=false`, and `ScanOrderSheet.tsx:131`'s explicit
`{visible && granted ? <ScanCamera/> : …}` gate tears the camera down on every cart round trip
(`onScanMore`, `:2333-2336`, pays the cold start again). If the owner's intent for B263 is the _create_ flow, then
`ScanTray` is the right file and `edit-items.tsx` is out of scope — the row's title ("Mobile order edit") says
otherwise. **The ruling must choose one; they are different bugs on different screens.**

## 5. Money rules — the claimed asymmetry is not the defect; a different one is

**What the write path actually is.** Two client price-write paths already exist on the edit screen:
`PriceOverrideModal.onSave` → `{unitPrice, overrideReason}` (`:736-744`), and **`setLinePrice(id, unitPrice)`
(`:495-501`)**, the margin-floor one-tap fix, which writes `unitPrice` **with no reason** ("the ack itself is the
record", `:493-494`). Any new in-scan control should reuse one of these, not invent a third.

Validation in `PriceOverrideModal` (`:1392-1488`) is exactly `valid = newPrice > 0` (`:1410`); Apply is disabled
otherwise (`:1477-1482`). Then `save()` (`:604-616`) puts `unitPrice: i.unitPrice`, `basePrice: i.catalogPrice`,
`overrideReason: i.overrideReason` into `DiffCatalogLine`, `buildOrderItemDiff` (`:639-645`) emits `unitPrice`
only when it differs from `basePrice` (pinned by `order-item-diff.test.ts`), and `updateMut.mutate` (`:652+`) sends
it.

**What the server enforces — nothing relevant.** `UpdateOrderItemDto.unitPrice` is
`@IsOptional() @IsNumber() @Min(0) @Max(1_000_000)` and `overrideReason` is `@IsOptional() @IsString()`
(`apps/api/src/orders/dto/update-order-items.dto.ts:71-91`). In `orders.service.ts` the only price stripping is
role-based: DRIVER diff edits have `unitPrice`/`overrideReason` destructured away (`:3105-3125`, B13) and the
CUSTOMER diff path is rejected outright (`:3099-3103`). For staff, `isManualOverride = overridePrice !== null &&
overridePrice !== catalogPrice` (`:3617`, `:3817`, `:4076`) and the price is stored verbatim.
**There is no server-side tier lock, no margin-floor check, and `overrideReason` is never required.** Every such
rule is client-side only.

**Is `edit-items.tsx:922`'s missing SPECIAL gate a live money defect? No — REFUTED.**
`canEditPrice = !isDriver && order.status !== "CANCELLED"` matches the golden reference:

- web order edit — `apps/web/app/(dashboard)/orders/[id]/page.tsx:1272` renders `PriceEditRow` on
  `(canEditPrice || item.isUnlisted) && !item.cancelled`, with `canEditPrice={canEdit}` (`:2661`) and **no** tier
  gate; its `isSpecialTierFor` (`:1603`) is used at exactly one place, `:975`, the price-**history prefill** —
  the same narrow use as mobile's `isSpecial` at `edit-items.tsx:533`;
- web order **create** — `CreateOrderModal.setDiscountedPrice` (`:632-673`) compares the typed price against
  `li.listPrice`, not `specialPrice`, and submits `unitPrice` for any `DISCOUNTED`/`MANUAL` line (`:918-923`);
  a SPECIAL line **is** overridable there.

So the real outlier is **`NewOrderScreen.tsx:623-627`**, which is _stricter_ than web on both flows —
`lineUnitFor` silently discards a stored override on a SPECIAL line at charge time, and `trayRowsFrom`'s
`overridable` (live at `NewOrderScreen.tsx:1325-1329`, **not** dead code — this disproves S1's open unknown #4)
discards it for display. That is a mobile-create-only rule with a `(web parity)` comment that the web source does
not support. It is worth a registry row; it is **not** a reason to add a gate to `edit-items.tsx`, and doing so
would break web parity in the other direction.

**The money gap that IS real: no rounding.** `PriceOverrideModal` computes `newPrice = toNumber(priceText)`
(`:1409`) and passes it straight to `onSave` — **unrounded**. `roundMoney` is applied only to the derived
"$ off" lens (`:1404`, `:1419`, `:1428`). Web's `PriceEditRow` rounds every commit:
`onPriceChange(roundMoney(Math.max(0, v)))` (`page.tsx:772-777`, and `commitOff` `:781-786`). A typed `1.005`
therefore reaches `draft.unitPrice`, the diff, and the API un-rounded; `computeLineSubtotal`
(`packages/pricing/src/pricing.ts:112-129`) rounds only the **subtotal**, and `orders.service.ts` has exactly one
`roundMoney(...)` on a unit price (`:188`, an unrelated "remembered price" path). Any new in-scan price control
**must** round on commit — and the existing modal arguably should too (separate, minimal, one-line).

**Boxed lines.** `unitPrice` is the **box** price on a boxed line. `DraftItemCard` prices via
`computeLineSubtotal({unitPrice, qty, boxes, pieces, unitsPerBox, freeUnits})` (`:1110-1117`) — note `freeUnits`
from `draftFreeUnits(item)` (`:1108`, BUY_N_GET_M). `lib/scan-tray.ts:101-107` calls `computeLineSubtotal`
**without** `freeUnits` — so a tray row on a BOGO line already shows a different number than the edit screen's
card would. Another reason H1's tray adoption is not a free ride.

## 6. Test-oracle feasibility (node-only mobile Jest)

`apps/mobile/jest.config.js` — `testEnvironment: "node"` (`:4`), `testMatch: ["**/__tests__/**/*.test.ts"]`
(`:11`, `.ts` only), `moduleNameMapper` covers `@routeflow/pricing` → source, `expo-secure-store`, `@routeflow/ui`,
`@routeflow/types` (`:30-38`); nothing maps `react-native`. **No component in this bug can be rendered.** Three
oracle tiers are available, in descending strength:

1. **Real unit tests on extracted pure logic.** The strongest available oracle, and stronger than S1 suggests: a
   `lib/` reducer returning the same `{unitPrice, overrideReason}` payload the modal writes (`:736-744`) is
   directly testable, and `roundMoney` behaviour is testable with it. Precedents: `scan-fab-visibility.test.ts`
   (5 cases, `toBe` only, so a constant implementation cannot pass), `scan-tray.test.ts` (194 lines incl. the
   override + `overridable` lock at `:137-154`), `sale-line.test.ts`, `order-item-diff.test.ts`.
2. **`scan-ladder.test.ts`-style behavioural pins on the ladder itself.** This is how §3b's defect should be
   guarded: `scan-ladder.test.ts:113/137` already prove the outcome **carries** an action; the missing pin is that
   the **renderer** consumes it — which, absent a renderer, must be a source-text pin (tier 3) on
   `BarcodeScanner.tsx` / `.web.tsx`.
3. **Source-text pins** (`readFileSync` + regex), the `edit-items-scan-fab.test.ts` / `scan-camera-web-sequencing.test.ts`
   precedent. Necessary for: "`BarcodeScanner` forwards `active` to `ScanCamera`", "`BarcodeScanner` renders
   `feedback.action` as a Pressable", "the price sheet is mounted after `<BarcodeScanner>` in `ProductPicker`",
   "`paused`/`active` includes the price-sheet state". Note `edit-items-scan-fab.test.ts:36-39` already splits the
   file at `"function ProductPicker"` — new picker-half pins must use the picker half or they will match parent code.

**Web-golden implication for parity.** Web's obligation is _"a permanent, zero-navigation price edit"_ — the inline
`PriceEditRow` inside every row (`page.tsx:1272-1283`) beside a permanent scan row (`:1341-1406`, keyboard-wedge,
no camera). Web has no camera, so **"keep the camera warm" carries no golden-reference obligation at all**; the
obligation is "don't navigate away to price a line." A fix that reduces the 5 taps to 1-2 without any camera
change would already satisfy parity — the camera warmth is a mobile-only ergonomics goal. The ruling should decide
explicitly whether it is buying parity (cheap) or warmth (needs `active` forwarding).

## 7. `files:` frontmatter vs prose

Neither is right for the screen the title names. `edit-items.tsx` imports neither `ScanOrderSheet` nor `ScanTray`
(grep: zero hits), and `ScanOrderSheet`'s only two render sites are `NewOrderScreen.tsx:2223` and
`invoices/new.tsx:77`. The frontmatter's other four files are closer: `edit-items.tsx` (the `:806` ternary and the
picker), `BarcodeScanner.tsx` + `.web.tsx` (the two real gaps: no `active` forwarding, no `action` rendering), and
`ScanCamera.tsx`/`.web.tsx` (read-only — `active` already works; **no change needed there**). Treat the prose's
"into ScanTray" as describing the _shape_ the owner wants (a price control colocated with a live scan surface),
not the file.

---

## Diverging lines (the ruling's anchors)

| Behaviour                                  | Line                                                                                  | Why it diverges from intent                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Price controls unreachable while scanning  | `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx:806`                    | `{showPicker ? <ProductPicker/> : <>line list</>}` — a ternary, so no price affordance can coexist with the picker                                                                                  |
| Camera dies on the way to a price control  | `edit-items.tsx:1985` + `:841-845`                                                    | scanner `onClose` and picker `onClose` are two separate unmounts, both on the path to the price chip                                                                                                |
| Ladder hand-off dropped on the camera path | `apps/mobile/components/BarcodeScanner.tsx:90-101` and `BarcodeScanner.web.tsx:76-87` | render `feedback.text` only; `ScanFeedback.action` (`scan-loop.ts:179`) is never rendered, so `scan-ladder.ts:106/:149` are dead from the camera and `edit-items.tsx:1990`'s `paused` never engages |
| `active` unreachable                       | `BarcodeScanner.tsx:80-85`, `.web.tsx:60-73`                                          | mount `<ScanCamera>` without `active`, so the one real pause lever is unavailable to every `BarcodeScanner` host                                                                                    |
| Unrounded money write                      | `edit-items.tsx:1409` (`newPrice = toNumber(priceText)`) → `:736-744`                 | web's counterpart rounds (`apps/web/.../orders/[id]/page.tsx:772-777`); RouteFlow's money rule is "round every monetary write"                                                                      |

## Minimal file list I would defend

**Fix (H2):**

1. `apps/mobile/components/BarcodeScanner.tsx` — forward `active` to `<ScanCamera>`; render `feedback.action`.
2. `apps/mobile/components/BarcodeScanner.web.tsx` — same two changes (L-025: both sides or say it's unverified).
3. `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx` — a price sheet mounted beside
   `ProductPickerSheet`/`InlineCreateProductSheet`; extend the pause expression; thread
   `{line, catalogPrice, marginFloor, averageCost, onSavePrice}` into `ProductPicker`.
4. `apps/mobile/lib/<new>.ts` — the extracted price-commit reducer (rounds; emits `{unitPrice, overrideReason}`),
   so tier-1 tests exist at all.
5. `apps/mobile/lib/scan-fab-visibility.ts` — only if the new sheet must also hide the FAB.

**Tests:** `__tests__/<reducer>.test.ts` (new, tier 1), `__tests__/edit-items-scan-fab.test.ts` (extend, picker
half), a new source-text pin file for the two `BarcodeScanner` variants.
**Read-only radius:** `ScanCamera.tsx`, `ScanCamera.web.tsx`, `lib/scan-ladder.ts`, `lib/scan-loop.ts`,
`components/ScanOrderSheet.tsx`, `components/ScanTray.tsx`, `lib/scan-tray.ts`, `components/NewOrderScreen.tsx`.
**Explicitly NOT changed:** `ScanCamera.*` (its `active` is correct), `ScanTray.tsx`/`ScanOrderSheet.tsx`/
`lib/scan-tray.ts` (different screen — changing them drags `NewOrderScreen` + `invoices/new.tsx` in), any
SPECIAL-tier gate on `edit-items.tsx`, and anything server-side.

## Facts the ruling must not get wrong (15)

1. The cost is **5 taps + 2 camera lifecycles**, not 4 — the scanner's X/Done and the picker's Cancel are two
   separate taps; Cancel is covered by the `absoluteFill` scanner overlay.
2. The diverging line is `edit-items.tsx:806` — a **ternary**, so picker and price controls are mutually exclusive
   by construction.
3. Opening a price control does **not** unmount the camera; leaving the picker does. Two sheets already stack over
   the live camera at `:1998` and `:2015`.
4. The picker's scanner is **not** a Modal (`:1982-1983`) — the react-native-web portal/z-index problem does not
   apply on this screen.
5. **`BarcodeScanner` (both platforms) never renders `ScanFeedback.action`.** `edit-items.tsx:1990`'s `paused` is
   therefore unreachable from the camera — S1's "live, working pattern" claim is false. This is its own defect,
   affecting all 5 `BarcodeScanner`/`BarcodeFab` scan surfaces, and the ladder's `onAmbiguous`/`onCreate` are dead
   there.
6. `ScanCamera.active` is real on both platforms and unreachable through `BarcodeScanner`
   (`:80-85` / `:60-73`) — forwarding it is ~4 lines in 2 files.
7. On **web**, `active=false` keeps the `MediaStream`, every track, and the rAF decode loop alive
   (`ScanCamera.web.tsx:317-346` never reads `activeRef`; the acquisition effect's deps are `[loop, stop]`). It
   discards decodes; it does not idle the hardware.
8. On **native**, `active=false` gates before `gateScan`, so the scan-gate clocks stay clean;
   `BarcodeScanner.paused` swallows **after** the gate accepted, so a scan during a pause is silently eaten with
   no feedback and the code's cooldown is consumed.
9. `PriceOverrideModal` writes exactly `{unitPrice, overrideReason}`; validation is only `newPrice > 0`
   (`:1410`); **the price is not rounded** (web's `PriceEditRow` rounds — `page.tsx:772-777`).
10. `setLinePrice` (`:495-501`) is a **second, already-shipped** price-write path (margin-floor "Set to floor",
    no reason). The margin-floor block is at `:1220-1228`, not `~:1189`.
11. The **server enforces none** of it: `unitPrice` is `@IsOptional() @IsNumber() @Min(0) @Max(1_000_000)`, no tier
    lock, no margin floor, `overrideReason` optional; the only strip is DRIVER-diff (`orders.service.ts:3105-3125`)
    and CUSTOMER-diff rejection (`:3099-3103`).
12. `edit-items.tsx:922`'s lack of a SPECIAL gate **matches** web's order-edit page (`:1272`, `:2661`) **and**
    web's create modal (`:632-673`, `:918-923`). The outlier is `NewOrderScreen.tsx:623-627` (stricter). Do not
    "fix" the edit screen toward it.
13. `trayRowsFrom`'s `overridable` is **live**, not dead: `NewOrderScreen.tsx:1325-1329`. On that screen a write to
    a SPECIAL line's `unitPrice` is discarded twice — so a shared tray price control would be a **silent no-op
    there and effective on the edit screen**.
14. `TrayRow` (`lib/scan-tray.ts:34-45`) carries no `unitPrice`/`basePrice`/`floor`/lock flag, and its
    `computeLineSubtotal` call omits `freeUnits` (`:101-107`) unlike `DraftItemCard` (`:1110-1117`). Adopting the
    tray on the edit screen changes three files' contracts and two other screens.
15. Mobile Jest is node-only, `.ts`-only (`jest.config.js:4/:11`) — no rendered test is possible. Web's parity
    obligation is "zero-navigation price edit", not "warm camera" (web has no camera); `L-025` (both platform
    branches) and `L-095` (`BarcodeFab`'s discriminated union) both apply if those files are touched.

---

**Verdict: `confirmed` that B263 is a real defect (5 taps / 2 camera lifecycles, diverging at `edit-items.tsx:806`);
`refuted` on its measurement, on the "any price control unmounts the camera" half of its cause, on the claim that
the picker's `paused` works today, and on `ScanOrderSheet`/`ScanTray` as the fix host.**
One new HIGH defect surfaced and should be filed separately: `BarcodeScanner` drops `ScanFeedback.action` on both
platforms, killing the ambiguous/create hand-off on every `BarcodeScanner`-hosted scan surface.
