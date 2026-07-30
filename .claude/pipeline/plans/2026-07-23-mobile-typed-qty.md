# Plan: Typed quantity input on mobile order/cart/catalog steppers

**Status:** PLANNED
**Scale:** major (new shared component + 4 gap surfaces + store action)
**Stacks on:** the "mobile line-field preservation" branch (PR B) — this branch already contains
the pure `sale-line.ts` helpers `decrementLine / setLineQty / setLineBoxes / setLinePieces` and
the field-preserving setter rewiring. Reuse them.

## Context

In RouteFlow's Expo app (`apps/mobile`), order/invoice line quantity can only be changed by
tapping +/−. Users want to also TYPE the quantity. A typed-input pattern already exists in 5
per-screen copies (draft string + `sanitizeIntInput` + number-pad + commit); four order-placement
surfaces still render the qty as a plain `<Text>` and lack typing. This adds a small shared
component and wires it into those four, consolidating the duplicated logic.

Constraints:

- Boxed products split qty into `boxes` + `pieces` (pieces clamp to `unitsPerBox − 1`, NO
  rollover into boxes — matches the existing cart sheet). Server normalizes authoritatively later.
- Mobile's established contract is **live-commit while typing** (all 5 existing copies do this),
  not web's commit-on-blur.
- Mobile Jest is pure-logic only (ts-jest, node env, `*.test.ts`) — no RN component render tests.
  Only `commitQtyDraft` and `cartStore.setUnits` are unit-testable; components are manual-checklist.
- Repo convention: app-local shared components live in `apps/mobile/components/` (precedents:
  `MoneyTextInput.tsx`, `PhotoCapture.tsx`). Do NOT touch `packages/ui`.

## Existing helpers (already present on this branch)

- `apps/mobile/lib/qty.ts`: `sanitizeIntInput(text)`, `parseIntQty(text, fallback)` (tested).
- `apps/mobile/lib/sale-line.ts` (from PR B): `setLineQty`, `setLineBoxes`, `setLinePieces`,
  `decrementLine` — pure, `...prev`-preserving, `null` return = remove line.

## Work packages

### WP1 — `commitQtyDraft` in `lib/qty.ts` + tests

**Files:** `apps/mobile/lib/qty.ts`, `apps/mobile/__tests__/qty.test.ts`.
Add a pure blur-resolver below `parseIntQty`:

```ts
/**
 * Resolve a qty draft at commit time (blur). Returns the number to commit, or
 * null → revert to the current value.
 * - empty draft: 0 when emptyMeansZero (line-removal semantics), else revert.
 * - below min (e.g. typed "0" on a min-1 surface): revert.
 * - above max: clamp (matches the cart sheet's pieces field — no rollover).
 */
export function commitQtyDraft(
  draft: string | null | undefined,
  opts: { min?: number; max?: number; emptyMeansZero?: boolean } = {},
): number | null {
  const { min = 0, max, emptyMeansZero = true } = opts;
  const clean = sanitizeIntInput(draft);
  if (clean === "") return emptyMeansZero ? Math.max(0, min) : null;
  const n = parseInt(clean, 10);
  if (!Number.isFinite(n) || n < min) return null;
  return max != null ? Math.min(max, n) : n;
}
```

Tests (`qty.test.ts`, new `describe("commitQtyDraft")`): empty+default→0; empty+`emptyMeansZero:false`→null;
`"0"`+`min:1`→null; `"0"`+default→0; `"15"`+`max:11`→11; `"007"`→7; `"abc"`→treated as empty
(→0/null per flag); `"1.5"`→1; `min:1,"3"`→3.

### WP2 — New `apps/mobile/components/QtyStepper.tsx`

**File:** new. Exports `QtyTextInput` (the consolidation primitive) and `QtyStepper` (bordered
−/input/+ pill). Full component code — implement as written:

