# Barcode scan-to-order redesign — implementation spec

Status: **spec only, no code written**. Target surface: `apps/web` (Next.js operator
dashboard) viewed in mobile Safari — **not** the Expo app (`apps/mobile`). All file:line
citations below were verified against `origin/master` at commit `6f49cbf5` (2026-09-18,
fetched fresh for this spec) via `git show origin/master:<path>`, not the local checkout,
which was 76 commits behind at research time (local `HEAD` `06752f88`). Where the intake
research file (`mobile-scan-research.md`) was accurate this doc cites the same lines with
one clean read; where it simplified something, that's called out explicitly.

---

## 1. Scope and non-goals

**In scope:**
- A redesigned scan screen reachable from `CreateOrderModal.tsx`'s product search: smaller
  horizontal camera strip, autofocus/rear-camera fix, camera stays open across scans,
  scanned items accumulate in a list with the existing price/margin/note machinery, a price
  editor opens on tapping price, +/− and tap-to-type quantity, manual barcode entry, beep +
  vibrate, undo-last, running totals, poor-signal queueing.
- Extracting the ~300-line inline line-item row out of `CreateOrderModal.tsx` into a
  reusable component, because both the modal's own list and the new scan screen need
  identical row behavior.
- Porting (not importing — see §4) the already-proven continuous-scan gate/buffer/cue
  architecture from `apps/mobile` into `apps/web`.

**Non-goals (explicitly not building here):**
- The multi-level unit hierarchy (`ProductUnit`, ladders beyond boxes/pieces) described in
  `local-assets/handoff/2026-09-18/units-po-plan/PLAN-units-po-v4.md` — that is a separate,
  still-unmerged, schema-changing effort (§2.1–2.14 of that plan). This redesign's unit
  selector targets **today's** single-depth `Product.unitsPerBox` model and must not block
  on, or duplicate, that plan. See §6.5.
- `apps/mobile`'s own camera screens (`ScanCamera.tsx`, `ScanOrderSheet.tsx`) — untouched.
  They are cited here only as proven prior art to port logic from.
- A `BarcodeDetector`-based decode engine. Mobile's web build (`ScanCamera.web.tsx`) runs a
  dual `BarcodeDetector` + zxing engine; this spec keeps apps/web on zxing only (its 14
  existing render sites all depend on it) and calls out dual-engine as a stretch item
  (§8, W6) rather than a prerequisite.
- Changing `resolveProductByCode`, `MarginHint`, `MoneyInput`, or `@routeflow/pricing` — all
  reused verbatim.
- A dedicated scan-only *route* (e.g. `/orders/scan`). The existing `?scan=<code>` deep link
  (`apps/web/app/(dashboard)/orders/page.tsx:170-185`) already opens `CreateOrderModal`
  pre-filled with one code; this redesign extends the in-modal camera flow, it doesn't
  replace that mechanism.

---

## 2. The autofocus fix

### 2.1 What's broken today (verified)

