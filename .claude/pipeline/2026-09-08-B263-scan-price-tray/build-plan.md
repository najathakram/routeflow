# Build plan — B263 (price edit inside the scan flow over a paused camera)

Mode `bugfix`, scale `minor`. Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F25`, branch
`fix/B263-scan-price-tray` (off master eb2b815e; merge `origin/master` before landing). Design of record
`cause-ruling.md` §2; tests `bug-test-plan.md`; binding facts `cause-refutation.md` (5 taps today; the ternary
at :806; sheets stack over the live camera; no SPECIAL gate; rounding gap; action pill never rendered).
Option-B bookkeeping: no map/lessons/ledger edits. Never Expo/Playwright; no UI verify on this host.

## Packages

### P1 — pure helper (Opus `high`, money)

`apps/mobile/lib/price-override.ts` (new): `applyPriceOverride(item, { unitPrice, reason })` and
`needsMarginAck(item, newPrice, floor)` per `cause-ruling.md` §2 D2, importing `roundMoney` +
`computeLineSubtotal` from `@routeflow/pricing`; the item shape = the draft item type edit-items.tsx uses
(import its type; do not redeclare).

### P2 — scanner (Sonnet `medium`)

`apps/mobile/components/BarcodeScanner.tsx`, `apps/mobile/components/BarcodeScanner.web.tsx`: `active?: boolean`
(default true) forwarded as `<ScanCamera active={active && !paused}>`; render `feedback.action` as the pill
button exactly as `ScanOrderSheet.tsx:171-184`. Nothing else.

### P3 — edit screen (Sonnet `high`; dependsOn P1, P2)

`apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx`: (1) the list-branch `PriceOverrideModal` apply
path calls `applyPriceOverride` (rounding fix) and `needsMarginAck` where the inline ack logic sat (~`:1189`);
(2) picker branch: state `pickerPriceEditItem`; after a successful scan-add show the "last added" strip with
an `Edit price` control (reuse the picker's existing feedback surface if it renders the line); tapping opens
`<PriceOverrideModal>` rendered in the picker branch with the same props as the list branch; pass
`active={!pickerPriceEditItem}` to the picker's `<BarcodeScanner>`; Apply → `applyPriceOverride` →
`updateDraftItem` (the list branch's setter) → close → camera resumes. `canEditPrice` unchanged. Do not touch
`addPickedToDraft`, the ladder, `ProductPickerSheet`, `InlineCreateProductSheet`, `BarcodeFab`.

### TP-MOBILE — tests (Sonnet `medium`)

`apps/mobile/__tests__/price-override.test.ts`, `edit-items-scan-price.test.ts`, `barcode-scanner-active.test.ts`
per `bug-test-plan.md` T1–T3; REG token `REG-B263` on their titles; implement nothing.

## Gates

Per round: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json`; `cd apps/mobile && npx jest __tests__/price-override.test.ts __tests__/edit-items-scan-price.test.ts __tests__/barcode-scanner-active.test.ts __tests__/scan-ladder.test.ts __tests__/edit-items-scan-fab.test.ts --runInBand`.
Final: `cd apps/mobile && npx jest --silent`; `npm run lint -w apps/mobile`; `node scripts/validate-lessons.mjs`.
Red gate: `cd apps/mobile && npx jest --runInBand -t "REG-B263"` must FAIL before P1–P3.

## Pipeline args — see `pipeline-args.json`.

## Landing (Lead)

Commit (trailer `Bookkeeping-Follow-Up: pending`) → merge origin/master → regen api/mobile/pricing reports →
campaign-check → hook push → draft PR `fix(mobile): price edit inside the scan flow over a paused camera (B263)`
→ window (mobile-only → Railway rows SKIPPED) → docs follow-up (B263 done with REG names; B246 option B twin
closed; row for the sibling sweep; lesson candidate: "a ternary between two screen modes makes every affordance
of one mode unreachable from the other — stack sheets, don't swap"; mobile code map; owner device check).
