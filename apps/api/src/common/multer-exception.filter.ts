import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from "@nestjs/common";
import { MulterError } from "multer";
import type { Response } from "express";

/**
 * Maps multer's newer error codes to 400, which @nestjs/platform-express does not.
 *
 * WHY THIS EXISTS
 * `transformException` in @nestjs/platform-express@11.2.3 switches on the error's
 * MESSAGE against a frozen list (`multer/multer.constants.js`) that stops at
 * `LIMIT_FIELD_NESTING`. multer 2.3.0 added three codes it has never heard of:
 * `LIMIT_FIELD_ARRAY_INDEX`, `INVALID_FIELD_NAME` and `STREAM_DESTROYED`. An
 * unmatched error falls through `transformException` unchanged, so a raw
 * `MulterError` — not an HttpException — reaches the global filters.
 *
 * ⚠️ That matters more than it looks. `SentryExceptionFilter` treats any
 * non-HttpException as status 500, so WITHOUT this filter the field-parser guard
 * that `upload-limits.ts` exists to enable would answer a malicious request with a
 * 500 **and capture a Sentry event for every probe** — turning a blocked attack
 * into unbounded error-reporting volume. These are client input errors: 400, no
 * capture.
 *
 * Registration order is load-bearing: Nest checks globally-registered filters in
 * reverse, so this must be registered AFTER the catch-all `SentryExceptionFilter`
 * to be reached at all. See main.ts, and the ordering assertion in
 * `multer-exception.filter.spec.ts`.
 */
@Catch(MulterError)
export class MulterExceptionFilter implements ExceptionFilter {
  catch(exception: MulterError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    // multer sets `field` on the errors that name one; include it so an operator
    // hitting a real limit can see which field tripped it.
    const detail = exception.field
      ? `${exception.message} - ${exception.field}`
      : exception.message;
    const body = new BadRequestException(detail).getResponse();

    res.status(HttpStatus.BAD_REQUEST).json(body);
  }
}
