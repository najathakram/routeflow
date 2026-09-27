import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MinLength, Matches } from "class-validator";
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_DESCRIPTION,
  PASSWORD_POLICY_PATTERN,
  passwordPolicyMessage,
} from "../../common/password-policy";

/** Mirrors the staff ResetPasswordDto (auth/dto/reset-password.dto.ts). */
export class BuyerResetPasswordDto {
  @ApiProperty({ description: "Raw reset token from the emailed link" })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({
    minLength: 8,
    description: PASSWORD_POLICY_DESCRIPTION,
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @Matches(PASSWORD_POLICY_PATTERN, { message: passwordPolicyMessage("newPassword") })
  newPassword: string;
}
