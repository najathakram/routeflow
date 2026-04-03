import { IsEmail, IsEnum, IsOptional, IsString } from "class-validator";
import { UserRole } from "@prisma/client";

export class UpdateUserDto {
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsEnum(UserRole) role?: UserRole;
}
