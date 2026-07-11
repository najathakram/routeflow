import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsNotEmpty } from "class-validator";

/** Mirrors the staff RequestPasswordResetDto (auth/dto/request-password-reset.dto.ts). */
export class BuyerRequestPasswordResetDto {
  @ApiProperty({ example: "buyer@example.com" })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}
