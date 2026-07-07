import { IsOptional, IsString } from "class-validator";

export class ListFilingsDto {
  @IsOptional()
  @IsString()
  category?: string;
}