`apps/web/components/BarcodeScannerButton.tsx:121-129` (196 lines total, unchanged since PR
#851/873a4ac7 — confirmed via `git log --oneline -- apps/web/components/BarcodeScannerButton.tsx`):

```tsx
const devices = await BrowserMultiFormatReader.listVideoInputDevices();
const deviceId = devices.length > 0 ? devices[devices.length - 1].deviceId : undefined;

await reader.decodeFromVideoDevice(
  deviceId,
  videoRef.current!,
  (result, _err, controls) => { ... },
);
```

- Camera picked by **enumeration-order heuristic** (`devices[devices.length - 1]`), not a
  `facingMode` constraint.
- `decodeFromVideoDevice` is called with **no constraints argument at all** — zxing 0.2.x
  falls back to `{ video: { deviceId } }`. No resolution hint, no focus request, no frame
  rate.
- No `applyConstraints` call anywhere in the file. No tap-to-focus handler on the `<video>`
  at line 177 (`<video ref={videoRef} className="w-full rounded-lg" autoPlay muted
  playsInline />` — no `onClick`/`onTouchStart`). No torch control.

This matches the research file's §2/§3 exactly — confirmed, not a stale claim.

### 2.2 The fix: a degrading constraint ladder, requested at acquisition

`apps/mobile/components/ScanCamera.web.tsx:87-121` already solved this exact problem for
the same browser APIs (Expo's web build runs in a real browser with the same
`MediaDevices`/zxing surface apps/web uses). Port its `openCamera()` shape:

```ts
const IDEAL_VIDEO: MediaTrackConstraints = {
  facingMode: { ideal: "environment" },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30 },
};
const ADVANCED_FOCUS = [{ focusMode: "continuous" }] as unknown as MediaTrackConstraintSet[];

async function openCamera(): Promise<MediaStream> {
  const attempts: MediaStreamConstraints[] = [
    { video: { ...IDEAL_VIDEO, advanced: ADVANCED_FOCUS }, audio: false },
    { video: IDEAL_VIDEO, audio: false },
    { video: { facingMode: { ideal: "environment" } }, audio: false },
  ];
  let lastErr: unknown;
  for (const constraints of attempts) {
    try { return await navigator.mediaDevices.getUserMedia(constraints); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}
```

Key points to carry over, verbatim as documented in `ScanCamera.web.tsx:82-100`:

- **`ideal` never throws** — a UA that can't hit 1920×1080@30fps silently downgrades rather
  than failing `getUserMedia`. The three-attempt ladder exists only so a UA that rejects the
  `advanced` focus array outright (rare, but the mediacapture spec permits a UA to reject
  the whole call instead of dropping unknown `advanced` entries) still gets a camera, one
  step down from what it might have gotten. This can never produce a *worse* camera than
  today's bare `{ video: { deviceId } }`.
- **`facingMode: { ideal: "environment" }` replaces the `devices[length-1]` heuristic.**
  Pass it in the constraints; **stop enumerating devices for selection purposes.**
  `BrowserMultiFormatReader.listVideoInputDevices()` is still needed to get a `deviceId` for
  zxing's `decodeFromStream`/`decodeFromVideoDevice` signature, but the constraints — not the
  device list order — decide which physical camera opens. Practically: call
  `getUserMedia(constraints)` directly (as `openCamera()` does) to get the `MediaStream`,
  then hand that stream's video track's `getSettings().deviceId` (or just the stream itself,
  via zxing's `decodeFromStream`, not `decodeFromVideoDevice`) to the decoder — this also
  sidesteps the double-permission-prompt risk of asking for a stream via constraints and
  *then* asking zxing to open a second stream by device id.
- **Resolution matters as much as focus.** `ScanCamera.web.tsx:82-86`'s own comment: the UA
  default (640×480) leaves "roughly 6px per narrow module on a 12-digit UPC at arm's
  length — under every decoder's floor." This is a real, separate contributor to "the
  scanner doesn't focus" reports that isn't about focus at all — worth fixing in the same
  pass since it's one field in the same constraints object.
- **`focusMode: "continuous"` is requested via the initial `getUserMedia` `advanced` array,
  not via a post-acquisition `track.applyConstraints` call.** Torch (§2.3) is the one thing
  that genuinely needs `applyConstraints` after acquisition, because it's a user-toggled
  runtime state, not a startup preference.

### 2.3 Torch, where supported

`ScanCamera.web.tsx:202-218` and `:386`:

```ts
const capabilities = track.getCapabilities?.() ?? {};
setCaps({ torch: "torch" in capabilities });
...
const toggleTorch = async () => {
  const track = trackRef.current;
  if (!track) return;
  const next = !torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
    setTorchOn(next);
  } catch {
    setCaps((prev) => ({ ...prev, torch: false })); // the capability lied — hide the control
  }
};
```

Render the torch button only when `caps.torch` is true, and demote it silently (never show
an error toast) if `applyConstraints` throws after all — a capability object that lies is a
known browser quirk, not a bug to surface to the operator.

### 2.4 Tap-to-focus fallback

Neither `ScanCamera.web.tsx` nor `BarcodeScannerButton.tsx` implements true tap-to-focus
(there is no standardized way to point-and-focus a `getUserMedia` track — that's a native
camera-app affordance, not a web API). What both **can** do, and what this redesign should
add, is a **soft fallback**: tapping/clicking anywhere on the video pauses decode for ~400ms
and re-triggers `track.applyConstraints({ advanced: ADVANCED_FOCUS })` — a no-op on browsers
that already focus continuously, but on some Android/Chrome builds a repeated
`focusMode: "continuous"` request is documented to nudge a stuck autofocus lens. This is a
best-effort nicety, not a guaranteed fix — label it in-app only if the torch/manual-entry
affordances aren't enough (§10, open question).

### 2.5 Honest iOS Safari limits

State this plainly in the UI copy and in code comments, so nobody re-promises more than the
platform gives (mirrors `ScanCamera.web.tsx:94-98` and :202-204 verbatim):

- **`focusMode: "continuous"` is silently dropped on iOS Safari** — Apple's WebKit
  implementation of `MediaTrackConstraints` does not expose `focusMode` at all. This is not
  a bug in this code; it's iOS Safari continuously autofocusing on its own by default and
  giving pages no lever over it. The constraint is harmless to send (WebKit drops unknown
  `advanced` entries per spec) and *does* help on Android/Chrome, so keep sending it — just
  don't claim it "fixes autofocus on iPhone," because there is nothing to fix there: iOS's
  autofocus is already continuous, and complaints on iOS are almost always the **distance/
  resolution problem** (§2.2's 640×480 default) or **motion blur from a shaky handheld
  angle**, not focus mode.
- **`torch` capability is never reported on iOS Safari** (`ScanCamera.web.tsx:549` comment:
  "iOS Safari exposes no torch capability, so the button never renders there and there is no
  web workaround"). Don't build a torch button that silently no-ops on iPhone; gate it on
  `caps.torch` so it simply doesn't render there.
- **`navigator.vibrate` does not exist on iOS Safari** (confirmed — WebKit has never shipped
  the Vibration API). The beep (WebAudio) works everywhere; vibrate degrades to a no-op via
  optional chaining (`navigator.vibrate?.(...)`) with zero special-casing needed — see §6's
  cue-porting plan, which already handles this for free.

---

## 3. Screen layout at 390px

Current: `CreateOrderModal.tsx` is a Radix `Modal` (`className="max-w-2xl"`,
`CreateOrderModal.tsx:1055-1061`) whose body is capped at `max-h-[65vh]` and scrolls
(`CreateOrderModal.tsx:1104`). The existing camera overlay is a **separate full-screen
layer** (`BarcodeScannerButton.tsx:174`: `fixed inset-0 z-[9999] ... bg-black/90`), not part
of the modal's own scroll area. Keep that architecture: the new scan screen is **its own
full-screen overlay**, not a re-flow of the modal's `max-h-[65vh]` body — cramming a
horizontal camera strip plus a scrollable item list plus totals plus action buttons inside
an already-scrolling 65vh modal body is a losing layout fight, and the overlay pattern
already exists and is proven at 390px (B499's Playwright case,
`apps/web/e2e/08-create-order-escape.spec.ts:271-306`, pins the *button* at 390px; the
overlay itself has no existing pixel budget to preserve, so this is free to redesign).

Target layout, top to bottom, 390×844 (iPhone-class) viewport:

```
┌─────────────────────────────────────┐  y=0
│ ✕ Close        Scan items      🔦   │  44px header (torch icon only if caps.torch)
├─────────────────────────────────────┤  y=44
│                                       │
│         [ camera strip ]             │  ~120-140px tall, full width
│   ┌───────────────────────────┐      │  horizontal guide box, NOT the old
│   │                           │      │  centered square — wide + short,
│   └───────────────────────────┘      │  matching a barcode's own aspect ratio
│                                       │
├─────────────────────────────────────┤  y≈184
│  Align barcode in the box · beep 🔊  │  22px hint line (also carries the
├─────────────────────────────────────┤  manual-entry link, §7's damaged label case)
│  ↩ Undo last scan          3 items   │  36px, ALWAYS visible once ≥1 item exists
├─────────────────────────────────────┤  y≈220
│  ┌─────────────────────────────┐    │
│  │ Sprite 12pk        $8.99  2  │    │  scrollable item list — the
│  │ Coke 24pk         $14.50  1  │    │  extracted LineItemRow (§4), one row
│  │ ▸ Chips Family    $3.25   5  │    │  per scan, last-scanned row highlighted
│  │   ...                         │    │  (ring-2 ring-brand-500, fades after
│  └─────────────────────────────┘    │  ~2s), swipe-to-delete per row
├─────────────────────────────────────┤  y≈740 (pinned to bottom, not scrolled)
│  8 items · $61.45           [Done]  │  56px persistent totals + primary CTA
└─────────────────────────────────────┘  y=844
```

- **Camera strip is ~15-17% of viewport height** (down from "fills the screen"), full
  width, `aspect-video`-ish crop (wide/short — a horizontal guide box matches how a barcode
  is actually held, unlike the old centered square at `BarcodeScannerButton.tsx:180`:
  `h-32 w-64` inside a `max-w-sm` video, which was already wider than tall for the *guide*
  but the *video panel* filled the full black overlay).
- **Item list gets the freed space** — everything between the hint line and the pinned
  totals footer, scrollable independently of the camera.
- **Totals + Done are pinned** (`position: sticky` or a flex column with `flex-1
  overflow-y-auto` on the list and a non-shrinking footer), always visible without
  scrolling, mirroring mobile's `ScanOrderSheet` totals line
  (`apps/mobile/components/ScanOrderSheet.tsx:207`: `{itemsLabel} · ${total.toFixed(2)}`) —
  same information, web's own visual language.
- **Undo-last** is its own always-visible row above the list, not buried in a menu — one tap,
  per the owner's ask.
- **Note button and remove button** stay exactly as they are on `LineItemRow` (§4) —
  `StickyNote` icon (`CreateOrderModal.tsx:1736`) and swipe-to-delete supplements, doesn't
  replace, the existing tap-to-remove `X` button (`CreateOrderModal.tsx:1744`) for
  mouse/desktop users who open this same screen on a wider viewport.
- At **768px/1440px** (tablet/desktop use of the same operator app): camera strip and list
  can sit side-by-side (camera left ~40%, list right ~60%) instead of stacked — same
  components, a wider breakpoint just changes the flex direction. Not the primary target
  (this is a phone-in-hand workflow) but must not break, since `CreateOrderModal` is used at
  desktop widths too.

---

## 4. Component inventory

### 4.1 Extract first: `LineItemRow` (blocking prerequisite, §8 W1)

**The structural obstacle.** There is no reusable row component today — confirmed by
`git grep -rn "LineItemRow\|OrderLineRow\|ProductLineRow" apps/web` returning zero hits. The
row is ~295 lines of inline JSX inside `CreateOrderModal.tsx`'s `.map()`, verified at
`CreateOrderModal.tsx:1456-1748` (the research file estimated "1448-1750+"; the actual `<li>`
element runs 1457-1746). It renders, per line: name + truncation, price badges
(Special/Discounted/Upsell/plain, `:1509-1550`), price-per-piece for boxed lines (`:1552-
1556`), the regulated-category chip (`:1558-1562`), the one-time-discount `MoneyInput`
(`:1564-1583`), the `MarginHint` block (`:1586-1599`), the per-line note input
(`:1600-1609`), the case/unit qty controls (`:1613-1693` boxed, `:1695-1715` non-boxed), the
line total (`:1717-1726`), the note-toggle button (`:1727-1737`), and the remove button
(`:1738-1745`). It also has a parallel branch for unlisted/custom lines (`:1467-1504`) that
the scan flow will never hit (a scan always resolves to a real catalog product or opens
`InlineCreateProductModal`) but the extraction must still support, since `CreateOrderModal`'s
own list needs both.

**New file: `apps/web/components/LineItemRow.tsx`.** Props (a superset of what the inline
JSX already closes over as local state/handlers):

```tsx
export interface LineItemRowProps {
  item: LineItem;                       // same shape as CreateOrderModal's LineItem today
  category: TrackedCategory | null;     // lineCategory(li) result, passed in not recomputed
  marginFloor: number;                  // floorForCategory(marginConfig, item.category)
  floorAcked: boolean;
  costRevealed: boolean;
  priceHistoryEntry?: { lastPrice: number };
  highlighted?: boolean;                // last-scanned ring (new, for the scan screen)
  onQtyDelta: (delta: number) => void;
  onSetBoxes: (value: number) => void;
  onSetPieces: (value: number) => void;
  onSetUnitQty: (value: number) => void;
  onSetSellBy: (mode: "case" | "unit") => void;
  onSetDiscountedPrice: (value: number | null) => void;
  onSetToFloor: (floorPrice: number) => void;
  onAckFloor: () => void;
  onToggleCostRevealed: () => void;
  onToggleNoteOpen: () => void;
  onSetNote: (note: string) => void;
  onUpdateUnlistedName: (name: string) => void;
  onUpdateUnlistedPrice: (value: number | null) => void;
  onRemove: () => void;
  onSwipeDelete?: () => void;           // new — scan screen only; CreateOrderModal omits it
  onTapPrice?: () => void;              // new — opens the floating price editor (§6); when
                                          // omitted, price stays inline-editable as today
}
```

Everything the row needs from outside (`floorForCategory`, `MarginHint`, `MoneyInput`,
`computeLineSubtotal`, `perUnitPrice`) is already imported by `CreateOrderModal.tsx:21-29`
and moves with the extraction. **No behavior changes during extraction** — this is a pure
lift-and-parametrize; `CreateOrderModal.test.tsx`'s existing assertions on rendered row
content must pass unchanged against the new component. `CreateOrderModal.tsx` then renders
`<LineItemRow ... />` in its `.map()` instead of the inline block, deleting the ~295 lines.

**Done when:** `CreateOrderModal.tsx`'s line-item `.map()` is `<LineItemRow item={li} ... />`
for every field above, `CreateOrderModal.test.tsx` passes unmodified (or with only prop-name
adjustments, no assertion changes), and a first consumer outside `CreateOrderModal` (the new
scan screen, §8 W3) renders the identical visual row for the same `LineItem` data.

### 4.2 Reused verbatim (no changes)

| Component/module | Path | Why it's already right |
|---|---|---|
| `MarginHint` | `apps/web/components/MarginHint.tsx` | Full cost/margin/floor/"Sell anyway"/cost-history unit, self-contained (`MarginHint.tsx:120-232`). |
| `MoneyInput` / `DecimalInput` | `apps/web/components/MoneyInput.tsx` | Local-state-while-focused decimal input; the fix for "type 2.50, get 2.05" (`MoneyInput.tsx:7-19`). |
| `BarcodeScannerButton` | `apps/web/components/BarcodeScannerButton.tsx` | The button + hook-in point stays; its **internals** change per §2, but the component keeps its existing 14-render-site contract (`onScan`, `inputRef`, `onError` props unchanged). |
| `resolveProductByCode` | `apps/web/lib/barcode-resolve.ts` | The full archived/ambiguous/network-error ladder (`barcode-resolve.ts:93-151`) — reused as-is, see §5. |
| `InlineCreateProductModal` | `apps/web/components/InlineCreateProductModal.tsx` | Unknown-barcode fallback, prefilled SKU (`CreateOrderModal.tsx:1953-1957`). |
| `@routeflow/pricing` (`computeLineSubtotal`, `normalizeBoxesPieces`, `roundMoney`, `getTierPrice`, `perUnitPrice`, `computeMarginFraction`, `priceForMarginFloor`, `classifyMargin`, `costPerSellingUnit`) | `packages/pricing/src/pricing.ts`, `tier-pricing.ts` | Verified exact exports/signatures — see §6.2. |
| `useMarginConfig`, `floorForCategory` | `apps/web/lib/api/margin.ts:6-25` | Per-category floor lookup, default `0.15`. |
| `LicenseGuardModal` | `apps/web/app/(dashboard)/orders/_components/LicenseGuardModal.tsx` | Regulated-category 409 guard, already wired into `CreateOrderModal` (`:34`, `:2045-2050`) — the scan screen must route its adds through the same handler so a regulated item mid-scan still triggers this, not a silent add (§7). |

### 4.3 New for this redesign

| New file | Purpose | Ported from (adapt, don't import — see §4.4) |
|---|---|---|
| `apps/web/components/LineItemRow.tsx` | §4.1 extraction. | — |
| `apps/web/components/ScanOrderScreen.tsx` | The full-screen scan overlay (§3): camera strip, hint/undo bar, scrollable `LineItemRow` list, pinned totals footer. Replaces `BarcodeScannerButton`'s current `scannerOpen` overlay for the CreateOrderModal call site specifically — other 13 render sites keep the old single-shot overlay (§4.5). | Layout/structure new; scan-loop wiring from `ScanCamera.web.tsx` |
| `apps/web/components/PriceEditor.tsx` | The floating price editor (§6) opened by tapping a row's price. | New — no direct mobile analog (mobile edits price inline in `ScanOrderSheet`'s own row, not a popover); design follows `MarginHint`'s existing `CostHistoryPopover` portal pattern (`MarginHint.tsx:26-109`) for the "floating" mechanic. |
| `apps/web/lib/scan-loop.ts` | Continuous-scan dedup gate (accept/reject a repeat within cooldown). | `apps/mobile/lib/scan-loop.ts` — ported with one deliberate simplification, §4.4. |
| `apps/web/lib/scan-pending-buffer.ts` | Depth-2 FIFO queue so a detection mid-resolve is buffered, not dropped. | `apps/mobile/lib/scan-pending-buffer.ts:1-80` — byte-identical port, zero web-specific logic in the original. |
| `apps/web/lib/scan-engine.ts` | Sequences the gate + buffer per frame/manual event. | `apps/mobile/lib/scan-engine.ts` — byte-identical port. |
| `apps/web/lib/scan-feedback.ts` | Pure `cueForOutcome(outcome) → "accepted" | "rejected" | "none"`. | `apps/mobile/lib/scan-feedback.ts:1-38` — byte-identical port. |
| `apps/web/lib/scan-cue.ts` | WebAudio beep + `navigator.vibrate?.()`, one file (web has only one platform, no `.web.ts` split needed). | `apps/mobile/lib/scan-cue.web.ts` — near-verbatim port (already browser DOM code). |
| `apps/web/lib/pending-scan-queue.ts` | Poor-signal queue: persists unresolved scanned codes to `localStorage`, retries `resolveProductByCode` in the background, reconciles into the item list when it succeeds. | New — no existing precedent in this codebase (verified: no `localStorage`/`indexedDB` offline-queue pattern anywhere in `apps/web/lib`). See §5.4. |

### 4.4 Why port instead of import

`apps/mobile` and `apps/web` are separate npm workspaces with no cross-app import path (only
`packages/*` is shared; confirmed no existing `apps/web` import of anything under
`apps/mobile`, and vice versa). `scan-loop.ts`/`scan-pending-buffer.ts`/`scan-engine.ts`/
`scan-feedback.ts` are pure, dependency-light TypeScript with no React Native import in any
of them (verified by reading all four in full) — they are prime candidates for a future
`packages/scanning` extraction, but that is **not a prerequisite for this feature** (flagged
as an open question, §10.3). For now, copy-and-adapt into `apps/web/lib/`, matching
`barcode-resolve.ts`'s own precedent of deliberately mirroring a mobile file
(`barcode-resolve.ts:20-22`: "Mirrors apps/mobile/lib/barcode-resolve.ts; the two rungs must
agree..."). Name the ported files identically to their mobile counterparts and add the same
"mirror, change both together" header comment convention.

**One deliberate simplification in the `scan-loop.ts` port:** mobile's gate matches on
`normalizeScanCode`'s full candidate set (`apps/mobile/lib/scan-loop.ts:56-62`) because
mobile has **two decoders that can disagree within one continuous session** (native
AVFoundation vs. `BarcodeDetector`/zxing on its web build) — the documented reason is "an
iOS 13-digit decode and a 12-digit decode of the same physical UPC-A must count as the same
item." apps/web's redesigned scanner runs **one decoder only** (zxing; dual-engine is out of
scope, §1) within one continuous session, so two detections of the same physical barcode
will always be byte-identical strings from the same decoder. The web port can therefore gate
on **raw string equality** instead of candidate-set intersection, dropping the
`normalizeScanCode` import entirely — same `SCAN_COOLDOWN_MS`/`ABSENCE_GAP_MS`/`SCAN_SLOTS`
constants and same multi-slot LRU shape (`apps/mobile/lib/scan-loop.ts:66-75`), because
the "two co-mingled physical items scanned in alternation" case (the reason for 4 slots, not
1) is unrelated to the decoder-disagreement case and still applies on web. Keep the
`gateScan(code, state, now)` function signature identical to mobile's so a later move to
`packages/scanning` — or a later dual-engine web decoder — needs no call-site changes, just
restoring the candidate-set match inside the gate.

### 4.5 `BarcodeScannerButton`'s other 13 render sites

`BarcodeScannerButton` is used at 14 render sites total (`mobile-scan-research.md` §1,
confirmed by grep): products page, product detail, inventory, vendor-bills, invoices
new/edit, `StockCountTab`, `ProductCreateModal`, `InlineCreateProductModal`, plus
`CreateOrderModal`. The §2 constraint-ladder fix (facingMode/resolution/focus/torch) is a
change to the **shared component's internals** and benefits all 14 sites for free. The §3
full-screen accumulating-list overlay (`ScanOrderScreen`) is **new UI specific to
CreateOrderModal's scan-to-order flow** — the other 13 sites keep `BarcodeScannerButton`'s
existing single-shot "decode → close → onScan" behavior (they each add exactly one thing per
scan: a filter, a line, a stock count — the "keep the camera open, accumulate a list" model
doesn't fit their existing UX and redesigning all 14 is out of scope). Implementation:
`BarcodeScannerButton` gains an optional `mode?: "single" | "continuous"` prop (default
`"single"`, preserving today's behavior everywhere); `CreateOrderModal` is the only caller
that passes `"continuous"`, which swaps in the scan-engine wiring and renders
`ScanOrderScreen` instead of the plain overlay.

---

## 5. Data flow

### 5.1 Scan → resolve → add/increment (happy path)

1. Camera frame decodes a string → `handleFrame(code)` (ported from
   `ScanCamera.web.tsx:265-281`) → `frameScanned(engine, code, Date.now())`
   (`scan-engine.ts`) → gate accepts (new code, or same code past cooldown+absence-gap) →
   buffer starts resolving.
2. Resolve calls `resolveProductByCode(code)` (`barcode-resolve.ts:93-151`) — **unchanged**,
   all four outcomes handled exactly as `CreateOrderModal.tsx:284-316` does today:
   - **Hit** (`!result.notFound && !result.archived`) → add-or-increment (below).
   - **Archived** → toast `"<Name> is archived — reactivate to sell"`
     (`CreateOrderModal.tsx:291-294`), row NOT added, scan cue plays "rejected".
   - **Ambiguous** (`result.ambiguous === true`, multiple sellable substring matches) —
     `CreateOrderModal`'s existing handler doesn't special-case this today (falls into the
     `!result.notFound && result.product` branch and silently takes `matches[0]`, per its
     own comment at `barcode-resolve.ts:136-139` and `CreateOrderModal.tsx:279-282`: "this
     surface keeps its historical multi-match behaviour: first row wins"). **Carry that
     behavior forward unchanged** for v1 of the scan screen — do not add a disambiguation
     picker; it's explicitly out of scope per the "keep camera open" goal (a picker would
     have to pause scanning). Flagged as a possible v2 enhancement only if first-row-wins
     produces a measurable wrong-item rate in practice.
   - **Not found** → open `InlineCreateProductModal` prefilled with the scanned code as SKU
     (`CreateOrderModal.tsx:313-315`). This pauses continuous scanning (the modal is itself
     a dialog) — resume the camera when it closes, whether created or cancelled.
   - **Network/5xx error** → toast, code NOT treated as not-found
     (`CreateOrderModal.tsx:301-310`) — cue plays "rejected"; the code is a candidate for
     the poor-signal queue (§5.4) if the error looks like a connectivity failure
     specifically (timeout, `ERR_NETWORK`), vs. a genuine 4xx/5xx from a reachable server.
3. **Add-or-increment** — reuses `addLineItem` (`CreateOrderModal.tsx:443-511`) verbatim:
   existing `productId` match → `qty + 1` (`:445-454`, already proven — "rescanning the same
   product already increments quantity," do not rebuild); new product → full line
   construction including tier pricing (`:456-503`).
4. On settle (success or reject), `playScanCue(cueForOutcome(outcome))` fires
   (`ScanCamera.web.tsx:239-245` pattern) — beep + vibrate on accept, a different
   beep pattern (no vibrate pattern change needed beyond what `scan-cue.ts` already encodes)
   on reject — **before** any toast renders, so the audible/haptic cue is immediate even if
   the toast is still animating in.
5. `scanSettled(engine)` (`scan-engine.ts`) advances the buffer, draining the next queued
   code if one arrived mid-resolve — recursing exactly as `ScanCamera.web.tsx:248-253`
   does, so a rapid-fire scan session never silently drops a code.
6. The newly-added/incremented row gets `highlighted: true` (new prop, §4.1) for ~2s, then
   clears — the "last-scanned row highlighted" ask.

### 5.2 Pricing with customer tier

`addLineItem` already resolves price as `getTierPrice(product, effectiveTier)` where
`effectiveTier = cpMap.get(product.id) ?? selectedCustomer?.pricingTier ?? 1`
(`CreateOrderModal.tsx:459-462`). **This is customer-tier-aware today, defaulting silently
to tier 1 (list price) when no customer is selected** — confirmed no re-pricing effect
exists: `selectedCustomer` is read in exactly the places listed at
`CreateOrderModal.tsx:150,154,196,200,383,459,698,711,739,931,998,1019,1125...`, and the
only `selectedCustomer`-keyed effect (`:381-383`) resets `appliedCredits`, not line prices.
**This is a real, pre-existing gap, not a hypothetical** — see §7 and §10.1 for the decision
this redesign needs the owner to make.

### 5.3 Totals

Reuse `computeLineSubtotal` exactly as `CreateOrderModal.tsx:390-401` sums it — the scan
screen's persistent footer total is `lineItems.reduce((sum, li) => sum +
computeLineSubtotal({unitPrice: li.unitPrice, qty: li.qty, boxes: li.boxes ?? null, pieces:
li.pieces ?? null, unitsPerBox: li.unitsPerBox ?? null}), 0)` — the same lines array the
modal already holds in state (the scan screen operates on the **same `lineItems` state**,
not a separate list that gets merged later — it's the modal's camera view, not a separate
cart). Item count is `lineItems.length` (or `lineItems.reduce((n, li) => n + 1, 0)` if a
"distinct items" vs. "total units" distinction is wanted — recommend **distinct items**
count in the header, since `qty` is already visible per-row and a units-total number next to
a $-total reads confusingly; keep the exact copy as an open question, §10.2, since it's a
one-line UI decision, not an architecture one).

### 5.4 Poor-signal tolerance

New module `apps/web/lib/pending-scan-queue.ts`. No existing offline-queue precedent exists
in this codebase to reuse (verified: no `indexedDB`, no offline-specific `localStorage`
queue pattern in `apps/web/lib` — `ServiceWorkerRegistry.tsx` only registers a service
worker for PWA install, it does not intercept/queue requests). Design:

```ts
interface PendingScan { code: string; scannedAt: number; tempId: string; attempts: number; }
```

- On a scan whose `resolveProductByCode` call fails with a **connectivity-shaped** error
  (`err.code === "ERR_NETWORK"`, a timeout, or `!navigator.onLine`), instead of the plain
  "Couldn't look up the code" toast (`CreateOrderModal.tsx:304-309`), insert a **placeholder
  row** into `lineItems` (`productName: code`, a distinct visual state — dimmed, a small
  spinner or "Resolving..." badge, no price yet) and push `{code, scannedAt, tempId,
  attempts: 0}` onto the queue, persisted to `localStorage` under a per-tab key (not
  per-tenant/global — a queued scan is this device's in-progress work, and mixing tabs risks
  double-resolving).
- A background interval (every 5s while `!navigator.onLine === false` i.e. online, backing
  off on repeated failure) drains the queue: re-run `resolveProductByCode`, and on success
  replace the placeholder row via the same add-or-increment path as §5.1 step 3, keyed by
  `tempId` so the row updates in place rather than duplicating.
- Cap queue depth and attempts (recommend depth 20, `attempts` cap 10 with exponential
  backoff) — this is a "bridge a few seconds of bad signal" mechanism, not a durable offline
  mode; if the operator closes the modal/tab with items still queued, the queue is lost
  (acceptable: nothing was ever added to the order, so there's nothing to reconcile on
  reopen — nothing silently drops from an order, it just never got read in the first place,
  same failure mode as "scan didn't work at all").
- Visible affordance: the "Undo last scan" / totals bar area shows a small "N resolving…"
  indicator when the queue is non-empty, so the operator isn't left guessing why a scanned
  item hasn't appeared yet.

---

## 6. The price editor

### 6.1 Trigger and fields

Tapping the price text on a `LineItemRow` (new `onTapPrice` prop, §4.1) opens `PriceEditor`
— a floating panel anchored under the row (same portal-to-`document.body` + viewport-clamped
positioning as `MarginHint`'s existing `CostHistoryPopover`, `MarginHint.tsx:26-109`, reused
as the structural pattern, not the component itself). Fields:

- **Unit selector**: a segmented control, **exactly** `CreateOrderModal`'s existing
  Case/Unit toggle (`CreateOrderModal.tsx:1617-1642`, driven by `li.sellBy: "case" | "unit"`
  and `setSellBy`) — not a new control. Only rendered when `item.unitsPerBox` is set (a
  non-boxed product has nothing to toggle, same as today's row).
- **Case mode**: two number inputs, "cases" and "extra units" (`setBoxes`/`setPieces`,
  `CreateOrderModal.tsx:1660-1681`).
- **Unit mode**: one "total units" input (`setUnitQty`, `:1645-1656`), which normalizes via
  `normalizeBoxesPieces` (§6.2).
- **Price**: the existing one-time-discount `MoneyInput`
  (`CreateOrderModal.tsx:1569-1575`), same `setDiscountedPrice` handler
  (`CreateOrderModal.tsx:633-...`), same "Last: $X.XX" price-history hint
  (`:1576-1581`).
- **Cost/margin**: `MarginHint` itself, embedded in the editor exactly as it renders in the
  row today (`CreateOrderModal.tsx:1587-1598`) — **not duplicated logic**, the same
  component instance moves into the floating panel. This is the mechanism that must
  "survive" per the brief — it does, unchanged, just relocated into a popover instead of
  inline under the price text.

### 6.2 Interaction with `@routeflow/pricing`

Verified exact signatures (`packages/pricing/src/pricing.ts`, `tier-pricing.ts`):

- **`computeLineSubtotal(input: LineSubtotalInput): number`** (`pricing.ts:112-135`) — the
  editor's live "this line will total $X" preview calls this on every keystroke, exactly as
  the row's own line-total display already does (`CreateOrderModal.tsx:1719-1725`).
- **`normalizeBoxesPieces(input): NormalizedQty`** (`pricing.ts:67-91`) — called by the
  editor's unit-mode "total units" field, identical to `setUnitQty`
  (`CreateOrderModal.tsx:620-627`): forces integer boxes/pieces and rolls overflow pieces
  into whole boxes.
- **`roundMoney(n: number): number`** (`pricing.ts:40-45`) — every monetary value the editor
  writes back (`setDiscountedPrice`, `onSetToFloor`) must be a value `computeLineSubtotal`
  itself already rounds; the editor does not need to call `roundMoney` directly on the price
  field (the `MoneyInput`'s own 2-decimal formatting plus `computeLineSubtotal`'s internal
  `roundMoney` call is the existing, sufficient discipline) but **must** call it on any
  derived value it computes itself (e.g. a "price per piece" preview using `perUnitPrice`,
  which already returns a rounded value — `pricing.ts:220-225`).
- **`getTierPrice(product, tier): number`** (`tier-pricing.ts:3-21`) — not called by the
  editor directly; it's what seeded `li.unitPrice`/`li.specialPrice` at add-time
  (`CreateOrderModal.tsx:462`). The editor only ever adjusts `discountedPrice` on top of
  that seed, same as today's inline row.

### 6.3 The margin floor

`priceForMarginFloor`/`classifyMargin`/`computeMarginFraction`/`costPerSellingUnit`
(`pricing.ts:220-268`) are `MarginHint`'s own internals — the editor doesn't call them
directly, it just renders `<MarginHint unitPrice={item.unitPrice} unitCost={item.unitCost}
unitsPerBox={item.unitsPerBox} floor={marginFloor} acked={floorAcked}
onSetToFloor={onSetToFloor} onSellAnyway={onAckFloor} .../>` (same props
`CreateOrderModal.tsx:1587-1598` already passes) inside the popover body. "Set to floor"
and "Sell anyway" behave identically to today: `setDiscountedPrice(tempId, floorPrice)` and
`ackFloor(tempId)` respectively — **no new floor-bypass path is introduced by moving this
into a popover.**

### 6.4 Dismissal

Mirrors `CostHistoryPopover`'s existing outside-click/Escape handling
(`MarginHint.tsx:46-67`), including its specific care around Escape: a capture-phase
`window` listener that calls `e.stopPropagation()` so Escape closes only the popover, never
the whole `CreateOrderModal` (which is itself listening for Escape at the document level,
`CreateOrderModal.tsx:1058`, and would otherwise discard the in-progress order). This is not
optional polish — it's the exact bug class `MarginHint.tsx:53-57`'s comment documents
happening once already.

### 6.5 Unit-kind selection and the pending unit-model rework

The owner's ask (§8 of the brief) is for "unit-kind selection... available at both the
create-order level and the scanning level, built flexibly since the underlying unit model is
being reworked separately." Verified: `local-assets/handoff/2026-09-18/units-po-plan/` holds
an in-progress, unmerged plan (`PLAN-units-po-v4.md`, "v4, final amendment pass") for a
**multi-level unit hierarchy** (`ProductUnit` model, "one base (piece) + integer
factor-to-base per level," `PLAN-units-po-v4.md:147-155`) that will eventually replace the
single `unitsPerBox` field this spec builds against. That plan is still at the decisions/
open-questions stage (§11 of that document) — it has not touched schema or code.

**Decision for this spec:** build the unit selector as the existing `sellBy: "case" | "unit"`
segmented control (§6.1), **not** a new abstraction that tries to anticipate the multi-level
model. The reasons:
1. Building against a not-yet-decided data model would mean guessing at an interface that
   plan's own open questions (§11 of `PLAN-units-po-v4.md`) haven't settled.
2. `normalizeBoxesPieces`'s signature (`{boxes, pieces, qty, unitsPerBox}`) is called from
   ~108 sites across the codebase per that plan's own audit (`units-po-context-pack.md:114-
   117`) — it is not this feature's place to change that signature.
3. `LineItemRow`'s props (§4.1) already isolate "how is unit chosen" behind
   `onSetSellBy`/`onSetBoxes`/`onSetPieces`/`onSetUnitQty` callbacks rather than inlining the
   segmented-control markup into the parent — so when the multi-level model lands, the
   *only* place that needs to change is `LineItemRow`'s internal rendering of those controls
   (and `CreateOrderModal`/`ScanOrderScreen`'s handler bodies), not every call site. That is
   the "built flexibly" the owner asked for: not a speculative interface, but a properly
   isolated one.

---

## 7. Edge cases

| Case | Behavior |
|---|---|
| **No customer selected** | Products section renders unconditionally today (`CreateOrderModal.tsx:1200-1236` has no `selectedCustomer` guard; confirmed by the existing B499 Playwright test explicitly scanning with no customer picked, `08-create-order-escape.spec.ts:271-273` comment). Scanning proceeds and prices at tier 1 / list (`CreateOrderModal.tsx:459`, `?? 1` fallback) with **no re-price when a customer is picked afterward** (verified, §5.2) — this is a pre-existing gap the redesign inherits unless fixed. Recommendation (needs owner decision, §10.1): show a persistent, dismissible banner in `ScanOrderScreen` — "No customer selected — prices shown are list price" — and add a `selectedCustomer`-keyed effect that re-prices every non-manually-overridden line (`priceType !== "DISCOUNTED" && priceType !== "MANUAL"`) when a customer is subsequently chosen, closing the gap for both the scan screen and the classic modal flow in one change. |
| **Unknown barcode** | Existing, unchanged: `InlineCreateProductModal` opens prefilled with the code as SKU (`CreateOrderModal.tsx:313-315`). Pauses continuous scanning while open; resumes on close either way (created or cancelled). |
| **Duplicate scan (same item)** | Existing, unchanged: qty increments (`CreateOrderModal.tsx:445-454`) — do not rebuild. The new continuous-scan **gate** (§4.3/4.4) determines whether a rapid repeat within `SCAN_COOLDOWN_MS`(600ms)/`ABSENCE_GAP_MS`(300ms) counts as a deliberate re-scan at all, before it ever reaches `addLineItem`; a repeat that clears the gate always increments, never duplicates a row. |
| **Ambiguous multi-match** (`resolveProductByCode` returns `ambiguous: true`) | First-row-wins, unchanged (§5.1) — no picker in v1. |
| **Archived product** | Toast + no add, unchanged (`CreateOrderModal.tsx:291-294`) — cue plays "rejected." |
| **Regulated/tracked category** | `addLineItem`'s catch-all doesn't check this directly — the 409 `REGULATED_AUTH_REQUIRED` guard fires at order-submit time via `LicenseGuardModal` (`CreateOrderModal.tsx:2045-2050`), not at add-time; a scanned regulated item is added to the list exactly like any other item (with its amber "· regulated" chip, `CreateOrderModal.tsx:1558-1562`, ported into `LineItemRow`) and the guard only engages on Create/Save. No change needed — the scan screen inherits this by using the same `lineItems` state and the same submit path. |
| **Damaged label (can't decode)** | Manual barcode entry, always available (not just on decode failure) as a persistent "Enter code manually" link near the hint line (§3), mirroring `ScanCamera.web.tsx`'s always-rendered manual-entry card (`ScanCamera.web.tsx:518-519`: "The card always carries a way into manual entry, so it always renders") and its auto-trigger on a decode exception (`ScanCamera.web.tsx:492-493`: `setError(...); setManualMode(true)`). A manual submission **skips the gate** (it's definitionally intentional — no cooldown applies) but still goes through the buffer (`manualScanned`, `scan-engine.ts:88-101`), so a manual entry arriving mid-resolve of a camera scan is queued, not dropped. |
| **Camera permission denied** | `BarcodeScannerButton`'s existing `classifyScannerError` already handles this (`BarcodeScannerButton.tsx:27-38`: `NotAllowedError`/`PermissionDeniedError` → "Camera access was denied..."). Unchanged; `ScanOrderScreen` shows this as an inline message with the manual-entry link promoted to the primary affordance (camera strip area shows the error text instead of a black box). |
| **No camera present** | `classifyScannerError`'s `NotFoundError`/`DevicesNotFoundError` branch (`BarcodeScannerButton.tsx:31-33`) — same treatment as permission-denied: manual entry becomes primary. |
| **Poor signal** | §5.4 — placeholder row + background retry queue. |
| **Very long product names** | `LineItemRow` already truncates (`CreateOrderModal.tsx:1507`: `<p className="truncate text-sm font-medium text-navy">`) — carried into the extraction unchanged. At the narrower scan-screen row width (list area is full-width but rows are denser per §3), verify the truncation point still leaves price/qty controls room; no logic change, a Playwright visual check (§9) should include one very-long-name product in the seeded fixture set. |
| **Product with no price for that tier** | `getTierPrice` (`tier-pricing.ts:3-21`) falls back to `product.pricePerUnit` when a tier field is null/unset (verified by reading its full body — the fallback is unconditional, not tier-specific), so this never surfaces as a missing price; it silently prices at list. No new handling needed, but worth a one-line note in `PriceEditor`'s tier-price context (if shown) so an operator doesn't mistake list-price-via-fallback for an intentional tier-2+ discount. |

---

## 8. Work breakdown

Dependencies flow top to bottom; items in the same tier can run in parallel.

**W1 — Extract `LineItemRow`** (§4.1). *Blocking prerequisite for everything else.*
Depends on: nothing. Done when: `CreateOrderModal.tsx`'s inline row is gone, replaced by
`<LineItemRow>`, `CreateOrderModal.test.tsx` passes with only prop-shape edits (no assertion
changes), and the extracted component's props match §4.1's list. Est. size: medium (pure
refactor, ~300 lines moved, zero new behavior).

**W2 — Camera constraint fix** (§2). Depends on: nothing (independent of W1 — this is
entirely inside `BarcodeScannerButton.tsx`'s existing `init()`). Done when: `openCamera()`'s
degrading ladder replaces the bare `decodeFromVideoDevice(deviceId, ...)` call, torch
renders only when `caps.torch`, and the change ships to all 14 existing render sites with
zero behavior change to their single-shot contract (only the underlying camera quality
changes). Est. size: small-medium. This can land and ship **before** the rest of the
redesign — it's a real fix on its own, independent of the accumulating-list UI.

**W3 — Port the scan engine** (§4.3/4.4: `scan-loop.ts`, `scan-pending-buffer.ts`,
`scan-engine.ts`, `scan-feedback.ts`, `scan-cue.ts`). Depends on: nothing (pure modules, no
UI). Done when: each ported file has its own Jest spec mirroring the mobile original's spec
shape (`apps/mobile/__tests__/scan-loop.test.ts` etc. as the template — same test names
translated, since the logic is the same minus §4.4's normalization simplification). Est.
size: small (mostly copy + adapt + re-spec; the hard design work is already done on mobile).

**W4 — `ScanOrderScreen`** (§3, §5). Depends on: **W1** (renders `LineItemRow`), **W2**
(needs the fixed camera), **W3** (needs the engine to wire `handleFrame`/`handleManual`).
Done when: the layout in §3 renders at 390/768/1440, camera stays open across scans, list
accumulates via the real `addLineItem` path, totals/undo/manual-entry are all present and
wired. Est. size: large — this is the actual feature.

**W5 — `PriceEditor`** (§6). Depends on: **W1** (embeds `LineItemRow`'s existing
`MarginHint`/`MoneyInput` wiring) — can develop in parallel with W4 once W1 lands, since it's
a self-contained popover triggered from a row. Done when: tapping price opens the editor
with unit selector + price + margin hint, all writes route through the same
`setDiscountedPrice`/`setBoxes`/`setPieces`/`setUnitQty`/`setSellBy` handlers `LineItemRow`
already exposes. Est. size: medium.

**W6 — Poor-signal queue** (§5.4). Depends on: **W4** (needs `ScanOrderScreen`'s add path to
insert placeholder rows into). Done when: a simulated network failure (Playwright route
interception, §9) shows a placeholder row, then resolves it once the route is un-blocked.
Est. size: medium.

**W7 (stretch, not required for v1) — Dual decode engine** (`BarcodeDetector` + zxing, per
§1's non-goals). Only pursue if W2's constraint fix alone doesn't measurably improve decode
speed/reliability in the field. Est. size: medium, genuinely optional.

Suggested sequencing: **W1 and W2 in parallel first** (both are prerequisites and both are
independently shippable/valuable), then **W3** (independent, can also run parallel to W1/W2
since it touches no existing file), then **W4** once W1+W2+W3 all land, then **W5** in
parallel with the tail of W4, then **W6** last.

---

## 9. Test strategy

### 9.1 What Playwright can genuinely cover

Everything **except the camera decode itself**:

- **The list**: seed `lineItems` state by mocking `BarcodeScannerButton`'s `onScan` callback
  directly and invoking it from the test — exactly the existing pattern
  `CreateOrderModal.test.tsx` already uses (`jest.mock("@/components/BarcodeScannerButton",
  ...)`, capturing the live `onScan`/`onError` props, per the research file's confirmed
  §8 finding). This proves the row renders, accumulates, increments on repeat `onScan`
  calls, and totals recompute — **without needing a real camera at all**, since `onScan` is
  the seam between decode and everything this spec actually changes about the *data flow*.
- **Editing**: `PriceEditor` open/close, unit-toggle, price write-back, margin-floor
  "Set to floor"/"Sell anyway" — all driven by clicks/fills on rendered DOM, same techniques
  `13-boxed-order-entry.spec.ts` already uses for the classic modal's boxed-qty inputs
  (including its documented `fill()`-on-`type=number` refocus race,
  `.claude/code-map/web/e2e-tests.md:123` — the same guard pattern applies to any new
  number input in `PriceEditor`).
- **Totals**: assert the footer total against a manually-computed
  `computeLineSubtotal` sum for a scripted sequence of `onScan` calls — a money-math test
  that needs no camera.
- **Navigation**: scan screen open → items accumulate → Done → back in `CreateOrderModal`
  with the same `lineItems` state → Create Order — fully coverable, it's just component
  state and routing, no camera involved.
- **Undo, manual entry submit, swipe-to-delete**: all DOM interactions on already-rendered
  rows; manual entry specifically is a text input + button, indistinguishable in test terms
  from typing a SKU into the existing product search box today.
- **Poor-signal queue**: Playwright route interception (`page.route(...)` failing then
  un-failing a `/products/barcode/:code` or `/products?scanCode=` call) — this is the
  existing, well-supported technique other specs in this repo already use for
  network-condition tests; no camera needed since the queue operates on the *result* of a
  resolve attempt, not the scan itself.

### 9.2 What Playwright cannot cover, and the honest boundary

**The actual camera experience — decode reliability, focus, real-device layout — is
structurally untestable in this repo's current CI the same way it is today.** Verified: zero
hits for `fake-video`/`use-fake-device`/`BarcodeDetector`/`getUserMedia` across
`apps/web/e2e/**`, and `apps/web/playwright.config.ts` configures no
`--use-fake-device-for-media-stream`/`--use-file-for-fake-video-capture` launch args on any
project (confirmed by grep — no `launchOptions.args` mentioning fake devices anywhere in the
file). This redesign does not change that boundary; it inherits it.

Two options, not mutually exclusive:

1. **Add a fake-camera Playwright fixture** — a new, narrowly-scoped project in
   `playwright.config.ts` launching Chromium with
   `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<barcode.y4m>`
   (a short looping video of a real barcode, checked into `apps/web/e2e/fixtures/`). This
   *can* prove the `getUserMedia` constraints are accepted and that zxing decodes something
   from a synthetic stream end-to-end — genuinely valuable as a smoke test that the wiring
   didn't regress (constraints rejected outright, decode loop never starts, etc.) — but it
   proves **decode from a synthetic file**, not real-world focus/lighting/distance behavior,
   and Chromium's fake-device flags have no Safari/WebKit equivalent, so it can never stand
   in for the iOS Safari behavior this whole feature is really about.
2. **Manual, real-device verification** — required regardless of (1), because (1) cannot
   exercise iOS Safari at all. Verification checklist for whoever ships W2/W4: an iPhone in
   mobile Safari, at a normal counter-scanning distance (~15-25cm), scanning a printed
   barcode under typical fluorescent lighting — confirm focus lock/blur behavior, confirm
   the resolution bump (§2.2) visibly improves decode success vs. the current 640×480
   default, confirm torch button is absent (§2.5), confirm the beep/vibrate cue (vibrate
   silently no-ops, beep audible) plays on both accept and reject.

**Recommendation**: build (1) as a CI smoke test (cheap, catches wiring regressions, part of
W3/W4's own test suite) and treat (2) as a **mandatory manual sign-off gate** before W2/W4
ship, documented the same way this repo already documents its `local:e2e` manual-verification
boundary (`CLAUDE.md`'s "Hosted staging is still deferred... this lane catches a UI
regression before that" framing) — i.e., name it explicitly as a gate in the PR description,
not an implied "someone probably checked."

### 9.3 Existing specs this touches

- `apps/web/e2e/08-create-order-escape.spec.ts:271-306` (B499's mobile scan-button test) —
  must keep passing unchanged; it only asserts the button's presence/size, which §2/§4.5
  don't change (the button itself, its `title`/`className` props, stay identical).
- `CreateOrderModal.test.tsx`, `BarcodeScannerButton.test.tsx` — both need updates for the
  `LineItemRow` extraction (prop-shape only) and the `mode` prop addition (§4.5); no
  assertion should need to change in a way that weakens what's covered.

---

## 10. Open questions for the owner

**10.1 — Customer-first pricing.** Confirmed real gap (§5.2, §7): scanning before choosing a
customer prices at list with no re-price when a customer is picked afterward, in **both**
the existing modal and (unless changed) the new scan screen. Three options:
  - (a) Require a customer before the scan screen opens (simplest, but blocks the
    "operator scans while looking for the customer" workflow some counters actually use).
  - (b) Allow scanning with no customer, show a persistent "list price — pick a customer to
    reprice" banner, no automatic reprice (current behavior, made visible instead of silent).
  - (c) Allow scanning with no customer, auto-reprice non-overridden lines when a customer
    is subsequently selected (closes the gap for real, fixes the classic modal too, but is
    the largest of the three options and touches code outside this feature's direct scope).

  This changes the build (a) shrinks W4, (c) adds a new cross-cutting effect touched by both
  `CreateOrderModal` and `ScanOrderScreen`) enough to need a decision before W4 starts.

**10.2 — Item-count semantics.** §5.3: does the persistent header count **distinct SKUs
scanned** or **total units**? Cosmetic, but changes what a single number means to the
operator mid-scan — worth one line from the owner rather than guessing.

**10.3 — Promote the ported scan modules to `packages/scanning`?** §4.4 recommends copying
mobile's `scan-loop.ts`/`scan-pending-buffer.ts`/`scan-engine.ts`/`scan-feedback.ts` into
`apps/web/lib/` rather than extracting a shared package now. That's the right call for this
feature's timeline, but it does create a second mirror pair (alongside `barcode-resolve.ts`'s
existing one) that someone has to remember to keep in sync, per the same "mirror" discipline
`barcode-resolve.ts:20-22` already documents for its own case. Worth a explicit owner call:
accept the second mirror for now (matches existing precedent), or fund the
`packages/scanning` extraction as a fast-follow. Not blocking — either answer lets W3 start
today with the identical port described in §4.3.

**10.4 — Ambiguous-match picker.** §5.1/§7: first-row-wins is carried forward unchanged for
v1. If wrong-item adds from ambiguous matches turn out to be a real operator complaint (no
evidence of this yet — it's an inherited behavior, not a reported bug), a v2 could pause
continuous scanning to show a picker, mirroring the desktop-search-picker behavior a plain
typed search in the same modal already offers implicitly (multiple results in a dropdown).
Not needed for v1; flagged so nobody is surprised it's out of scope.
