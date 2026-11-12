import { IsString, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";
import { StripHtml } from "../../common/transforms/strip-html.transform";
import { RESOLUTION_MAX, RESOLUTION_MIN } from "../offline/review-flags";

/** SA-1124: `POST /orders/:id/review-flags/:flagId/resolve`. The note is trimmed, 3 to 500 characters (the table's CHECK). */
export class ResolveReviewFlagDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @StripHtml()
  @IsString()
  @MinLength(RESOLUTION_MIN)
  @MaxLength(RESOLUTION_MAX)
  resolution: string;
}
