/**
 * #2698 (parity with #2696(d), the owner's one-unit-sold rule): a Case line sells ONE unit level.
 * The loose-units stepper is opt-in behind a small "+ units" control — shown only once tapped, or
 * when the line already carries loose pieces (editing a boxes + pieces line), so nothing is ever
 * hidden with a value in it.
 */
export function looseUnitsVisible(open: boolean, pieces: number | null | undefined): boolean {
  return open || Number(pieces ?? 0) > 0;
}
