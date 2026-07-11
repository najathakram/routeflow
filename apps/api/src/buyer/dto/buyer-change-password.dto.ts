import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MinLength, Matches } from "class-validator";

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
