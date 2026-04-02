import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MinLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { FulfillPath } from "@prisma/client";
import { CreateAddressDto } from "./create-address.dto";

export class CreateCustomerDto {
  @IsEmail() email: string;
  @IsString() @MinLength(3) username: string;
  @IsString() businessName: string;
  @IsString() contactName: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsEnum(FulfillPath) fulfillPath?: FulfillPath;
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateAddressDto)
  addresses?: CreateAddressDto[];
  @IsOptional() @IsString() mobile?: string;
  @IsOptional() @IsString() customerType?: string;
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsString() salutation?: string;
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsString() taxId?: string;
  @IsOptional() @IsBoolean() isTaxExempt?: boolean;
  @IsOptional() creditLimit?: number;
  @IsOptional() @IsString() currency?: string;
}
