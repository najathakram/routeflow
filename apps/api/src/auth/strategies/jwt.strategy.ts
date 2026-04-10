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
    if ((payload as any).type === "BUYER") throw new UnauthorizedException("Use buyer auth endpoint");
    return {
      sub: payload.sub,
      id: payload.sub,
      username: payload.username,
      role: payload.role,
      status: payload.status,
      forcePasswordChange: payload.forcePasswordChange,
      tenantId: payload.tenantId ?? null,
      tenantSlug: payload.tenantSlug ?? null,
    };
  }
}
