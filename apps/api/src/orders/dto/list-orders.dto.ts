import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { FulfillPath, OrderStatus } from "@prisma/client";
import { MAX_LIST_LIMIT } from "../../common/pagination";
import { ORDER_STATUS_GROUP_VALUES } from "../../common/terminal-order-statuses";

export class ListOrdersDto {
  @IsOptional() @IsString() customerId?: string;
  /**
   * PR-B: only orders containing at least one line for this product. Answers
   * "which orders had this item?" — `OrderItem.productId` is indexed, so this
   * is a cheap `lineItems: { some: { productId } }`. Composes with every other
   * filter (customer, status, dates) rather than replacing them.
   */
  @IsOptional() @IsString() productId?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
  /** UX guide B12: a status GROUP ("ACTIVE" = in progress). An explicit `status` wins over it. */
  @IsOptional()
  @IsIn(ORDER_STATUS_GROUP_VALUES)
  statusGroup?: (typeof ORDER_STATUS_GROUP_VALUES)[number];
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() urgent?: boolean;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number = 1;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_LIST_LIMIT) @Type(() => Number) limit?: number = 20;
  @IsOptional() @IsDateString() deliveryDateFrom?: string;
  @IsOptional() @IsDateString() deliveryDateTo?: string;
  @IsOptional()
  @IsEnum(FulfillPath)
  fulfillPath?: FulfillPath;
  /** Orders shipped on/after this instant (`shippedAt`, stamped by the ship transition). */
  @IsOptional() @IsDateString() shippedFrom?: string;
  /**
   * `false` = only orders with NO tracking number yet; `true` = only those that have one. Only the
   * literals "true" / "false" filter; any other value (or none) means no filter.
   */
  @IsOptional()
  @Transform(({ value }) => (value === "true" ? true : value === "false" ? false : undefined))
  @IsBoolean()
  hasTracking?: boolean;
  /**
   * SA-1124: `true` = only orders with an open review flag (an offline order that needs a person's look). Staff only:
   * ignored for a customer. Only the literal "true" filters; any other value (or none) means no filter.
   */
  @IsOptional()
  @Transform(({ value }) => (value === "true" ? true : undefined))
  @IsBoolean()
  needsReview?: boolean;
}
