/**
 * #2698 (parity with #2696(d), the owner's one-unit-sold rule): a Case line sells ONE unit level.
 * The loose-units stepper is opt-in behind a small "+ units" control — shown only once tapped, or
 * when the line already carries loose pieces (editing a boxes + pieces line), so nothing is ever
 * hidden with a value in it.
 */
export function looseUnitsVisible(open: boolean, pieces: number | null | undefined): boolean {
  return open || Number(pieces ?? 0) > 0;
}

/**
 * SA-563 (identical to web #2699(d)): "Remove extra units" exists only when the line has at least
 * one case. With 0 cases the loose units ARE the line — the control is hidden (not disabled, no
 * invented case, no dialog), so remove-line stays the only way to remove a line.
 */
export function canRemoveLooseUnits(boxes: number | null | undefined): boolean {
  return Number(boxes ?? 0) >= 1;
}
