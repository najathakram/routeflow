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
import { EmailService } from "../email/email.service";
import { AppConfig } from "../config/configuration";
import { JwtPayload } from "./jwt-payload.interface";
import { EntitlementsService } from "../billing/entitlements.service";

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
    private readonly emailService: EmailService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * Validate username + password.
   *
   * RF-176: cross-tenant fallback is only attempted when a tenant header was
   * provided but the user wasn't found in that tenant (e.g. stale cookie).
   * When no tenant header is present (tenantId === null) we skip the fallback
   * entirely — this prevents a null-tenantId JWT that could read across all
   * tenant data via the cross-tenant lookup path.
   */
  async validateUser(username: string, password: string, tenantId: string | null) {
    let user = await this.usersService.findByUsername(username, tenantId);

    // Cross-tenant fallback only when a tenant slug was provided but the user
    // was not found in that specific tenant (e.g. old/stale cookie).
    // Never fall back when tenantId is null (no X-Tenant-Slug sent) — that
    // would allow any tenant user to obtain a null-tenantId JWT (RF-176).
    if (!user && tenantId !== null) {
      if (username.includes("@")) {
        user = await this.usersService.findByEmailCrossTenant(username);
      } else {
        user = await this.usersService.findByUsernameCrossTenant(username);
      }
    }

    if (!user || user.deletedAt !== null) return null;
    if (user.status !== "ACTIVE") return null;
    // Account lockout: a locked account fails WITHOUT running bcrypt (no
    // timing oracle, no counter churn) and with the same null as any bad
    // credential — enumeration-safe. Time-based auto-unlock; TENANT_ADMIN can
    // clear it early via POST /users/:id/unlock.
    if (user.lockedUntil && user.lockedUntil > new Date()) return null;
    // Google-only accounts have no password
    if (!user.password) return null;
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      await this.recordFailedLogin(user.id, user.failedLoginAttempts, user.lockedUntil);
      return null;
    }
    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }
    const { password: _pw, ...result } = user;
    return result;
  }

  /** 10 consecutive failures → 15-minute lock. The per-IP login throttle
   *  (10/5min) bites first for single-IP attackers; this is layered defense
   *  against distributed guessing, tuned to avoid locking out real staff. */
  static readonly LOCKOUT_THRESHOLD = 10;
  static readonly LOCKOUT_WINDOW_MS = 15 * 60_000;

  private async recordFailedLogin(userId: string, priorFailures: number, lockedUntil: Date | null) {
    // An expired lock starts a fresh streak (otherwise one failure re-locks).
    const lockExpired = lockedUntil != null && lockedUntil <= new Date();
    const attempts = lockExpired ? 1 : (priorFailures || 0) + 1;
    const lockNow = attempts >= AuthService.LOCKOUT_THRESHOLD;
    await this.prisma.user.update({
      where: { id: userId },
      data: lockNow
        ? {
            failedLoginAttempts: 0,
            lockedUntil: new Date(Date.now() + AuthService.LOCKOUT_WINDOW_MS),
          }
        : { failedLoginAttempts: attempts, ...(lockExpired ? { lockedUntil: null } : {}) },
    });
  }

  async login(
    user: NonNullable<Awaited<ReturnType<AuthService["validateUser"]>>>,
    deviceInfo?: DeviceInfo,
  ) {
    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

    // RF-176: reject logins where the user has no tenant association unless the
    // user is a platform-level super-admin.  A null-tenantId JWT bypasses all
    // forTenant() query scoping and can read data across every tenant.
    if (!user.tenantId && user.role !== "SUPER_ADMIN") {
      throw new UnauthorizedException("Tenant not found");
    }

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

    // Plans & Billing: embed a compact entitlement snapshot (plan/flags/addons/
    // seats/trialEnds) so the client can render plan gates without a round-trip.
    // Server guards still re-resolve from EntitlementsService (the authority).
    const claims = await this.entitlements.claimsFor(payload.tenantId);
    if (claims) Object.assign(payload, claims);

    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.expiresIn as any,
    });

    const refreshToken = this.jwtService.sign(
      { sub: user.id },
      { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn as any },
    );

    // RF-228: new-device login notification (minimum viable security measure).
    // Check before storing so we compare against pre-existing tokens only.
    // Full session management (per-device revocation, session listing UI) is a backlog item.
    if (deviceInfo?.userAgent && (user as any).email) {
      const knownCount = await this.prisma.refreshToken.count({
        where: {
          userId: user.id,
          userAgent: deviceInfo.userAgent,
          expiresAt: { gt: new Date() },
        },
      });
      if (knownCount === 0) {
        const deviceName = this.deriveDeviceName(deviceInfo.userAgent);
        const loginTime = new Date().toUTCString();
        // Fire-and-forget — email failures must not block the login response.
        this.emailService
          .send({
            to: (user as any).email as string,
            subject: "New login detected on your RouteFlow account",
            html: `<p>A new login was detected on your RouteFlow account.</p>
                   <p><strong>Device:</strong> ${deviceName}</p>
                   <p><strong>IP address:</strong> ${deviceInfo.ipAddress ?? "unknown"}</p>
                   <p><strong>Time:</strong> ${loginTime}</p>
                   <p>If this wasn't you, please contact support immediately and change your password.</p>`,
          })
          .catch(() => {});
      }
    }

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

    // Plans & Billing: refresh re-snapshots entitlement claims into the token.
    const claims = await this.entitlements.claimsFor(newPayload.tenantId);
    if (claims) Object.assign(newPayload, claims);

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

  // ─── Email verification ────────────────────────────────────────────────────────

  /**
   * Verifies a self-service signup email token, activates the user, and
   * returns a full auth token pair so the frontend can auto-log in.
   */
  async verifyEmailAndLogin(token: string, deviceInfo?: DeviceInfo) {
    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

    let payload: { sub: string; type: string; tenantId: string };
    try {
      payload = this.jwtService.verify(token, { secret: jwtConfig.secret });
    } catch {
      throw new BadRequestException(
        "Verification link is invalid or has expired. Please sign up again or request a new link.",
      );
    }

    if (payload.type !== "email_verify") {
      throw new BadRequestException("Invalid verification token.");
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.deletedAt) {
      throw new BadRequestException("Account not found.");
    }

    // Already verified — still issue tokens so clicking the link twice works smoothly
    const activeUser =
      user.status === "ACTIVE"
        ? user
        : await this.prisma.user.update({
            where: { id: user.id },
            data: { status: "ACTIVE" },
          });

    const { password: _pw, ...safeUser } = activeUser;
    return this.login(safeUser, deviceInfo);
  }

  // ─── Password reset (RF-018) ──────────────────────────────────────────────────

  /**
   * Generates a single-use password reset token and emails a link to the user.
   * Always returns the same shape to prevent email enumeration.
   */
  async requestPasswordReset(email: string): Promise<{ message: string }> {
    const MSG = { message: "If that address is registered you will receive a reset link shortly." };

    // Look up user by email (cross-tenant safe — find first active match)
    const user = await this.prisma.user.findFirst({
      where: { email: email.toLowerCase(), deletedAt: null, status: "ACTIVE" },
    });
    if (!user) return MSG;

    // Raw 32-byte random token
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    // Clean up any previous unexpired tokens for this user to avoid table bloat
    await this.prisma.passwordResetToken.deleteMany({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    });

    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    const resetUrl = `https://routeflowmobile-production.up.railway.app/reset-password?token=${rawToken}`;

    this.emailService
      .send({
        to: email,
        subject: "Reset your RouteFlow password",
        html: `<p>Hi,</p>
<p>We received a request to reset the password for your RouteFlow account.</p>
<p><a href="${resetUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Reset password</a></p>
<p>This link expires in <strong>15 minutes</strong>. If you didn't request this, you can safely ignore this email — your password will not change.</p>`,
      })
      .catch(() => {});

    return MSG;
  }

  /**
   * Validates a reset token, updates the user's password, and invalidates all
   * existing refresh tokens so active sessions are force-logged-out.
   */
  async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
    const tokenHash = this.hashToken(token);
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });

    if (!record) throw new BadRequestException("Reset link is invalid or has already been used.");
    if (record.usedAt) throw new BadRequestException("Reset link has already been used.");
    if (record.expiresAt < new Date()) throw new BadRequestException("Reset link has expired.");

    const newHash = await bcrypt.hash(newPassword, 10);

    // Mark token used and update password in a transaction
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { tokenHash },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: record.userId },
        data: { password: newHash, forcePasswordChange: false },
      }),
      this.prisma.refreshToken.deleteMany({ where: { userId: record.userId } }),
    ]);

    return { message: "Password reset successfully. Please log in with your new password." };
  }

  /**
   * Hash a raw token with SHA-256 for storage — same helper used for refresh tokens.
   * Exported for unit testing.
   */
  hashTokenPublic(token: string): string {
    return this.hashToken(token);
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
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { password: newHash, forcePasswordChange: false },
    });

    // Revoke all existing refresh tokens (other sessions / stale tokens) then
    // mint a fresh access+refresh pair for the caller so the just-fixed
    // forcePasswordChange flag is reflected in their JWT.
    await this.prisma.refreshToken.deleteMany({ where: { userId } });

    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

    let tenantSlug: string | null = null;
    if (updated.tenantId) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: updated.tenantId },
        select: { slug: true },
      });
      tenantSlug = tenant?.slug ?? null;
    }

    const payload: JwtPayload = {
      sub: updated.id,
      username: updated.username,
      role: updated.role,
      status: updated.status,
      forcePasswordChange: false,
      tenantId: updated.tenantId ?? null,
      tenantSlug,
      isAdmin: updated.isAdmin || updated.role === "TENANT_ADMIN",
      canActAsDriver: updated.canActAsDriver,
    };

    // Plans & Billing: re-snapshot entitlement claims into the fresh token.
    const claims = await this.entitlements.claimsFor(payload.tenantId);
    if (claims) Object.assign(payload, claims);

    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.expiresIn as any,
    });

    const refreshToken = this.jwtService.sign(
      { sub: updated.id },
      { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn as any },
    );

    await this.storeRefreshToken(updated.id, refreshToken);

    return {
      message: "Password changed successfully. All other sessions have been invalidated.",
      accessToken,
      refreshToken,
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private async storeRefreshToken(userId: string, token: string, deviceInfo?: DeviceInfo) {
    const tokenHash = this.hashToken(token);
    const decoded = this.jwtService.decode(token);
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
