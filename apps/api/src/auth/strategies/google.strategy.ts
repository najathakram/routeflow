import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, Profile } from "passport-google-oauth20";
import { AuthService } from "../auth.service";

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, "google") {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {
    super({
      clientID: config.get<string>("GOOGLE_CLIENT_ID") ?? "placeholder",
      clientSecret: config.get<string>("GOOGLE_CLIENT_SECRET") ?? "placeholder",
      callbackURL:
        config.get<string>("GOOGLE_CALLBACK_URL") ?? "http://localhost:3000/auth/google/callback",
      scope: ["email", "profile"],
    });
  }

  async validate(accessToken: string, refreshToken: string, profile: Profile) {
    return this.authService.findOrCreateGoogleUser(profile);
  }
}
