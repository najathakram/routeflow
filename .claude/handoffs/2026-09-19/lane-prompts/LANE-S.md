# Lane S — scanner redesign + order UI (window title: "RouteFlow Lane S")

Read `LANE-COMMON.md` first. Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-lane-S`, branches `feat/s-<step>`.
Specs: `local-assets/handoff/2026-09-18/scanner-redesign-spec.md` and
`order-ui-redesign-spec.md`. Evaluation cards S1 + S2. Flags: `scan_v2` (new scan screen),
`order_ui_v2` (card list + quick-order extras) — both dark until the owner flips them.

## Owner rulings that fix the spec's open questions
- D1: a scanned line takes the CUSTOMER price immediately when a customer is chosen first.
- D2: the scan header counts DISTINCT SKUs.
- D3: typeahead + duplicate-line MERGE are in scope; paste-list / saved lists are NOT.
- Spec 10.3: promote the scan engine to `packages/scanning` now (one source, no mirror pair).
- Spec 10.4 / W7 dual-decode: skip.

## What already exists (do not rebuild)
`apps/web/components/LineItemRow.tsx` (#933, merged); mobile engine
`apps/mobile/.../scan-loop.ts` + `scan-pending-buffer.ts`; `ScanCamera(.web).tsx` with 8
formats incl. ITF-14 and `autofocus="on"`; react-hook-form + zod in `CreateOrderModal.tsx`
(2,059 lines); Lane F findings B564 (footer "Minimize" clipped at 390) and B565 (boxed row
overlap at 390) with proof shots in `local-assets/proofs/2026-09-19/933/`.

## Order of work (one PR each; est. builder-days)
1. **W2 camera** — compact landscape viewfinder, autofocus, torch toggle, per-code cooldown
   (no duplicate rows from repeated frames), haptic/beep on accept. Shippable alone. 0.5
2. **W3 engine → `packages/scanning`** — move gate + pending buffer + cue logic; web and
   mobile import it; unit tests move with it. 0.5
3. **B564 + B565 + buyer-portal table** — fix the 390 px footer and boxed row; wrap the
   buyer orders table (`apps/web/app/buyer/portal/[seller]/orders/page.tsx`) in an
   `overflow-x-auto` container with a sticky first column and a card list under 640 px. 1.0
4. **Prefactor** — extract the scan mode out of `CreateOrderModal.tsx` into
   `orders/_components/scan/` (behaviour identical; F diffs it). 0.5
5. **W4 ScanOrderScreen** — stays open after each scan; accumulating rows; ± and typed qty;
   note; undo; customer price immediately (D1); distinct-SKU header (D2); unit at both levels
   via the unit picker Lane U delivers (until then, label only). 2.0
6. **W5 PriceEditor** — floating editor on tap, floor warning reused from LineItemRow. 1.0
7. **W6 poor-signal queue.** 0.5
8. **Order UI T1/T2/T4/T5** — widen selects, "View order" toast after create, read-only
   LineItemRow variant, product-name composition. 1.25
9. **Prefactor** — extract the line list of `orders/[id]/page.tsx` (163 KB) into
   `orders/[id]/_components/`. 0.5 · then **T6 card list + T7 action bar.** 2.0
10. **Quick-order extras** — SKU/name typeahead in the line entry; duplicate-line merge
    (same SKU + same unit → one line, qty summed, toast). 1.5
11. **T8 React-Native mirror** of the card list + toast. 1.0

Proof: Playwright with injected barcode events (mock the detector) for every scan state;
Impeccable visual review + F Playwright 1440/768/390 for each UI PR; mobile autofocus needs a
device check — post FINDING with what you could not prove.
