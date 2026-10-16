import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";

/** One cell to write (pricing `CellPatch`): `to` = a positive price, or null = Auto. The money rules run in the service. */
export class PriceCellPatchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  ref: string;

  @IsInt()
  @Min(1)
  @Max(5)
  tier: number;

  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  to: number | null;
}

/** A follower's Keep (pricing `Pin`). The server recomputes the value under the lock and refuses a disagreement. */
export class PriceCellKeepDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  ref: string;

  @IsInt()
  @Min(1)
  @Max(5)
  tier: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  value: number;
}

/** One customer cell: `from` null = no row yet (a Keep), `to` null = delete the row (an Undo). */
export class CustomerPriceMoveDto {
  @IsString()
  @IsNotEmpty()
  customerId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  ref: string;

  @IsInt()
  @Min(1)
  @Max(5)
  tier: number;

  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  from: number | null;

  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  to: number | null;
}

/** POST /products/:productId/prices (SavePricesRequest of @routeflow/types). Both CAS fields are required (SA-796 R-1). */
export class SavePricesDto {
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  expectedPriceState: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PriceCellPatchDto)
  patches: PriceCellPatchDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PriceCellKeepDto)
  keeps?: PriceCellKeepDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CustomerPriceMoveDto)
  customerMoves?: CustomerPriceMoveDto[];

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  orderUnit?: string;
}

/** One customer cell an Undo leaves alone; `seen` is the value the 409 preview showed (null = no row). */
export class UndoSkipCellDto {
  @IsString()
  @IsNotEmpty()
  customerId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  ref: string;

  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  seen: number | null;
}

/** POST /products/:productId/prices/undo (UndoPricesRequest). */
export class UndoPricesDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  auditId: string;

  @IsInt()
  @Min(0)
  expectedRevision: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  expectedPriceState: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => UndoSkipCellDto)
  skip?: UndoSkipCellDto[];
}
