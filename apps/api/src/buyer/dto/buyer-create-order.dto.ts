import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

class BuyerOrderItemDto {
  @IsString() productId: string;
  @IsNumber() @Min(1) qty: number;
  @IsOptional() @IsString() notes?: string;
}

export class BuyerCreateOrderDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BuyerOrderItemDto)
  items: BuyerOrderItemDto[];

  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() urgent?: boolean;
  @IsOptional() @IsDateString() requestedDeliveryDate?: string;
  @IsOptional() @IsEnum(["DRAFT", "PENDING"]) status?: "DRAFT" | "PENDING";
}
