import { IsInt, IsOptional, IsString, Min } from "class-validator";

export class AddTemplateItemDto {
  @IsString() productId: string;
  @IsInt() @Min(1) qty: number;
  @IsOptional() @IsString() notes?: string;
}
