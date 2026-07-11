import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MinLength, Matches } from "class-validator";

/** Mirrors the staff ResetPasswordDto (auth/dto/reset-password.dto.ts). */
export class BuyerResetPasswordDto {
  @ApiProperty({ description: "Raw reset token from the emailed link" })
  @IsString()
  @IsNotEmpty()
  token: string;

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
