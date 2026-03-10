import { IsEnum, IsNumberString, IsOptional, IsString } from 'class-validator';
import { UserStatus } from '@prisma/client';

export class ListCustomersDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @IsNumberString() page?: string;
  @IsOptional() @IsNumberString() limit?: string;
}
