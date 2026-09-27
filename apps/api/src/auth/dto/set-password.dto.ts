import { ApiProperty } from "@nestjs/swagger";
import { IsString, MinLength, Matches } from "class-validator";
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_DESCRIPTION,
  PASSWORD_POLICY_PATTERN,
  passwordPolicyMessage,
} from "../../common/password-policy";

/**
 * First-password setup for accounts that have none (Google-only sign-ins).
 * Deliberately has NO currentPassword field — the server only accepts it when
 * the account's password is NULL, verified against the database at call time.
 */
export class SetPasswordDto {
  @ApiProperty({
    minLength: 8,
    description: PASSWORD_POLICY_DESCRIPTION,
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @Matches(PASSWORD_POLICY_PATTERN, { message: passwordPolicyMessage("newPassword") })
  newPassword: string;
}
