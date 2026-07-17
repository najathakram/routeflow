import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString } from "class-validator";

/**
 * DELETE /products/bulk body. F9-009: the endpoint bound an inline
 * `{ ids: string[] }` with no validation, so a caller could post an unbounded
 * (or non-string) array and drive a huge cascading multi-table delete. Cap the
 * batch size and enforce the element type at the HTTP boundary.
 */
export class BulkDeleteProductsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  ids: string[];
}
