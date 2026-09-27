import { ApiProperty } from "@nestjs/swagger";
import { IsString, MinLength, Matches } from "class-validator";
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_DESCRIPTION,
  PASSWORD_POLICY_PATTERN,
  passwordPolicyMessage,
} from "../../common/password-policy";

/**
 * Mirrors the staff SetPasswordDto (auth/dto/set-password.dto.ts): first-password
 * setup for Google-auto-created buyer accounts (passwordSet=false). Deliberately
 * has NO currentPassword field — the server only accepts it when the account's
 * passwordSet flag is false, verified against the database at call time.
 */
export class BuyerSetPasswordDto {
  @ApiProperty({
    minLength: 8,
    description: PASSWORD_POLICY_DESCRIPTION,
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @Matches(PASSWORD_POLICY_PATTERN, { message: passwordPolicyMessage("newPassword") })
  newPassword: string;
}
