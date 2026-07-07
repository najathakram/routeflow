import { IsOptional, IsString } from "class-validator";

export class RejectAuthorizationDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
