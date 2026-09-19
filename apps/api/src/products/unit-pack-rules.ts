import { ConflictException } from "@nestjs/common";

/**
 * Editing a product's PACK (`unit`, `unitsPerBox`, regulated section) must never invalidate the
 * `ProductUnit` levels already defined on it — the ladder resolves a label to the pack FIRST, so
 * a pack renamed onto a level's label (or resized onto a level's factor) would silently re-price
 * every new line at the wrong size. Mirrors the checks `ProductUnitsService.assertLevelValid`
 * makes when a level is created, applied from the other direction. Pure; throws 409.
 */
export function assertPackKeepsLevelsValid(
  levels: ReadonlyArray<{ label: string; factorToBase: number }>,
  pack: { unit?: string | null; unitsPerBox?: number | null; regulated: boolean },
): void {
  if (levels.length === 0) return;
  const upb = Math.trunc(Number(pack.unitsPerBox ?? 0));
  const factor = upb > 1 ? upb : 1;
  const label = (pack.unit ?? "").trim().toLowerCase() || "box";
  const clash = levels.find((l) => l.label.trim().toLowerCase() === label);
  if (clash) {
    throw new ConflictException(
      `This product has a "${clash.label}" unit — the pack can't be named the same. Remove or rename that unit first.`,
    );
  }
  const sameSize = levels.find((l) => l.factorToBase === factor);
  if (sameSize) {
    throw new ConflictException(
      `This product has a "${sameSize.label}" unit of ${factor} pieces — the pack can't be that size. Remove that unit first.`,
    );
  }
  const above = pack.regulated ? levels.find((l) => l.factorToBase > factor) : undefined;
  if (above) {
    throw new ConflictException(
      `This product has a "${above.label}" unit above its pack size — a regulated product can't be sold above its pack. Remove that unit first.`,
    );
  }
}
