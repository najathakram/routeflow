import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

/** Edit a MessageTemplate (P6-6). Body edits re-parse `{{vars}}` server-side —
 * variables[] is never accepted directly. `waTemplateName: ""` clears it. */
export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  waTemplateName?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
