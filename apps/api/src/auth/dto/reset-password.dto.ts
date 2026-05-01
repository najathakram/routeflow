import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, Matches, MinLength } from "class-validator";

export class ResetPasswordDto {
  @ApiProperty()
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
