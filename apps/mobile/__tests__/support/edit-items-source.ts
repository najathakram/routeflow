import { readFileSync } from "fs";
import { join } from "path";

/**
 * #2340 prefactor: the operator edit-items surface is now the route file PLUS the modules it was
 * sliced into (components/edit-items/*). Source pins that asserted wiring anywhere in the old
 * single file read this instead — screen first, then each module in a fixed order, so a pin's
 * ordering checks inside the screen body are unchanged. Not a test file (jest's testMatch is
 * `*.test.ts`).
 */
const MOBILE = join(__dirname, "..", "..");
export const EDIT_ITEMS_SCREEN = join(MOBILE, "app/(operator)/(tabs)/orders/[id]/edit-items.tsx");
export const EDIT_ITEMS_MODULES = [
  "DraftItemCard.tsx",
  "PriceOverrideModal.tsx",
  "UnlistedDraft.tsx",
  "CreateCreditNoteModal.tsx",
  "ProductPicker.tsx",
  "styles.ts",
].map((f) => join(MOBILE, "components/edit-items", f));

export function readEditItemsSurface(): string {
  return [EDIT_ITEMS_SCREEN, ...EDIT_ITEMS_MODULES].map((p) => readFileSync(p, "utf8")).join("\n");
}
