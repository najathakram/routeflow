/**
 * Row 507: the DTO-layer form of the write-side formula guard (`safe-text-cell.ts`). A string value that a
 * spreadsheet would run as a formula (a leading `= + - @ TAB CR LF`, minus numeric-only text) is refused with
 * EXACTLY the body `assertSafeTextCell` throws (400, code TEXT_CELL_FORMULA_LEAD, `field` = the property
 * name, readable message), because it throws that same exception from the transform step of the global
 * ValidationPipe.
 *
 * Not change-only (a DTO has no stored value): use it ONLY on a create body, where every value is new. An
 * edit path that must let an echoed legacy value through calls `assertSafeTextCell(next, stored)` in its
 * service instead. class-transformer applies a property's @Transform decorators top first, so list it BELOW
 * `@StripHtml()` / `@Trim()` to see the cleaned value.
 */
import { Transform } from "class-transformer";
import { assertSafeTextCell } from "../safe-text-cell";

export function SafeTextCell() {
  return Transform(
    ({ key, value }) => {
      if (typeof value === "string") assertSafeTextCell({ [key]: value });
      return value;
    },
    { toClassOnly: true },
  );
}
