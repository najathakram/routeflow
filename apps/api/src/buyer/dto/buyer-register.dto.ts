import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MinLength } from "class-validator";
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_DESCRIPTION,
  PASSWORD_POLICY_PATTERN,
  passwordPolicyMessage,
} from "../../common/password-policy";

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
  @MinLength(PASSWORD_MIN_LENGTH)
  @Matches(PASSWORD_POLICY_PATTERN, { message: passwordPolicyMessage("password") })
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
