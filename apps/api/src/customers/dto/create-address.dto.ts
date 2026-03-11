import { IsBoolean, IsOptional, IsString } from "class-validator";

export class CreateAddressDto {
  @IsString() label: string;
  @IsString() line1: string;
  @IsOptional() @IsString() line2?: string;
  @IsString() city: string;
  @IsString() state: string;
  @IsString() zip: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}
