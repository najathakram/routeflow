import {
  IsBoolean,
  IsObject,
  IsOptional,
  ValidateNested,
  registerDecorator,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { REGISTER_KEY_PATTERN } from "@routeflow/pricing";
import { CounterSalePaymentDto } from "./counter-sale.dto";
import { RestrictionAckDto } from "../../selling-restrictions/dto/restriction-ack.dto";

const IsRegisterKey = () => (target: object, propertyName: string) =>
  registerDecorator({
    name: "isRegisterKey",
    target: target.constructor,
    propertyName,
    options: {
      message:
        "registerKey must be 1-64 letters, digits, '_', '-' or ':' (a ':' cannot come first)",
    },
    validator: { validate: (v: unknown) => typeof v === "string" && REGISTER_KEY_PATTERN.test(v) },
  });

/** `PickupCompleteRequest` of the shared contract (packages/types/api/counter-sale.ts). */
/** W-773: a restricted line's acknowledged override (#3455) travels to the switch, like every staff write body. */
export class PickupCompleteDto extends RestrictionAckDto {
  /** Omit to hand the order over unpaid (on account). A walk-in must pay. */
  @IsOptional()
  @IsObject() // W-887: a list is the same malformed shape (isObject excludes arrays)
  @ValidateNested()
  @Type(() => CounterSalePaymentDto)
  payment?: CounterSalePaymentDto;

  /**
   * SA-750r3: the register this hand-over's cash is counted on, when the order carries none yet (a stamped
   * `Order.registerKey` wins). Absent or blank = the default register. Case-sensitive: never lower-cased.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  )
  @IsOptional()
  @IsRegisterKey()
  registerKey?: string;

  /** I-120 R8 (owner 7a Q1 = A): the operator confirmed taking an order on a driver's run off the run. */
  @IsOptional()
  @IsBoolean()
  takeOffRun?: boolean;
}
