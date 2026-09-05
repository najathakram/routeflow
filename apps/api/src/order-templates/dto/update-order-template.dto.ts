import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { OrderTemplateItemDto } from "./create-order-template.dto";

export class UpdateOrderTemplateDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  daysOfWeek?: number[];
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() notes?: string;
  /** REG-B09: when present, REPLACES the template's items with this full list (≥ 1). */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderTemplateItemDto)
  items?: OrderTemplateItemDto[];
}
