import { IsOptional, IsString, Matches } from "class-validator";
import { ListProductsDto } from "./list-products.dto";

const DAY_OR_EMPTY = /^(\d{4}-\d{2}-\d{2})?$/;

/**
 * `GET /products/export.csv` query: every list filter (paging fields are accepted and ignored —
 * the export is never paged) plus the optional stats window. An empty day counts as absent.
 */
export class ExportProductsDto extends ListProductsDto {
  @IsOptional()
  @IsString()
  @Matches(DAY_OR_EMPTY, { message: "from must be a calendar day (YYYY-MM-DD)" })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(DAY_OR_EMPTY, { message: "to must be a calendar day (YYYY-MM-DD)" })
  to?: string;
}
