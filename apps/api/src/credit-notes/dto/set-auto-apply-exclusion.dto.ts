import { IsBoolean } from "class-validator";

/** SA-436 (#2401): keep a credit note out of (or back in) the send-time oldest-first sweep. */
export class SetAutoApplyExclusionDto {
  @IsBoolean() excluded!: boolean;
}
