import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

/** B461 (SA-1116): the raw token from the confirm link mailed to the new address (64 hex characters). */
export class ConfirmEmailChangeDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  token: string;
}
