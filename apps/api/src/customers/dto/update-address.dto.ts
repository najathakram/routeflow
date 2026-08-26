import { IsBoolean, IsIn, IsOptional, IsString } from "class-validator";

export class UpdateAddressDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() line1?: string;
  @IsOptional() @IsString() line2?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() zip?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsIn(["BILLING", "SHIPPING", "DELIVERY"]) addressType?: string;
}
