import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsIn, IsNotEmpty, IsOptional } from "class-validator";

export class RequestPasswordResetDto {
  @ApiProperty({ example: "user@example.com" })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  /**
   * Which client surface requested the reset — picks the base URL of the link
   * in the email (server-side mapping only; never a client-supplied URL).
   * Defaults to "mobile" to preserve the pre-existing behavior.
   */
  @ApiPropertyOptional({ enum: ["web", "mobile"], default: "mobile" })
  @IsOptional()
  @IsIn(["web", "mobile"])
  surface?: "web" | "mobile";
}
