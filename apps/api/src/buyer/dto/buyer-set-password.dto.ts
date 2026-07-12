import { ApiProperty } from "@nestjs/swagger";
import { IsString, MinLength, Matches } from "class-validator";

/**
 * Mirrors the staff SetPasswordDto (auth/dto/set-password.dto.ts): first-password
 * setup for Google-auto-created buyer accounts (passwordSet=false). Deliberately
 * has NO currentPassword field — the server only accepts it when the account's
 * passwordSet flag is false, verified against the database at call time.
 */
export class BuyerSetPasswordDto {
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
