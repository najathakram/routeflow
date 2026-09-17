import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class ExplainFeatureDiffDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  explanation!: string;
}
