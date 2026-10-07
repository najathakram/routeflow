import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { StripHtml } from "../../common/transforms/strip-html.transform";

/** Most orders one batch ship / packing-slip request may carry (packages/types BATCH_SHIP_MAX_ORDERS). */
export const BATCH_SHIP_MAX = 50;

export class BatchShipOrderDto {
  @IsString() @MaxLength(64) orderId: string;
  @IsOptional() @IsString() @MaxLength(64) @StripHtml() carrier?: string;
  @IsOptional() @IsString() @MaxLength(128) @StripHtml() trackingNumber?: string;
}

export class BatchShipDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_SHIP_MAX)
  @ValidateNested({ each: true })
  @Type(() => BatchShipOrderDto)
  orders: BatchShipOrderDto[];
}

export class PackingSlipsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_SHIP_MAX)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  orderIds: string[];
}
