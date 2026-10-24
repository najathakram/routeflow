import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

export type ProductCodeField = "sku" | "barcode" | "unitSku";

/**
 * The 400 a product write answers when a sku / barcode / unit code is already used by another active product. The
 * `message` is the historical text (imports and the generic toast map still read it); `code` + `field` are what a
 * client keys on, so no client has to read the text.
 */
export function productCodeInUse(field: ProductCodeField, message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: API_ERROR_CODES.PRODUCT_CODE_IN_USE,
    field,
    message,
    error: "Bad Request",
  });
}
