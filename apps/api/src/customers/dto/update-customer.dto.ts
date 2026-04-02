import { IsBoolean, IsEnum, IsOptional, IsString } from "class-validator";
import { FulfillPath } from "@prisma/client";

export class UpdateCustomerDto {
  @IsOptional() @IsString() businessName?: string;
  @IsOptional() @IsString() contactName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsEnum(FulfillPath) fulfillPath?: FulfillPath;
  @IsOptional() @IsString() deliveryWindowStart?: string;
  @IsOptional() @IsString() deliveryWindowEnd?: string;
  @IsOptional() @IsString() email?: string;
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
