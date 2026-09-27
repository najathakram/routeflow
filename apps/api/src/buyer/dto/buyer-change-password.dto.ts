import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MinLength, Matches } from "class-validator";
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_DESCRIPTION,
  PASSWORD_POLICY_PATTERN,
  passwordPolicyMessage,
} from "../../common/password-policy";

/**
 * Mirrors the staff ChangePasswordDto policy (auth/dto/change-password.dto.ts).
 * A concrete DTO type is required for the global ValidationPipe to run at all —
 * the previous inline `{ currentPassword; newPassword }` body type skipped
 * validation entirely.
 */
export class BuyerChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({
    minLength: 8,
    description: PASSWORD_POLICY_DESCRIPTION,
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @Matches(PASSWORD_POLICY_PATTERN, { message: passwordPolicyMessage("newPassword") })
  newPassword: string;
}
