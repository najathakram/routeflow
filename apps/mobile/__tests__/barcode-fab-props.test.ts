/**
 * B246 — `BarcodeFab`'s two handler props are mutually exclusive and jointly
 * required.
 *
 * The Option-C fix added `onPress` so the order-edit screen can route the tap
 * into its own scan surface. With both handlers optional, `<BarcodeFab />`
 * also typechecked: a 56px brand-coloured button labelled "Scan barcode"
 * whose tap does nothing — the same inert-FAB defect B246 is about, just
 * moved into the shared component's type. The union in `BarcodeFab.tsx` pins
 * the guarantee; this file proves it in both directions.
 *
 * This is a TYPE-level test: the four declarations below are checked by
 * `npx tsc --noEmit -p tsconfig.json` (apps/mobile's tsconfig has no
 * `include`, so `__tests__/` is covered). An unused `@ts-expect-error` is
 * itself a tsc error, so the two rejected shapes must really fail and the two
 * accepted shapes must really pass. ts-jest runs with `diagnostics: false`,
 * so the runtime `it` below only keeps the Jest suite green.
 */
import type { ComponentProps } from "react";
import type { BarcodeFab } from "../components/BarcodeFab";
import type { ScanOutcome } from "../lib/scan-loop";

type FabProps = ComponentProps<typeof BarcodeFab>;

const handleScanned = (_code: string): ScanOutcome => ({ close: true });
const handlePress = (): void => {};

// @ts-expect-error — neither handler: the FAB would render as an inert button.
const neitherHandler: FabProps = { hidden: false };

// @ts-expect-error — both handlers: `onPress` wins, so `onScanned` would be dead.
const bothHandlers: FabProps = { onScanned: handleScanned, onPress: handlePress };

const scannedOnly: FabProps = { onScanned: handleScanned, continuous: true };

const pressOnly: FabProps = { onPress: handlePress, hidden: false };

describe("BarcodeFab props (B246)", () => {
  it("BarcodeFab props are mutually exclusive and jointly required (type-level)", () => {
    expect([neitherHandler, bothHandlers, scannedOnly, pressOnly]).toHaveLength(4);
  });
});
