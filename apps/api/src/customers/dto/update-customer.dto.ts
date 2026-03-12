import { IsEnum, IsOptional, IsString } from "class-validator";
import { FulfillPath } from "@prisma/client";

export class UpdateCustomerDto {
  @IsOptional() @IsString() businessName?: string;
  @IsOptional() @IsString() contactName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsEnum(FulfillPath) fulfillPath?: FulfillPath;
  @IsOptional() @IsString() deliveryWindowStart?: string;
  @IsOptional() @IsString() deliveryWindowEnd?: string;
}
