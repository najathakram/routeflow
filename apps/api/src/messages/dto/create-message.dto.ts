import { IsString, IsOptional, IsNotEmpty, MaxLength } from "class-validator";

export class CreateMessageDto {
  @IsOptional()
  @IsString()
  runId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text: string;
}
