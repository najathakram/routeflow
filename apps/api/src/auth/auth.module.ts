import { Module, forwardRef } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { LocalStrategy } from "./strategies/local.strategy";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { LocalAuthGuard } from "./guards/local-auth.guard";
import { RolesGuard } from "./guards/roles.guard";
import { GoogleOAuthService } from "./google-oauth.service";
import { AppleOAuthService } from "./apple-oauth.service";
import { PlatformGoogleAuthController } from "./platform-google-auth.controller";
import { TenantGoogleOAuthService } from "../tenants/tenant-google-oauth.service";
import { UsersModule } from "../users/users.module";
import { EmailModule } from "../email/email.module";
import { EntitlementsModule } from "../billing/entitlements.module";
import { AppConfig } from "../config/configuration";
import { HandoffCodeService } from "./handoff/handoff-code.service";
import { StaffHandoffService } from "./handoff/staff-handoff.service";
import { LinkTokenSweepService } from "./link-token-sweep.service";

@Module({
  imports: [
    PassportModule,
    forwardRef(() => UsersModule),
    EmailModule,
    EntitlementsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig>) => ({
        secret: configService.get<AppConfig["jwt"]>("jwt")?.secret,
        signOptions: {
          expiresIn: configService.get<AppConfig["jwt"]>("jwt")?.expiresIn as any,
        },
      }),
    }),
  ],
  controllers: [AuthController, PlatformGoogleAuthController],
  providers: [
    AuthService,
    LocalStrategy,
    JwtStrategy,
    JwtAuthGuard,
    LocalAuthGuard,
    RolesGuard,
    GoogleOAuthService,
    AppleOAuthService,
    TenantGoogleOAuthService,
    // #2653 in-app sign-in handoff (staff realm). HandoffCodeService is stateless and shared.
    HandoffCodeService,
    StaffHandoffService,
    // Daily cleanup of expired single-use account links (all four token tables).
    LinkTokenSweepService,
  ],
  exports: [
    AuthService,
    JwtAuthGuard,
    RolesGuard,
    TenantGoogleOAuthService,
    GoogleOAuthService,
    AppleOAuthService,
  ],
})
export class AuthModule {}
