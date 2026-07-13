import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { ChangeRequestType } from "@prisma/client";

export class CreateChangeRequestDto {
  @IsEnum(ChangeRequestType)
  type!: ChangeRequestType;

  /** CHANGE_QTY / REMOVE_ITEM: the target order line. */
  @IsOptional()
  @IsString()
  orderItemId?: string;

  /** ADD_ITEM: the catalog product to add. */
  @IsOptional()
  @IsString()
  productId?: string;

  /** ADD_ITEM: qty to add. CHANGE_QTY: the NEW absolute qty (not a delta). */
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  @Max(1_000_000)
  qty?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  boxes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  pieces?: number;

  /** Requester note; NOTE-type requests require it. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
