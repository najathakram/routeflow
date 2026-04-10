import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString } from "class-validator";
import { InviteMethod } from "@prisma/client";

export class PortalInviteDto {
  @ApiProperty({ enum: InviteMethod, example: InviteMethod.EMAIL })
  @IsEnum(InviteMethod)
  method: InviteMethod;

  @ApiPropertyOptional({ description: "Override email address (defaults to customer email)" })
  @IsString()
  @IsOptional()
  overrideEmail?: string;
}
