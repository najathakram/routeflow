import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { UsersService } from "../users/users.service";
import { AppConfig } from "../config/configuration";
import { JwtPayload } from "./jwt-payload.interface";

export interface DeviceInfo {
  userAgent?: string;
  ipAddress?: string;
  deviceName?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfig>,
  ) {}

  async validateUser(username: string, password: string, tenantId: string | null) {
    let user = await this.usersService.findByUsername(username, tenantId);

    // Fallback: if no user found with the resolved tenant (e.g. stale/missing cookie),
    // and the input looks like an email, do a cross-tenant lookup so tenant admins can
    // always log in with their email regardless of which tenant cookie the browser holds.
    if (!user && username.includes("@")) {
      user = await this.usersService.findByEmailCrossTenant(username);
    }

    if (!user || user.deletedAt !== null) return null;
    if (user.status !== "ACTIVE") return null;
    // Google-only accounts have no password
    if (!user.password) return null;
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return null;
    const { password: _pw, ...result } = user;
    return result;
  }

  async login(
    user: NonNullable<Awaited<ReturnType<AuthService["validateUser"]>>>,
    deviceInfo?: DeviceInfo,
  ) {
    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

    // Fetch tenant slug if user belongs to a tenant
    let tenantSlug: string | null = null;
    if (user.tenantId) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: user.tenantId },
        select: { slug: true },
      });
      tenantSlug = tenant?.slug ?? null;
    }

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      forcePasswordChange: user.forcePasswordChange,
      tenantId: user.tenantId ?? null,
      tenantSlug,
      isAdmin: user.isAdmin || user.role === "TENANT_ADMIN",
      canActAsDriver: user.canActAsDriver,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.expiresIn as any,
    });

    const refreshToken = this.jwtService.sign(
      { sub: user.id },
      { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn as any },
    );

    await this.storeRefreshToken(user.id, refreshToken, deviceInfo);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        forcePasswordChange: user.forcePasswordChange,
        tenantId: user.tenantId ?? null,
        tenantSlug,
        isAdmin: user.isAdmin || user.role === "TENANT_ADMIN",
        canActAsDriver: user.canActAsDriver,
      },
    };
  }

  async refresh(incomingToken: string, deviceInfo?: DeviceInfo) {
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

    let tenantSlug: string | null = null;
    if (user.tenantId) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: user.tenantId },
        select: { slug: true },
      });
      tenantSlug = tenant?.slug ?? null;
    }

    const newPayload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      forcePasswordChange: user.forcePasswordChange,
      tenantId: user.tenantId ?? null,
      tenantSlug,
      isAdmin: user.isAdmin || user.role === "TENANT_ADMIN",
      canActAsDriver: user.canActAsDriver,
    };

    const accessToken = this.jwtService.sign(newPayload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.expiresIn as any,
    });

    const refreshToken = this.jwtService.sign(
      { sub: user.id },
      { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn as any },
    );

    // Preserve device info from old token if not provided
    const effectiveDeviceInfo: DeviceInfo = deviceInfo ?? {
      userAgent: stored.userAgent ?? undefined,
      ipAddress: stored.ipAddress ?? undefined,
      deviceName: stored.deviceName ?? undefined,
    };

    await this.storeRefreshToken(user.id, refreshToken, effectiveDeviceInfo);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        forcePasswordChange: user.forcePasswordChange,
        tenantId: user.tenantId ?? null,
        tenantSlug,
        isAdmin: user.isAdmin || user.role === "TENANT_ADMIN",
        canActAsDriver: user.canActAsDriver,
      },
    };
  }

  async logout(userId: string) {
    await this.prisma.refreshToken.deleteMany({ where: { userId } });
    return { message: "Logged out successfully" };
  }

  // ─── Session management ────────────────────────────────────────────────────────

  async listSessions(userId: string) {
    const sessions = await this.prisma.refreshToken.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        userAgent: true,
        ipAddress: true,
        deviceName: true,
      },
    });
    return sessions.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      expiresAt: s.expiresAt,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      deviceName: s.deviceName ?? this.deriveDeviceName(s.userAgent),
    }));
  }

  async revokeSession(userId: string, sessionId: string) {
    const session = await this.prisma.refreshToken.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      throw new ForbiddenException("Session not found");
    }
    await this.prisma.refreshToken.delete({ where: { id: sessionId } });
    return { message: "Session revoked" };
  }

  // ─── OAuth helpers ─────────────────────────────────────────────────────────────

  async findOrCreateGoogleUser(profile: any, tenantId?: string | null) {
    const email = profile.emails?.[0]?.value;
    if (!email) throw new Error("No email from Google");

    // Try find by googleId first, then by email — scoped to tenant
    let user = await this.prisma.user.findFirst({
      where: {
        tenantId: tenantId ?? null,
        OR: [{ googleId: profile.id }, { email }],
      },
    });

    if (!user) {
      // Create new OPERATOR user for the tenant
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
          tenantId: tenantId ?? null,
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

    if (!user.password)
      throw new BadRequestException("This account uses Google sign-in and has no password");

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

  private async storeRefreshToken(userId: string, token: string, deviceInfo?: DeviceInfo) {
    const tokenHash = this.hashToken(token);
    const decoded = this.jwtService.decode(token) as { exp: number };
    const expiresAt = new Date(decoded.exp * 1000);
    await this.prisma.refreshToken.upsert({
      where: { tokenHash },
      create: {
        userId,
        tokenHash,
        expiresAt,
        lastUsedAt: new Date(),
        userAgent: deviceInfo?.userAgent ?? null,
        ipAddress: deviceInfo?.ipAddress ?? null,
        deviceName: deviceInfo?.deviceName ?? null,
      },
      update: {
        expiresAt,
        lastUsedAt: new Date(),
        userAgent: deviceInfo?.userAgent ?? undefined,
        ipAddress: deviceInfo?.ipAddress ?? undefined,
        deviceName: deviceInfo?.deviceName ?? undefined,
      },
    });
  }

  /** Derive a human-readable device name from the User-Agent string */
  private deriveDeviceName(ua: string | null | undefined): string {
    if (!ua) return "Unknown device";
    if (/iPhone|iPad|iOS/i.test(ua)) return "iPhone / iPad";
    if (/Android/i.test(ua)) return "Android device";
    if (/Windows/i.test(ua)) return "Windows PC";
    if (/Macintosh|Mac OS/i.test(ua)) return "Mac";
    if (/Linux/i.test(ua)) return "Linux PC";
    return "Unknown device";
  }
}
