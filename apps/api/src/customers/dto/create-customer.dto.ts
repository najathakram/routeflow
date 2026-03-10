import { IsEmail, IsEnum, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { FulfillPath } from '@prisma/client';

export class CreateAddressDto {
  @IsString() label: string;
  @IsString() line1: string;
  @IsOptional() @IsString() line2?: string;
  @IsString() city: string;
  @IsString() state: string;
  @IsString() zip: string;
  @IsOptional() isDefault?: boolean;
}

export class CreateCustomerDto {
  @IsEmail() email: string;
  @IsString() @MinLength(3) username: string;
  @IsString() businessName: string;
  @IsString() contactName: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsEnum(FulfillPath) fulfillPath?: FulfillPath;
  @IsOptional() @ValidateNested({ each: true }) @Type(() => CreateAddressDto) addresses?: CreateAddressDto[];
}
