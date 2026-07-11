import { ApiProperty } from "@nestjs/swagger";
import { IsString, MinLength, Matches } from "class-validator";

/**
 * First-password setup for accounts that have none (Google-only sign-ins).
 * Deliberately has NO currentPassword field — the server only accepts it when
 * the account's password is NULL, verified against the database at call time.
 */
export class SetPasswordDto {
  @ApiProperty({
    minLength: 8,
    description: "Min 8 chars, must contain uppercase, lowercase, and number or special character",
  })
  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d\W])/, {
    message:
      "newPassword must contain at least one uppercase letter, one lowercase letter, and one number or special character",
  })
  newPassword: string;
}
