import { IsOptional, IsString } from "class-validator";

export class ListMessagesDto {
  @IsOptional()
  @IsString()
  runId?: string;
}
