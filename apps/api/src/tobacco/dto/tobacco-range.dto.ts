import { IsDateString, IsOptional } from "class-validator";

export class TobaccoRangeDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
