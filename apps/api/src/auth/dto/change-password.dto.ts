import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MinLength, Matches } from "class-validator";
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_DESCRIPTION,
  PASSWORD_POLICY_PATTERN,
  passwordPolicyMessage,
} from "../../common/password-policy";

export class ChangePasswordDto {
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
