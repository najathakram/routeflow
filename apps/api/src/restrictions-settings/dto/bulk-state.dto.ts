import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsString, MaxLength } from "class-validator";
import type { UnknownStateBucketName } from "@routeflow/types";
import { BULK_STATE_MAX, UNKNOWN_STATE_BUCKETS } from "../unknown-state";

/** Most address ids one undo names: a bulk write touches at most a few addresses per customer. */
export const BULK_STATE_UNDO_MAX_ADDRESSES = 1000;

/** POST /settings/restrictions/unknown-state-customers/bulk-state (wire shape `BulkStateRequest`). */
export class BulkStateDto {
  @IsIn(UNKNOWN_STATE_BUCKETS, {
    message: `bucket must be one of ${UNKNOWN_STATE_BUCKETS.join(", ")}.`,
  })
  bucket: UnknownStateBucketName;

  @IsArray()
  @ArrayMinSize(1, { message: "Choose at least one customer." })
  @ArrayMaxSize(BULK_STATE_MAX, {
    message: `Set a state for at most ${BULK_STATE_MAX} customers at once.`,
  })
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  customerIds: string[];

  /** A USPS code or full state name; stored as the 2-letter code (400 when it is not one). */
  @IsString() @MaxLength(40) state: string;
}

/** POST .../bulk-state/undo (wire shape `BulkStateUndoRequest`). */
export class BulkStateUndoDto {
  @IsArray()
  @ArrayMinSize(1, { message: "Name at least one address to restore." })
  @ArrayMaxSize(BULK_STATE_UNDO_MAX_ADDRESSES)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  changedAddressIds: string[];
}
