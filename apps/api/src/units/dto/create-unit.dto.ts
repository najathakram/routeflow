import { IsString, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";

export const UNIT_NAME_EMPTY = "Enter a name.";
export const UNIT_NAME_TOO_LONG = "Keep it to 30 characters or fewer.";
export const UNIT_NAME_IS_PIECE = "Piece is always there as the smallest unit.";

export class CreateUnitDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString({ message: UNIT_NAME_EMPTY })
  @MinLength(1, { message: UNIT_NAME_EMPTY })
  @MaxLength(30, { message: UNIT_NAME_TOO_LONG })
  name: string;
}
