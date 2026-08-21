import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

/** Mirrors BuyerResetPasswordDto's token handling — raw token, POSTed in the body. */
export class BuyerVerifyEmailDto {
  @ApiProperty({ description: "Raw verification token from the emailed link" })
  @IsString()
  @IsNotEmpty()
  token: string;
}
