/**
 * WS7 (SA-603a): importer-facing reasons for a product code collision. The 409 thrown by
 * product-code-release / product-catalog-sync names the holder product; an import report must
 * never echo that, so the reason comes from this CLOSED map keyed by the error code (+ field).
 */
import { HttpException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

export const IMPORT_CODE_TAKEN_REASON: Readonly<Record<"sku" | "barcode" | "unitSku", string>> =
  Object.freeze({
    sku: "SKU is already used by an active item",
    barcode: "Barcode is already used by an active item",
    unitSku: "Unit code is already used by an active item",
  });

const GENERIC_REASON = "import failed";

export function importReasonForError(e: unknown): string {
  if (!(e instanceof HttpException)) return GENERIC_REASON;
  const res = e.getResponse();
  const body = typeof res === "object" && res !== null ? (res as Record<string, unknown>) : {};
  const code = body.code;
  const field = body.field;
  if (code === API_ERROR_CODES.BARCODE_TAKEN) return IMPORT_CODE_TAKEN_REASON.barcode;
  if (code === API_ERROR_CODES.CODE_TAKEN) {
    if (field === "sku") return IMPORT_CODE_TAKEN_REASON.sku;
    if (field === "unitSku") return IMPORT_CODE_TAKEN_REASON.unitSku;
    return GENERIC_REASON;
  }
  return e.message;
}
