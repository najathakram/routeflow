import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsUUID,
  Validate,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

/**
 * Equal copy of `LINE_ORDER_MAX_IDS` in packages/types/api/line-order.ts (this app never value-imports that package at
 * runtime); `orders/dto/reorder-lines.dto.spec.ts` pins the two.
 */
export const LINE_ORDER_MAX_IDS = 1000;

/** Equal copy of `LINE_SORT_VALUES` in packages/types/api/line-order.ts, pinned the same way. */
export const LINE_SORT_VALUES = ["name"] as const;
export type LineSort = (typeof LINE_SORT_VALUES)[number];

@ValidatorConstraint({ name: "lineIdsXorSort", async: false })
class LineIdsXorSort implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    const o = args.object as ReorderLinesDto;
    return (o.lineIds === undefined) !== (o.sort === undefined);
  }
  defaultMessage() {
    return "send either lineIds or sort, not both and not neither";
  }
}

/**
 * W-1187: the body of `PUT /orders/:id/line-order` and `PUT /buyer/orders/:id/line-order`. Exactly these fields: the
 * global pipe whitelists and forbids the rest, so a buyer cannot smuggle a line field or `expectedRevisionNumber` through.
 * Exactly one of `lineIds` (every line of the order in the new order; the service checks the set against the order's
 * lines) or `sort` (the server computes the order once, ruling 7).
 */
export class ReorderLinesDto {
  @IsDateString()
  expectedUpdatedAt!: string;

  @ValidateIf((o: ReorderLinesDto) => o.lineIds !== undefined || o.sort === undefined)
  @Validate(LineIdsXorSort)
  @IsArray()
  @ArrayMaxSize(LINE_ORDER_MAX_IDS)
  @ArrayUnique()
  @IsUUID("all", { each: true })
  lineIds?: string[];

  @ValidateIf((o: ReorderLinesDto) => o.sort !== undefined)
  @IsIn(LINE_SORT_VALUES)
  sort?: LineSort;
}
