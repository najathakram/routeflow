import { applyDecorators, SetMetadata, UseGuards } from "@nestjs/common";
import {
  NO_IMPERSONATION_KEY,
  NoImpersonationGuard,
  type NoImpersonationScope,
} from "../guards/no-impersonation.guard";

/**
 * SA-778: marks a handler (or a whole controller) as unavailable in a support session. It writes the
 * metadata AND attaches NoImpersonationGuard, so a decorated route can never be left without its guard.
 * Put it on a controller that already has a class-level `@UseGuards(JwtAuthGuard, ...)`: class guards run
 * before method guards, which is what puts the guard after authentication.
 *
 *   @Post("portal")
 *   @NoImpersonation("billing")
 */
export const NoImpersonation = (scope: NoImpersonationScope) =>
  applyDecorators(SetMetadata(NO_IMPERSONATION_KEY, scope), UseGuards(NoImpersonationGuard));
