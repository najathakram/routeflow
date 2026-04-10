import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../../config/configuration";
import { BuyerJwtPayload } from "../interfaces/buyer-jwt-payload.interface";

@Injectable()
export class BuyerJwtStrategy extends PassportStrategy(Strategy, "buyer-jwt") {
  constructor(configService: ConfigService<AppConfig>) {
    const jwtConfig = configService.get<AppConfig["jwt"]>("jwt");
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtConfig?.secret ?? "",
    });
  }

  async validate(payload: BuyerJwtPayload) {
    if (!payload?.sub || payload.type !== "BUYER") {
      throw new UnauthorizedException("Invalid buyer token");
    }
    return { sub: payload.sub, email: payload.email, type: "BUYER" as const };
  }
}
