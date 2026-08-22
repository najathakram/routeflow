import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { StripeConnectService } from "./stripe-connect.service";

/**
 * Tenant-side Stripe Connect management. TENANT_ADMIN satisfies @Roles(OPERATOR).
 */
@Controller("settings/stripe-connect")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class StripeConnectController {
  constructor(private readonly connect: StripeConnectService) {}

  @Get()
  status(@CurrentUser() user: JwtPayload) {
    return this.connect.getStatus(user.tenantId!);
  }

  /** Returns the Stripe authorize URL; the web client navigates the browser there. */
  @Post("link")
  async link(@CurrentUser() user: JwtPayload) {
    const url = await this.connect.buildAuthorizeUrl(user.tenantId!, user.username ?? null);
    return { url };
  }

  @Delete()
  disconnect(@CurrentUser() user: JwtPayload) {
    return this.connect.disconnect(user.tenantId!);
  }
}

/**
 * Fixed set of user-safe messages for every code `StripeConnectService.
 * completeOAuth` can throw (invariant 12) — the public callback must NEVER
 * reflect internal exception text (Stripe SDK errors, raw jwt failures,
 * anything else unexpected) into the redirect URL. A code that isn't in this
 * table — including anything not thrown by `completeOAuth` at all — falls
 * back to the generic message below rather than being echoed verbatim.
 */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  state_expired: "That connect link expired — start again from Settings.",
  state_invalid: "That connect link wasn't valid — start again from Settings.",
  state_replayed: "That connect link was already used — start again from Settings.",
  tenant_not_found: "We couldn't find your account — start again from Settings.",
  stripe_exchange_failed: "Stripe rejected the connect code — try linking again.",
  account_missing: "Stripe did not return an account — try linking again.",
};
const OAUTH_GENERIC_ERROR = "Could not connect Stripe — try again from Settings.";

/**
 * The OAuth return leg. Stripe redirects the operator's BROWSER here, without
 * our auth headers, so this controller is public — the signed `state` (verified
 * in the service) is the sole authority for which tenant gets linked. On any
 * outcome the browser is bounced back to the web settings page with a query
 * flag it can toast on.
 */
@Controller("settings/stripe-connect")
export class StripeConnectCallbackController {
  constructor(private readonly connect: StripeConnectService) {}

  @Get("callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Res() res: Response,
  ) {
    const webUrl = (process.env.WEB_URL ?? "https://www.routeflow.info").replace(/\/$/, "");
    const back = (params: Record<string, string>) =>
      `${webUrl}/settings?${new URLSearchParams(params).toString()}`;

    // The operator clicked "cancel" on Stripe's screen, or Stripe refused —
    // never reflect Stripe's own `error`/`error_description` query params
    // verbatim into our redirect (invariant 12: fixed, user-safe copy only).
    if (error || !code || !state) {
      res.redirect(back({ stripe: "error", reason: OAUTH_GENERIC_ERROR }));
      return;
    }
    try {
      const result = await this.connect.completeOAuth(code, state);
      res.redirect(
        back({ stripe: "connected", charges: result.chargesEnabled ? "enabled" : "pending" }),
      );
    } catch (err) {
      const code2 =
        err instanceof BadRequestException ? String((err.getResponse() as any)?.message ?? "") : "";
      res.redirect(
        back({ stripe: "error", reason: OAUTH_ERROR_MESSAGES[code2] ?? OAUTH_GENERIC_ERROR }),
      );
    }
  }
}
