/**
 * SA-1506 (A4/A5): the reserved note of an office correction row and the ONE predicate that reads it.
 * A correction row is written by the office (`driverId` is NULL) with this note; a driver's row never is one, even if a
 * driver typed the same words. The test is strict (`=== null`): a row whose `driverId` was not selected (undefined) is
 * NOT a correction, so a reader that forgot to select the column counts nothing instead of everything (R-241 M-2).
 * Its where-twin and the writer arrive with the route-basis writer (PR-1c); nothing else may test this note.
 */
export const OFFICE_CORRECTION = "OFFICE_CORRECTION";

export function isCorrectionRow(row: { note?: string | null; driverId?: string | null }): boolean {
  return row.note === OFFICE_CORRECTION && row.driverId === null;
}
