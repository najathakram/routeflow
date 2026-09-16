import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import type { User } from "@prisma/client";
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
  private readonly logger = new Logger(AuthService.name);

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
    // Status is checked AFTER the password is verified, not before (it used to
    // run first). Two reasons: (1) it closes a timing oracle — checking status
    // first meant every INACTIVE username short-circuited before bcrypt, so
    // response latency alone told an attacker which usernames exist and are
    // pending verification; running bcrypt unconditionally makes the two cases
    // take the same time. (2) it lets a self-service signup user who typed
    // their real password be told the true reason they can't sign in — a
    // self-registered tenant admin is INACTIVE until they click the emailed
    // verification link (see TenantsService.register), and the previous
    // generic "Invalid credentials" was indistinguishable from a wrong
    // password, which is exactly the "signup doesn't work" confusion new
    // users reported. Only reachable with the CORRECT password, so this
    // never tells a stranger an account exists.
    if (user.status === "INACTIVE") {
      throw new ForbiddenException({
        code: "EMAIL_NOT_VERIFIED",
        message:
          "Please verify your email before signing in. Check your inbox for the verification link (and your spam folder), or request a new one.",
      });
    }
    if (user.status !== "ACTIVE") return null;
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

    // validateUser strips `password` before handing the user here, and getting
    // this far via password login proves one exists. Callers that pass a raw
    // user row (legacy Google path, email verification) still carry the field,
    // so respect it when present.
    const hasPassword =
      "password" in user ? !!(user as { password?: string | null }).password : true;

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
      hasPassword,
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
      // F5-003: tag staff refresh tokens with a realm discriminator so a
      // buyer refresh token can never be replayed on the staff refresh path.
      { sub: user.id, type: "staff" },
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
        hasPassword,
      },
    };
  }

  async refresh(incomingToken: string, deviceInfo?: DeviceInfo) {
    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

    let payload: { sub: string; type?: string };
    try {
      payload = this.jwtService.verify(incomingToken, {
        secret: jwtConfig.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    // F5-003: enforce the realm discriminator when present. A token explicitly
    // typed for another realm (e.g. a buyer refresh token) is rejected here.
    // Legacy tokens issued before this change carry no `type` — allow them
    // (grace) so live sessions are never force-logged-out. Defense-in-depth on
    // top of the per-table hash lookup below.
    if (payload.type && payload.type !== "staff") {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    const tokenHash = this.hashToken(incomingToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!stored || stored.userId !== payload.sub || stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token revoked or expired");
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== "ACTIVE" || user.deletedAt) {
      // B155: the old delete-then-check ordering consumed the token here too —
      // keep that, or a suspended user's row survives in listSessions.
      await this.prisma.refreshToken.deleteMany({ where: { tokenHash } });
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
      hasPassword: !!user.password,
    };

    // Plans & Billing: refresh re-snapshots entitlement claims into the token.
    const claims = await this.entitlements.claimsFor(newPayload.tenantId);
    if (claims) Object.assign(newPayload, claims);

    const accessToken = this.jwtService.sign(newPayload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.expiresIn as any,
    });

    const refreshToken = this.jwtService.sign(
      // F5-003: realm discriminator (rotated token).
      // B155: `jti` is what makes each rotated token UNIQUE. Without it the payload is
      // only {sub, type} plus jsonwebtoken's iat/exp at one-second resolution, so two
      // sessions of the SAME user rotating inside one second mint byte-identical tokens
      // and therefore the same sha256 `tokenHash` — a `@unique` column. The old code
      // wrote it through `upsert`, whose update branch silently absorbed the duplicate
      // (merging the two sessions); the compare-and-swap below would instead raise P2002
      // and 500 the refresh, which every client treats as a dead session.
      { sub: user.id, type: "staff", jti: crypto.randomUUID() },
      { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn as any },
    );

    // B155: rotate IN PLACE. The old code deleted the row and upserted a NEW one
    // (a new id + createdAt every ~15 min), so Active Sessions showed the last
    // rotation as "Signed in" and Revoke-by-listed-id 403'd after any rotation.
    // Compare-and-swap on { id, oldHash }: the update IS the invalidation of the
    // old token. `id`/`createdAt`/`userId` are never written.
    const now = new Date();
    const newTokenHash = this.hashToken(refreshToken);
    const newExpiresAt = new Date(this.jwtService.decode(refreshToken).exp * 1000);
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, tokenHash: stored.tokenHash },
      data: {
        tokenHash: newTokenHash,
        expiresAt: newExpiresAt,
        lastUsedAt: now,
        // Only overwrite device columns when the caller supplied them (mirrors the
        // old upsert's `update` branch); `undefined` leaves a column untouched.
        userAgent: deviceInfo?.userAgent,
        ipAddress: deviceInfo?.ipAddress,
        deviceName: deviceInfo?.deviceName,
      },
    });

    if (count === 0) {
      // Lost a concurrent-rotation race: another refresh of the same token already
      // swapped the hash. Preserve the old tolerance (the deleteMany comment's
      // "avoids P2025 on race") — give the loser a fresh row so BOTH refreshes
      // succeed exactly as before.
      const effectiveDeviceInfo: DeviceInfo = deviceInfo ?? {
        userAgent: stored.userAgent ?? undefined,
        ipAddress: stored.ipAddress ?? undefined,
        deviceName: stored.deviceName ?? undefined,
      };
      await this.storeRefreshToken(user.id, refreshToken, effectiveDeviceInfo);
    }

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
        hasPassword: !!user.password,
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

    // Already verified — still issue tokens so clicking the link twice works smoothly.
    // X2 fix: only INACTIVE (the legitimate self-signup-pending-verification
    // state) may transition to ACTIVE here. This token is a 24h-lived JWT
    // signed at signup time — if an admin SUSPENDS the account within that
    // window (e.g. for abuse, before the owner ever verified), the still-valid
    // link must not silently un-suspend it. Any other non-ACTIVE status is a
    // deliberate administrative decision this token was never meant to override.
    if (user.status !== "ACTIVE" && user.status !== "INACTIVE") {
      throw new BadRequestException(
        "This account is not available. Contact support if you believe this is an error.",
      );
    }
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
  async requestPasswordReset(
    email: string,
    surface: "web" | "mobile" = "mobile",
  ): Promise<{ message: string }> {
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

    // The base URL is resolved strictly server-side from config — accepting a
    // client-supplied URL here would let an attacker exfiltrate reset tokens.
    const urls = this.configService.get<AppConfig["urls"]>("urls")!;
    const base = surface === "web" ? urls.web : urls.mobileWeb;
    const resetUrl = `${base}/reset-password?token=${rawToken}`;

    // B212-class fix: this used to be fire-and-forget with the result
    // discarded (`.catch(() => {})`, never awaited) — the response text stays
    // the SAME fixed, enumeration-safe message either way (a real delivery
    // failure must never be distinguishable to the caller), but the attempt
    // is no longer silent server-side: a real user locked out by a broken
    // mail transport used to have zero trace anywhere but "user says they
    // never got the email".
    const sendResult = await this.emailService
      .send({
        to: email,
        subject: "Reset your RouteFlow password",
        html: `<p>Hi,</p>
<p>We received a request to reset the password for your RouteFlow account.</p>
<p><a href="${resetUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Reset password</a></p>
<p>This link expires in <strong>15 minutes</strong>. If you didn't request this, you can safely ignore this email — your password will not change.</p>`,
      })
      .catch((err: Error) => ({
        delivered: false,
        transport: "none" as const,
        error: err.message,
        smtpFallbackReason: undefined as string | undefined,
      }));

    if (!sendResult.delivered) {
      this.logger.error(
        `Password reset email NOT delivered for user ${user.id} (${email}) — ` +
          `transport=${sendResult.transport} ` +
          `error=${sendResult.error ?? sendResult.smtpFallbackReason ?? "unknown"}.`,
      );
    }

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

    const tokens = await this.mintSessionForUser(updated);

    return {
      message: "Password changed successfully. All other sessions have been invalidated.",
      ...tokens,
    };
  }

  /**
   * First-password setup for a signed-in account that has none (Google-only
   * sign-ins). Refuses when a password already exists — overwriting one
   * requires the current-password proof in changePassword. The NULL check runs
   * against the database, never a JWT claim, so a stale token can't authorize
   * a takeover.
   */
  async setPassword(userId: string, newPassword: string, deviceInfo?: DeviceInfo) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    if (user.password)
      throw new BadRequestException(
        "This account already has a password — use change password instead",
      );

    const newHash = await bcrypt.hash(newPassword, 10);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { password: newHash, forcePasswordChange: false },
    });

    const tokens = await this.mintSessionForUser(updated, deviceInfo);

    if (user.email) {
      // Fire-and-forget — email failures must not block the mutation.
      this.emailService
        .send({
          to: user.email,
          subject: "A password was set on your RouteFlow account",
          html: `<p>A password was just set on your RouteFlow account, which previously signed in with Google only.</p>
                 <p><strong>Time:</strong> ${new Date().toUTCString()}</p>
                 <p><strong>IP address:</strong> ${deviceInfo?.ipAddress ?? "unknown"}</p>
                 <p>You can now sign in with your username and this password as well as with Google. If this wasn't you, reset your password immediately and contact support.</p>`,
        })
        .catch(() => {});
    }

    return {
      message: "Password set successfully. All other sessions have been invalidated.",
      ...tokens,
    };
  }

  /**
   * Revoke every refresh token for the user, then mint a fresh access+refresh
   * pair from current DB state — the shared tail of changePassword/setPassword.
   * The caller's JWT immediately reflects the mutation (forcePasswordChange,
   * hasPassword) while every other session dies.
   */
  private async mintSessionForUser(user: User, deviceInfo?: DeviceInfo) {
    await this.prisma.refreshToken.deleteMany({ where: { userId: user.id } });

    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

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
      hasPassword: !!user.password,
    };

    // Plans & Billing: re-snapshot entitlement claims into the fresh token.
    const claims = await this.entitlements.claimsFor(payload.tenantId);
    if (claims) Object.assign(payload, claims);

    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.expiresIn as any,
    });

    const refreshToken = this.jwtService.sign(
      { sub: user.id, type: "staff" }, // F5-003: realm discriminator (force-refresh)
      { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn as any },
    );

    await this.storeRefreshToken(user.id, refreshToken, deviceInfo);

    return { accessToken, refreshToken };
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
