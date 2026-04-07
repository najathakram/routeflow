import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { UsersService } from "../users/users.service";
import { AppConfig } from "../config/configuration";
import { JwtPayload } from "./jwt-payload.interface";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfig>,
  ) {}

  async validateUser(username: string, password: string) {
    const user = await this.usersService.findByUsername(username);
    if (!user || user.deletedAt !== null) return null;
    if (user.status !== "ACTIVE") return null;
    // Google-only accounts have no password
    if (!user.password) return null;
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return null;
    const { password: _pw, ...result } = user;
    return result;
  }

  async login(user: NonNullable<Awaited<ReturnType<AuthService["validateUser"]>>>) {
    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      forcePasswordChange: user.forcePasswordChange,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.expiresIn as any,
    });

    const refreshToken = this.jwtService.sign(
      { sub: user.id },
      { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn as any },
    );

    await this.storeRefreshToken(user.id, refreshToken);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        forcePasswordChange: user.forcePasswordChange,
      },
    };
  }

  async refresh(incomingToken: string) {
    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

    let payload: { sub: string };
    try {
      payload = this.jwtService.verify(incomingToken, {
        secret: jwtConfig.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    const tokenHash = this.hashToken(incomingToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!stored || stored.userId !== payload.sub || stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token revoked or expired");
    }

    // Rotate — delete old, issue new pair (deleteMany avoids P2025 on race)
    await this.prisma.refreshToken.deleteMany({ where: { tokenHash } });

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== "ACTIVE" || user.deletedAt) {
      throw new UnauthorizedException("Account unavailable");
    }

    const newPayload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      forcePasswordChange: user.forcePasswordChange,
    };

    const accessToken = this.jwtService.sign(newPayload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.expiresIn as any,
    });

    const refreshToken = this.jwtService.sign(
      { sub: user.id },
      { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn as any },
    );

    await this.storeRefreshToken(user.id, refreshToken);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        forcePasswordChange: user.forcePasswordChange,
      },
    };
  }

  async logout(userId: string) {
    await this.prisma.refreshToken.deleteMany({ where: { userId } });
    return { message: "Logged out successfully" };
  }

  async findOrCreateGoogleUser(profile: any) {
    const email = profile.emails?.[0]?.value;
    if (!email) throw new Error("No email from Google");

    // Try find by googleId first, then by email
    let user = await this.prisma.user.findFirst({
      where: { OR: [{ googleId: profile.id }, { email }] },
    });

    if (!user) {
      // Create new OPERATOR user
      user = await this.prisma.user.create({
        data: {
          email,
          username:
            email
              .split("@")[0]
              .replace(/[^a-z0-9_]/gi, "_")
              .toLowerCase() +
            "_" +
            Date.now(),
          password: null,
          role: "OPERATOR",
          googleId: profile.id,
          status: "ACTIVE",
        },
      });
    } else if (!user.googleId) {
      // Link existing user to Google
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { googleId: profile.id },
      });
    }

    return user;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    if (!user.password) throw new BadRequestException("This account uses Google sign-in and has no password");

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) throw new BadRequestException("Current password is incorrect");

    const sameAsOld = await bcrypt.compare(newPassword, user.password);
    if (sameAsOld) throw new BadRequestException("New password must differ from current password");

    const newHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: newHash, forcePasswordChange: false },
    });

    return { message: "Password changed successfully" };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private async storeRefreshToken(userId: string, token: string) {
    const tokenHash = this.hashToken(token);
    const decoded = this.jwtService.decode(token) as { exp: number };
    const expiresAt = new Date(decoded.exp * 1000);
    await this.prisma.refreshToken.upsert({
      where: { tokenHash },
      create: { userId, tokenHash, expiresAt },
      update: { expiresAt },
    });
  }
}
