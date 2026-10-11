import { IsString, MaxLength, MinLength } from "class-validator";
import { StripHtml } from "../../common/transforms/strip-html.transform";

/** B297 PR5: the reason a tenant admin gives for locking a filed period; audited, required. */
export class LockFilingDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  @StripHtml()
  reason!: string;
}
