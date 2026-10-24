import { BadRequestException } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { productCodeInUse } from "./product-code-in-use";

describe("productCodeInUse (a code already used by another active product)", () => {
  it.each([
    ["sku", "SKU already exists"],
    ["barcode", "Barcode already exists"],
    ["unitSku", "Unit code already used by another product's SKU, barcode, or unit code"],
  ] as const)(
    "%s: a 400 carrying the registry code, the field and the historical text",
    (field, message) => {
      const err = productCodeInUse(field, message);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toEqual({
        statusCode: 400,
        code: API_ERROR_CODES.PRODUCT_CODE_IN_USE,
        field,
        message,
        error: "Bad Request",
      });
      // imports and the generic toast map still read the text
      expect(err.message).toBe(message);
    },
  );

  it("the three clash checks in products.service throw it (no plain-text throw is left for them)", () => {
    const src = readFileSync(join(__dirname, "products.service.ts"), "utf8");
    expect(src).toMatch(/productCodeInUse\(\s*"sku"/);
    expect(src).toMatch(/productCodeInUse\(\s*"barcode"/);
    expect(src).toMatch(/productCodeInUse\(\s*"unitSku"/);
    expect(src).not.toMatch(/new BadRequestException\(\s*["'`](SKU|Barcode) already exists/);
    expect(src).not.toMatch(/new BadRequestException\(\s*["'`]Unit code already used/);
  });
});
