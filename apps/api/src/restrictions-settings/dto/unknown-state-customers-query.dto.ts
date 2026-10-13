import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import type { UnknownStateBucketName } from "@routeflow/types";
import { UNKNOWN_STATE_BUCKETS, UNKNOWN_STATE_PAGE_MAX_API } from "../unknown-state";

/** GET /settings/restrictions/unknown-state-customers (wire shape `UnknownStateCustomersQuery`). */
export class UnknownStateCustomersQueryDto {
  @IsOptional()
  @IsIn(UNKNOWN_STATE_BUCKETS, {
    message: `bucket must be one of ${UNKNOWN_STATE_BUCKETS.join(", ")}.`,
  })
  bucket?: UnknownStateBucketName;

  @IsOptional() @IsString() @MaxLength(1024) cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "limit must be a whole number." })
  @Min(1)
  @Max(UNKNOWN_STATE_PAGE_MAX_API)
  limit?: number;
}
