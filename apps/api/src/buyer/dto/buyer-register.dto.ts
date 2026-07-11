import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MinLength } from "class-validator";

export class BuyerRegisterDto {
  @ApiProperty({ example: "Jane Smith" })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: "jane@example.com" })
  @IsEmail()
  email: string;

  // Same complexity policy as staff passwords (auth/dto/change-password.dto.ts).
  @ApiProperty({ example: "SecurePass1!", minLength: 8 })
  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d\W])/, {
    message:
      "password must contain at least one uppercase letter, one lowercase letter, and one number or special character",
  })
  password: string;

  @ApiPropertyOptional({ example: "+1-555-0100" })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ example: "+1-555-0101" })
  @IsString()
  @IsOptional()
  mobile?: string;
}
