import { ApiProperty } from "@nestjs/swagger";
import { IsHexadecimal, IsNotEmpty, IsString, Length } from "class-validator";

/** Mirrors BuyerResetPasswordDto's token handling — raw token, POSTed in the body. */
export class BuyerVerifyEmailDto {
  @ApiProperty({ description: "Raw verification token from the emailed link" })
  @IsString()
  @IsNotEmpty()
  // randomBytes(32).toString("hex"): exactly 64 hex chars
  @Length(64, 64)
  @IsHexadecimal()
  token: string;
}
