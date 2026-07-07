import { IsOptional, IsString, MaxLength } from "class-validator";

/** Body for `POST /import/batch`. */
export class CreateBatchDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  kind?: string;
}
