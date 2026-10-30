import {
  ValidationPipe,
  type HttpException,
  type ValidationError,
  type ValidationPipeOptions,
} from "@nestjs/common";
import {
  RESERVED_REFERENCE_CONSTRAINT,
  stockReferenceReserved,
} from "../inventory/reserved-reference";

/** The options main.ts has always run the global pipe with. */
export const GLOBAL_VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
};

/**
 * A class-validator constraint that must reach the client as a coded error (`body.code`) rather than as a
 * plain pipe 400 with only a message array. Clients branch on `code`; a validator cannot throw an HTTP
 * exception itself, so the pipe's exception factory maps the constraint name here.
 */
const CODED_CONSTRAINTS: ReadonlyArray<readonly [string, () => HttpException]> = [
  [RESERVED_REFERENCE_CONSTRAINT, stockReferenceReserved], // B640: 400 STOCK_REFERENCE_RESERVED
];

function hasConstraint(errors: ValidationError[], name: string): boolean {
  return errors.some(
    (e) =>
      (e.constraints !== undefined && name in e.constraints) ||
      (e.children !== undefined && hasConstraint(e.children, name)),
  );
}

/**
 * The ONE global ValidationPipe (main.ts installs it; specs build the same one). Every validation failure keeps
 * the pipe's own body, except that a failure carrying a {@link CODED_CONSTRAINTS} constraint is that coded error.
 */
export function buildGlobalValidationPipe(): ValidationPipe {
  const plain = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS).createExceptionFactory();
  return new ValidationPipe({
    ...GLOBAL_VALIDATION_PIPE_OPTIONS,
    exceptionFactory: (errors: ValidationError[]) => {
      for (const [constraint, coded] of CODED_CONSTRAINTS) {
        if (hasConstraint(errors, constraint)) return coded();
      }
      return plain(errors);
    },
  });
}