```tsx
import * as React from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { sanitizeIntInput, parseIntQty, commitQtyDraft } from "../lib/qty";

export interface QtyTextInputProps extends Omit<
  TextInputProps,
  "value" | "onChangeText" | "keyboardType"
> {
  value: number;
  onChangeQty: (n: number) => void;
  min?: number; // default 0
  max?: number;
  emptyMeansZero?: boolean; // default true (blur on empty commits 0)
}

/**
 * Integer qty TextInput: local draft so the field can be cleared mid-edit,
 * sanitized per keystroke, valid values committed live, blur resolves
 * empty/below-min via commitQtyDraft. Consolidates the copies previously
 * inlined in CartStepperRow / StepperRow / QtyStepperRow / short-pick.
 */
export function QtyTextInput({
  value,
  onChangeQty,
  min = 0,
  max,
  emptyMeansZero = true,
  style,
  ...rest
}: QtyTextInputProps) {
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => {
    setDraft(String(value));
  }, [value]);
  return (
    <TextInput
      style={style}
      value={draft}
      onChangeText={(txt) => {
        const clean = sanitizeIntInput(txt);
        setDraft(clean);
        if (clean === "") return;
        const n = parseIntQty(clean, value);
        if (n >= min) onChangeQty(max != null ? Math.min(max, n) : n);
      }}
      onBlur={() => {
        const committed = commitQtyDraft(draft, { min, max, emptyMeansZero });
        if (committed != null && committed !== value) onChangeQty(committed);
        setDraft(String(value)); // prop-sync effect corrects after parent updates
      }}
      keyboardType="number-pad"
      returnKeyType="done"
      maxLength={5}
      selectTextOnFocus
      {...rest}
    />
  );
}

/** Bordered −/input/+ pill matching styles.stepper (md) / miniStepper (mini). */
export function QtyStepper({
  value,
  onChangeQty,
  onIncrement,
  onDecrement,
  min = 0,
  max,
  emptyMeansZero = true,
  size = "md",
  suffix,
}: {
  value: number;
  onChangeQty: (n: number) => void;
  onIncrement?: () => void;
  onDecrement?: () => void;
  min?: number;
  max?: number;
  emptyMeansZero?: boolean;
  size?: "md" | "mini";
  suffix?: string;
}) {
  const dec = () => {
    if (onDecrement) onDecrement();
    else onChangeQty(Math.max(min, value - 1));
  };
  const inc = () => {
    if (onIncrement) onIncrement();
    else onChangeQty(max != null ? Math.min(max, value + 1) : value + 1);
  };
  const s = size === "mini" ? mini : md;
  return (
    <View style={s.pill}>
      <Pressable style={s.btn} onPress={dec} hitSlop={6}>
        <Text style={s.btnText}>−</Text>
      </Pressable>
      <QtyTextInput
        value={value}
        onChangeQty={onChangeQty}
        min={min}
        max={max}
        emptyMeansZero={emptyMeansZero}
        style={s.input}
      />
      {suffix ? <Text style={s.suffix}>{suffix}</Text> : null}
      <Pressable style={s.btn} onPress={inc} hitSlop={6}>
        <Text style={s.btnText}>+</Text>
      </Pressable>
    </View>
  );
}

const md = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    padding: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  btn: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  btnText: { color: ios.brand, fontSize: 18 },
  input: {
    minWidth: 28,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingVertical: 0,
    paddingHorizontal: 2,
  },
  suffix: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingRight: 2,
  },
});
const mini = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    padding: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  btn: { width: 26, height: 26, alignItems: "center", justifyContent: "center" },
  btnText: { color: ios.brand, fontSize: 16 },
  input: {
    minWidth: 24,
    textAlign: "center",
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingVertical: 0,
    paddingHorizontal: 2,
  },
  suffix: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingRight: 2,
  },
});
```

**Before finalizing styles:** open `NewOrderScreen.tsx` `styles.stepper`/`stepBtn`/`stepQty`
(~L2312-2330) and `styles.miniStepper`/`miniStepQty` (~L2412-2430) and reconcile the exact
token names (`ios.bgElev`/`ios.separator`/`ios.brand`/`ios.label`) with what those styles use —
match them so the pill looks identical. `paddingVertical: 0` on the input is required (Android
TextInput default padding would grow the pill).

### WP3 — Wire NewOrderScreen gap surfaces

**File:** `apps/mobile/components/NewOrderScreen.tsx`. Import `QtyStepper` from `./QtyStepper`.

- Non-boxed pick tile (L1231-1241): replace the `styles.stepper` View with
  `<QtyStepper value={q} onChangeQty={(n) => setQty(p.id, n)} onIncrement={() => inc(p.id)} onDecrement={() => dec(p.id)} />`
  (`inc`/`dec` = the existing addOne/removeOne wrappers used there; `setQty` already field-preserving via PR B).
- Boxed dual (L1247-1295): replace each `styles.miniStepper` View with a mini QtyStepper —
  Boxes: `<QtyStepper size="mini" value={line?.boxes ?? 0} onChangeQty={(n) => setBoxes(p.id, n)} />`;
  Pieces: `<QtyStepper size="mini" value={line?.pieces ?? 0} max={upb - 1} onChangeQty={(n) => setPieces(p.id, n)} />`.
- Delete the now-unused `miniStepper*` styles (grep to confirm no other references; KEEP
  `stepper*`/`stepQty` — CartStepperRow still uses them).
- Add `keyboardShouldPersistTaps="handled"` to the product-list ScrollView so +/− taps register
  while the keyboard is open.

### WP4 — Wire invoices/new gap surface

**File:** `apps/mobile/app/(operator)/(tabs)/invoices/new.tsx`. Import `QtyStepper` and (from
`../../../../lib/sale-line`) `setLineBoxes, setLineQty`.

- Add a `setUnits(id, n)` helper after `removeOne`, built on the PR B helpers so it preserves
  `...prev` (unitPrice) and handles boxed vs loose + delete-at-zero:
  ```ts
  const setUnits = (id: string, n: number) => {
    const p = productById.get(id);
    const upb = Number(p?.unitsPerBox ?? 0);
    setItems((m) => {
      const prev = m[id];
      if (!prev) return m;
      const line = upb > 1 ? setLineBoxes(prev, n, upb) : setLineQty(prev, n);
      const next = { ...m };
      if (!line) delete next[id];
      else next[id] = line;
      return next;
    });
  };
  ```
