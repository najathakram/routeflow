import {
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

class BulkAssignParentItemDto {
  @IsUUID() id: string;
  @IsString() @MaxLength(200) variantName: string;
}

/**
 * Promote existing standalone products to variants of `parentProductId` in one
 * request ("Group as variants of…"). Each assignment carries the flavor name the
 * product should keep as a variant.
 */
export class BulkAssignParentDto {
  @IsUUID() parentProductId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BulkAssignParentItemDto)
  assignments: BulkAssignParentItemDto[];
}
