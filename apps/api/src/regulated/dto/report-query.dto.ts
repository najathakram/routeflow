import { IsOptional, IsString, IsNotEmpty, Matches, MaxLength } from "class-validator";

export class ReportQueryDto {
  @IsString()
  @IsNotEmpty()
  category!: string;

  /** Inclusive start date. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "from must be YYYY-MM-DD" })
  from!: string;

  /** Inclusive end date — the server queries soldAt < to + 1 day. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "to must be YYYY-MM-DD" })
  to!: string;

  /** Defaults to the category's configured reportTemplate. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  template?: string;

  /**
   * Comma-separated column keys; order defines output order. Absent ⇒ the
   * template's default layout (byte-identical to the pre-custom-format output).
   * Keys are validated against the template's registry superset in the service.
   */
  @IsOptional()
  @Matches(/^[A-Za-z][A-Za-z0-9]*(,[A-Za-z][A-Za-z0-9]*)*$/, {
    message: "columns must be a comma-separated list of column keys",
  })
  @MaxLength(400)
  columns?: string;
}
