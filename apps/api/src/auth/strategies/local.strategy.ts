import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy } from "passport-local";
import { AuthService } from "../auth.service";

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly authService: AuthService) {
    super({ usernameField: "username", passReqToCallback: true });
  }

  async validate(req: any, username: string, password: string) {
    const tenantId: string | undefined = req.resolvedTenantId;
    const user = await this.authService.validateUser(username, password, tenantId ?? null);
    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }
    return user;
  }
}
