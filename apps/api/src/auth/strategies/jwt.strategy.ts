import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { JwtPayload } from "../jwt-payload.interface";
import { AppConfig } from "../../config/configuration";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService<AppConfig>) {
    const jwtConfig = configService.get<AppConfig["jwt"]>("jwt");
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtConfig?.secret ?? "",
    });
  }

  async validate(payload: JwtPayload) {
    if (!payload?.sub) throw new UnauthorizedException();
    // Reject buyer tokens — they must use the buyer-jwt strategy
    if ((payload as any).type === "BUYER")
      throw new UnauthorizedException("Use buyer auth endpoint");
    return {
      sub: payload.sub,
      id: payload.sub,
      username: payload.username,
      role: payload.role,
      status: payload.status,
      forcePasswordChange: payload.forcePasswordChange,
      tenantId: payload.tenantId ?? null,
      tenantSlug: payload.tenantSlug ?? null,
      // Capability claim minted at login — RolesGuard's dual-role branch reads it
      // (operators/tenant-admins with canActAsDriver also satisfy DRIVER). A driver-permit
      // change still needs re-login to take effect.
      // `isAdmin` is deliberately NOT propagated: it is not a role-hierarchy input but the
      // gate on PATCH /users/:id/admin (users.controller.ts — `user.isAdmin ||
      // role === TENANT_ADMIN`), which today only TENANT_ADMINs pass. Surfacing it here would
      // silently let any admin-flagged OPERATOR assign admin rights — an authorization change
      // that needs its own decision, not a side effect of a claims fix.
      canActAsDriver: payload.canActAsDriver ?? false,
      // Plans & Billing entitlement claims (client renders gates now; the
      // PlanFlagGuard re-resolves server-side once plan-gating ships).
      plan: payload.plan ?? null,
      flags: payload.flags ?? [],
      addons: payload.addons ?? [],
      seats: payload.seats ?? null,
      trialEnds: payload.trialEnds ?? null,
    };
  }
}
