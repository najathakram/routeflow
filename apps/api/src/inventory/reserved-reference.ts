/**
 * B640 (row 562 S1): the heads a free-text stock reference may never start with.
 *
 * Both stock-count commit paths read "a movement with the count's reference exists" as "this line is already
 * committed" (`STOCK_COUNT-<sessionId>`: `commitStockCount`'s idempotency read, and the durable commit's
 * per-product done-check). `StockMovement.reference` is free text on the adjustment and purchase DTOs, so a
 * reference planted ahead of a commit made that commit a silent no-op for the product. One predicate decides
 * what is reserved; the DTO decorator and the service guard both call it.
 */
import { BadRequestException, ConflictException } from "@nestjs/common";
import { registerDecorator, type ValidationOptions } from "class-validator";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { STOCK_COUNT_REFERENCE_PREFIX } from "./stock-count-commit";

/** Upper-case heads: a reference is compared trimmed and case-insensitively. */
export const RESERVED_STOCK_REFERENCE_PREFIXES: readonly string[] = [STOCK_COUNT_REFERENCE_PREFIX];

/** True when `ref` is a string that starts (after trimming, any letter case) with a reserved head. */
export function isReservedStockReference(ref: unknown): boolean {
  if (typeof ref !== "string") return false;
  const head = ref.trim().toUpperCase();
  return RESERVED_STOCK_REFERENCE_PREFIXES.some((p) => head.startsWith(p.toUpperCase()));
}

/** The coded 400 for a reserved reference. `message` names what the person can do instead. */
export function stockReferenceReserved(
  message = "That reference is reserved for stock counts. Use another one.",
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: API_ERROR_CODES.STOCK_REFERENCE_RESERVED,
    message,
  });
}

/** The service guard: throws the coded 400 when `ref` is reserved; an absent or empty reference passes. */
export function assertStockReferenceFree(ref: string | null | undefined): void {
  if (isReservedStockReference(ref)) throw stockReferenceReserved();
}

/**
 * DTO decorator for a free-text `reference` field: refuses a reserved head with a 400 before the service
 * runs. Pair it with `@IsOptional() @IsString()`; `stock-count` pin `reserved-reference.spec.ts` fails for
 * any inventory DTO `reference: string` without it.
 */
export function IsNotReservedStockReference(options?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol) => {
    registerDecorator({
      name: "isNotReservedStockReference",
      target: object.constructor,
      propertyName: propertyName as string,
      options: {
        message: "reference is reserved for stock counts. Use another one.",
        ...options,
      },
      validator: { validate: (value: unknown) => !isReservedStockReference(value) },
    });
  };
}

/**
 * The legacy one-shot count (`POST stock-count/commit`) takes a CLIENT-chosen `sessionId` and writes
 * `STOCK_COUNT-<sessionId>`. A sessionId that names a DURABLE session would write movements under that
 * session's own reference, which its commit then reads as "already committed". Refuse it with the coded 409 STOCK_COUNT_ID_TAKEN (SA-990).
 */
export async function assertNotDurableCountId(
  db: { stockCountSession: { findUnique(args: { where: { id: string } }): Promise<unknown> } },
  sessionId: string,
): Promise<void> {
  if (await db.stockCountSession.findUnique({ where: { id: sessionId } })) {
    throw new ConflictException({
      statusCode: 409,
      code: API_ERROR_CODES.STOCK_COUNT_ID_TAKEN,
      message: "That count id belongs to a saved stock count. Start a new count.",
    });
  }
}
