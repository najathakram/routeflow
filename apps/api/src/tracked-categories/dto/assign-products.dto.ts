import { ArrayNotEmpty, IsArray, IsString } from "class-validator";

export class AssignProductsDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) productIds: string[];
}
