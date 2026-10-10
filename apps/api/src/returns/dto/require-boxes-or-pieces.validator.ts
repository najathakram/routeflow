import { registerDecorator, ValidationArguments, ValidationOptions } from "class-validator";

/**
 * SA-128/B814: `boxes`/`pieces` are each required and non-negative on their own decorators —
 * this is the remaining cross-field rule, that at least ONE of them is actually positive
 * (`{ boxes: 0, pieces: 0 }` is a 400, not a silent zero-piece return). Attach to either field;
 * it reads both off `args.object`.
 */
export function RequireBoxesOrPiecesPositive(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "requireBoxesOrPiecesPositive",
      target: object.constructor,
      propertyName,
      options: {
        message: "boxes or pieces must be greater than 0",
        ...validationOptions,
      },
      validator: {
        validate(_value: unknown, args: ValidationArguments) {
          const obj = args.object as { boxes?: number; pieces?: number };
          return Number(obj.boxes ?? 0) > 0 || Number(obj.pieces ?? 0) > 0;
        },
      },
    });
  };
}
