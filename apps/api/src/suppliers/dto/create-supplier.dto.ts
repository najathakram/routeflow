import { IsBoolean, IsInt, IsOptional, IsString } from "class-validator";

export class CreateSupplierDto {
  @IsString() name: string;
  @IsOptional() @IsString() contactName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() leadTimeDays?: number;
}
