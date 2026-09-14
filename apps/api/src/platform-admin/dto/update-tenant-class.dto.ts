import { IsEnum, IsString, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { TenantClass } from "@prisma/client";

export class UpdateTenantClassDto {
  @ApiProperty({ enum: TenantClass })
  @IsEnum(TenantClass)
  class: TenantClass;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  reason: string;
}
