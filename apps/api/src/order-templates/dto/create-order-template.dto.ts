import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
  Max,
  ValidateNested,
  ArrayMinSize,
} from "class-validator";
import { Type } from "class-transformer";

class OrderTemplateItemDto {
  @IsString() productId: string;
  @IsInt() @Min(1) qty: number;
  @IsOptional() @IsString() notes?: string;
}

export class CreateOrderTemplateDto {
  @IsString() customerId: string;
  @IsString() name: string;
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  daysOfWeek: number[];
  @IsOptional() @IsString() notes?: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderTemplateItemDto)
  @ArrayMinSize(1)
  items: OrderTemplateItemDto[];
}
