import { IsObject, IsOptional, IsString, MaxLength } from "class-validator";

/** Render a template body against sample vars without persisting (P6-6 editor). */
export class PreviewTemplateDto {
  @IsString()
  @MaxLength(2000)
  body!: string;

  @IsOptional()
  @IsObject()
  vars?: Record<string, string | number>;
}
