import { ArrayMaxSize, ArrayUnique, IsArray, IsDateString, IsUUID } from "class-validator";

/**
 * Equal copy of `LINE_ORDER_MAX_IDS` in packages/types/api/line-order.ts (this app never value-imports that package at
 * runtime); `orders/dto/reorder-lines.dto.spec.ts` pins the two.
 */
export const LINE_ORDER_MAX_IDS = 1000;

/**
 * W-1187: the body of `PUT /orders/:id/line-order` and `PUT /buyer/orders/:id/line-order`. Exactly these two fields: the
 * global pipe whitelists and forbids the rest, so a buyer cannot smuggle a line field or `expectedRevisionNumber` through.
 * `lineIds` is every line of the order in the new order (the service checks the set against the order's lines).
 */
export class ReorderLinesDto {
  @IsDateString()
  expectedUpdatedAt!: string;

  @IsArray()
  @ArrayMaxSize(LINE_ORDER_MAX_IDS)
  @ArrayUnique()
  @IsUUID("all", { each: true })
  lineIds!: string[];
}