- Main list block (L586-595): `<QtyStepper value={isBoxed ? (line?.boxes ?? 0) : q} onChangeQty={(n) => setUnits(p.id, n)} onIncrement={() => addOne(p.id)} onDecrement={() => removeOne(p.id)} suffix={isBoxed ? ((line?.pieces ?? 0) > 0 ? \`b + ${line?.pieces}\` : "b") : undefined} />`. Delete the now-unused `stepLabel` computation (L561-563).
- Review sheet catalog rows (L834-842): same `QtyStepper`; add an `onSetUnits` prop to the review
  sheet component (~L746-761) wired to `setUnits` at the call site (~L700). Delete the local
  `stepLabel` (L811-813).
- Unlisted rows (L875-889): `<QtyStepper value={u.qty} onChangeQty={(n) => onChangeUnlistedQty(u.id, n)} />` (default dec at 1 → 0 → the existing `updateUnlistedQty` filters it out).
- Delete the now-unused local `stepper*` styles (L1094-1112) after grep-confirming.
- Add `keyboardShouldPersistTaps="handled"` to the main list ScrollView and the review sheet ScrollView.

### WP5 — cartStore.setUnits + customer cart & catalog

**Files:** `apps/mobile/store/cartStore.ts`, `apps/mobile/app/(customer)/orders/cart.tsx`,
`apps/mobile/app/(customer)/(tabs)/catalog.tsx`.

- `cartStore.ts`: add a `setUnits(productId, units)` action (interface after `step`; impl after
  `step`): find item; if `units <= 0` remove it; else `{ ...i, ...boxedFields(i.unitsPerBox, units) }`
  (reuse the existing `boxedFields` helper the store already uses). Extend `__tests__/cart-store.test.ts`
  (`setUnits`: boxed math e.g. 3 boxes of 6 → qty 18; loose → qty 7; 0 → removed; unknown id → no-op;
  fractional floors).
- `cart.tsx` (qty Text L173-176): replace with an inner `<View row>` containing
  `<QtyTextInput value={units} min={1} emptyMeansZero={false} onChangeQty={(n) => setUnits(item.productId, n)} style={[styles.qtyText, styles.qtyInputReset]} />`
  plus a boxed suffix `<Text>` (" box"/" bx"). Keep the −/+ Pressables + trash-at-1 (removal stays
  on the − path). Add `qtyInputReset: { paddingVertical: 0, paddingHorizontal: 0 }` to styles. Add
  `keyboardShouldPersistTaps="handled"` to the ScrollView. Destructure `setUnits` from the store.
- `catalog.tsx` (qty Text L372-375): same input+suffix swap; `const setUnits = useCartStore((s) => s.setUnits);`;
  keep the Ionicons −/+; add `qtyInputReset`; `keyboardShouldPersistTaps="handled"` on the list.

### WP6 — Opportunistic: customer order edit-items

**File:** `apps/mobile/app/(customer)/orders/[id]/edit-items.tsx`. Replace the bare TextInput
(L157-165, which can't even be cleared mid-edit) with
`<QtyTextInput value={item.qty} onChangeQty={(n) => setQty(item.productId, n)} style={styles.qtyInput} />`
(min 0, emptyMeansZero default → blur-empty removes the line, matching its − at qty 1).

## Acceptance criteria

1. `commitQtyDraft` exists + tested; `QtyStepper.tsx` exports `QtyTextInput` + `QtyStepper`.
2. All four gap surfaces (NewOrderScreen tile + boxed dual, invoices/new list+review+unlisted,
   customer cart, catalog) accept typed quantities with live commit; boxed pieces clamp to
   `unitsPerBox − 1`; +/− still work; keyboard-open taps register.
3. `cartStore.setUnits` sets absolute selling units (boxed math via `boxedFields`), removes at ≤0;
   tested.
4. invoices/new `setUnits` preserves `unitPrice` (built on PR B helpers); price override survives a typed qty change.
5. Removed styles are truly unused (grep); no dangling references. Existing typed screens
   (CartStepperRow/StepperRow/QtyStepperRow/short-pick) left untouched.

## Verify commands (run from repo root)

- `npm run check-types -w apps/mobile`
- `npm run test -w apps/mobile` (qty.test + cart-store.test + sale-line.test)
- `npm run lint -w apps/mobile`

## Manual checklist (post-merge, real device/simulator)

Type quantities on: NewOrderScreen tile + boxed dual (all 3 routes: operator new-order, driver
ad-hoc, driver stop new-order); invoices/new list/review/unlisted; customer cart; catalog. Verify
live total updates, empty/0 behavior (removal vs revert), pieces clamp at `upb−1`, +/− while
keyboard open, price-override survival on invoices/new, dark+light, iOS+Android.
