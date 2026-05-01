import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { StripHtml } from "../../common/transforms/strip-html.transform";

class UpdateOrderItemDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsIn(["CANCEL", "UPDATE"])
  action?: "CANCEL" | "UPDATE";

  @IsOptional()
  @IsNumber()
  @Min(1)
  qty?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @IsString()
  substituteProductId?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  itemNote?: string;

  @IsOptional()
  @IsString()
  substitution?: string;

  @IsOptional()
  @IsString()
  overrideReason?: string;
}

export class UpdateOrderItemsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateOrderItemDto)
  items: UpdateOrderItemDto[];

  // RF-110: strip HTML to prevent stored XSS via order notes
  @IsOptional()
  @StripHtml()
  @IsString()
  orderNotes?: string;
}
