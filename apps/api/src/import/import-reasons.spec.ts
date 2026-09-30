/**
 * WS7 I6 (SA-603a): the importer turns a code-collision 409 into a reason from a CLOSED map, never
 * the 409's own message (which names the holder product: another record's name must not leak into
 * an import report). RED until `./import-reasons` exists.
 *
 * Real throw shapes (product-code-release.ts `taken()` / product-catalog-sync.ts): a barcode
 * collision is `BARCODE_TAKEN`; sku / unitSku collisions are `CODE_TAKEN` carrying `field`. The
 * literal `SKU_TAKEN` / `UNIT_SKU_TAKEN` codes are accepted too, so a later split of CODE_TAKEN
 * needs no importer change.
 */
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { IMPORT_CODE_TAKEN_REASON, importReasonForError } from "./import-reasons";

const HOLDER_MESSAGE = 'SKU "X-1" is already used by Holder Product Name.';
const SKU_REASON = "SKU is already used by an active item";
const BARCODE_REASON = "Barcode is already used by an active item";
const UNIT_REASON = "Unit code is already used by an active item";

const conflict = (code: string, field?: string) =>
  new ConflictException({ code, message: HOLDER_MESSAGE, ...(field ? { field } : {}) });

describe("WS7 import-reasons: closed code -> sentence map", () => {
  it("the map is a closed set of exactly the three sentences", () => {
    expect(Object.values(IMPORT_CODE_TAKEN_REASON).sort()).toEqual(
      [BARCODE_REASON, SKU_REASON, UNIT_REASON].sort(),
    );
    expect(Object.isFrozen(IMPORT_CODE_TAKEN_REASON)).toBe(true);
  });

  it.each([
    ["CODE_TAKEN / sku", conflict(API_ERROR_CODES.CODE_TAKEN, "sku"), SKU_REASON],
    ["CODE_TAKEN / unitSku", conflict(API_ERROR_CODES.CODE_TAKEN, "unitSku"), UNIT_REASON],
    ["BARCODE_TAKEN", conflict(API_ERROR_CODES.BARCODE_TAKEN, "barcode"), BARCODE_REASON],
    ["BARCODE_TAKEN without field", conflict(API_ERROR_CODES.BARCODE_TAKEN), BARCODE_REASON],
    ["literal SKU_TAKEN", conflict("SKU_TAKEN"), SKU_REASON],
    ["literal UNIT_SKU_TAKEN", conflict("UNIT_SKU_TAKEN"), UNIT_REASON],
  ])("%s -> its mapped sentence", (_label, e, expected) => {
    expect(importReasonForError(e)).toBe(expected);
  });

  it("never passes the 409 message (holder name) through", () => {
    for (const e of [
      conflict(API_ERROR_CODES.CODE_TAKEN, "sku"),
      conflict(API_ERROR_CODES.CODE_TAKEN, "unitSku"),
      conflict(API_ERROR_CODES.BARCODE_TAKEN, "barcode"),
    ]) {
      const reason = importReasonForError(e);
      expect(reason).not.toContain("Holder Product Name");
      expect(reason).not.toContain("X-1");
    }
  });

  it("a CODE_TAKEN whose field is unknown is NOT passed through: generic wording", () => {
    const reason = importReasonForError(conflict(API_ERROR_CODES.CODE_TAKEN, "surprise"));
    expect(reason).not.toContain("Holder Product Name");
    expect(reason).toBe("import failed");
  });

  it("any other error keeps the existing generic failPlan wording", () => {
    // A non-Http error (a raw P2002 / TypeError) is never echoed.
    expect(importReasonForError(new Error("Unique constraint failed on (tenantId, sku)"))).toBe(
      "import failed",
    );
    expect(importReasonForError("boom")).toBe("import failed");
    expect(importReasonForError(undefined)).toBe("import failed");
    // Another HttpException keeps its own message, as failPlan did before.
    expect(importReasonForError(new BadRequestException("Rate is required"))).toBe(
      "Rate is required",
    );
    expect(importReasonForError(new NotFoundException("Product not found"))).toBe(
      "Product not found",
    );
    // A 409 that is not a code collision (e.g. NAME_TAKEN) is not in the closed map.
    expect(importReasonForError(conflict(API_ERROR_CODES.NAME_TAKEN))).not.toMatch(
      /already used by an active item/,
    );
  });
});
