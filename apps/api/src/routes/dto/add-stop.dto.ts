import { IsInt, IsOptional, IsString, Min } from "class-validator";
import { Type } from "class-transformer";

export class AddStopDto {
  @IsString() customerId: string;
  @IsOptional() @IsString() customerAddressId?: string;
  @IsInt() @Min(1) @Type(() => Number) stopNumber: number;
  @IsOptional() @IsString() notes?: string;
}
