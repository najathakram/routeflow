import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { AppConfig } from "../config/configuration";
import { BuyerJwtPayload } from "./interfaces/buyer-jwt-payload.interface";
import { BuyerRegisterDto } from "./dto/buyer-register.dto";
import { BuyerLoginDto } from "./dto/buyer-login.dto";

export interface BuyerDeviceInfo {
  userAgent?: string;
  ipAddress?: string;
  deviceName?: string;
}

@Injectable()
export class BuyerAuthService {
  private readonly logger = new Logger(BuyerAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfig>,
    private readonly emailService: EmailService,
  ) {}

  // ─── Register ─────────────────────────────────────────────────────────────────

  async register(dto: BuyerRegisterDto, deviceInfo?: BuyerDeviceInfo) {
    const existing = await this.prisma.buyerAccount.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException("An account with this email already exists");
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const account = await this.prisma.buyerAccount.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash,
        name: dto.name,
        phone: dto.phone,
        mobile: dto.mobile,
        status: "ACTIVE",
        emailVerified: false,
      },
    });

    const tokens = await this.issueBuyerTokenPair(
      account.id,
      account.email,
      account.name,
      deviceInfo,
      true, // registered with a password
    );
    this.logger.log(`BuyerAccount registered: ${account.email}`);

    // Fire-and-forget: the verification email gates only instant seller
    // auto-connect (BuyerService.requestSeller), never the session itself — a
    // transport failure must not fail registration. Buyers can re-request the
    // link any time via /buyer/auth/resend-verification.
    void this.issueVerificationEmail(account).catch((e: Error) =>
      this.logger.warn(`Verification email for ${account.email} failed: ${e.message}`),
    );

    return {
      ...tokens,
      buyer: { id: account.id, email: account.email, name: account.name, hasPassword: true },
    };
  }

  // ─── Email verification ───────────────────────────────────────────────────────

  /** Verification links live longer than reset links — 24h vs 15min — because
   *  they prove a mailbox, not authorize a credential change. */
  static readonly EMAIL_VERIFY_TTL_MS = 24 * 60 * 60_000;

  /**
   * Creates a single-use verification token and emails the link. The token is
   * stored hashed (like reset tokens); the base URL is resolved strictly
   * server-side so a client can never redirect the token elsewhere.
   */
  private async issueVerificationEmail(account: { id: string; email: string }) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + BuyerAuthService.EMAIL_VERIFY_TTL_MS);

    // Clean up previous unexpired tokens to avoid table bloat (mirrors reset flow)
    await this.prisma.buyerEmailVerificationToken.deleteMany({
      where: { buyerAccountId: account.id, usedAt: null, expiresAt: { gt: new Date() } },
    });
    await this.prisma.buyerEmailVerificationToken.create({
      data: { buyerAccountId: account.id, tokenHash, expiresAt },
    });

    const urls = this.configService.get<AppConfig["urls"]>("urls")!;
    const verifyUrl = `${urls.web}/buyer/verify-email?token=${rawToken}`;

    return this.emailService.send({
      to: account.email,
      subject: "Verify your email for RouteFlow",
      html: `<p>Hi,</p>
<p>A RouteFlow buyer portal account was created with this email address. Confirm it's yours to unlock instant connections to sellers who already know this email.</p>
<p><a href="${verifyUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Verify my email</a></p>
<p>This link expires in <strong>24 hours</strong>.</p>
<p><strong>Didn't create this account?</strong> Ignore this email and do not click the button — the account will simply stay unverified.</p>`,
      // email-connect-google PR-3: platform sender only — never a tenant mailbox/SMTP.
      senderClass: "platform",
    });
  }

  /**
   * Consumes a verification token and flips `emailVerified` — the flag
   * `BuyerService.requestSeller` requires before a sign-in-email match may
   * auto-connect to a seller's customer record.
   */
  async verifyEmail(token: string): Promise<{ message: string }> {
    const tokenHash = this.hashToken(token);
    const record = await this.prisma.buyerEmailVerificationToken.findUnique({
      where: { tokenHash },
    });

    if (!record) {
      throw new BadRequestException("Verification link is invalid or has already been used.");
    }
    if (record.usedAt) throw new BadRequestException("Verification link has already been used.");
    if (record.expiresAt < new Date()) {
      throw new BadRequestException(
        "Verification link has expired. Sign in and request a new one from your portal.",
      );
    }

    await this.prisma.$transaction([
      this.prisma.buyerEmailVerificationToken.update({
        where: { tokenHash },
        data: { usedAt: new Date() },
      }),
      this.prisma.buyerAccount.update({
        where: { id: record.buyerAccountId },
        data: { emailVerified: true },
      }),
    ]);

    this.logger.log(`BuyerAccount ${record.buyerAccountId} verified their email`);
    return {
      message: "Email verified. Sellers who know this email can now connect you instantly.",
    };
  }

  /**
   * Re-sends the verification link for the signed-in buyer. Awaited (not
   * fire-and-forget) so the response can be honest about delivery — send()
   * returns `{delivered}` instead of throwing for transport problems.
   */
  async resendVerification(
    buyerAccountId: string,
  ): Promise<{ message: string; sent: boolean; alreadyVerified?: boolean }> {
    const account = await this.prisma.buyerAccount.findUnique({ where: { id: buyerAccountId } });
    if (!account || account.deletedAt || account.status !== "ACTIVE") {
      throw new UnauthorizedException();
    }
    if (account.emailVerified) {
      return { message: "Your email is already verified.", sent: false, alreadyVerified: true };
    }

    const result = await this.issueVerificationEmail(account).catch((e: Error) => {
      this.logger.warn(`Resend verification for ${account.email} failed: ${e.message}`);
      return { delivered: false as const };
    });

    return result.delivered
      ? {
          message: `Verification email sent to ${account.email}. The link expires in 24 hours.`,
          sent: true,
        }
      : {
          message: "We couldn't send the verification email right now — please try again shortly.",
          sent: false,
        };
  }

  // ─── Login ────────────────────────────────────────────────────────────────────

  async login(dto: BuyerLoginDto, deviceInfo?: BuyerDeviceInfo) {
    const account = await this.prisma.buyerAccount.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    // F3-005: return a CONSTANT "Invalid credentials" for not-found, deleted,
    // suspended, AND wrong-password alike — never a distinct message, so none
    // of these leaks account existence/status via the response BODY.
    if (!account || account.deletedAt) {
      throw new UnauthorizedException("Invalid credentials");
    }

    // Account lockout — same policy as staff (auth.service.ts): locked
    // accounts fail without running bcrypt and with the identical message
    // (enumeration-safe); time-based auto-unlock only.
    if (account.lockedUntil && account.lockedUntil > new Date()) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const valid = await bcrypt.compare(dto.password, account.passwordHash);
    if (!valid) {
      await this.recordFailedLogin(account.id, account.failedLoginAttempts, account.lockedUntil);
      throw new UnauthorizedException("Invalid credentials");
    }

    // Status is checked AFTER the password (B213-class fix, mirroring
    // auth.service.ts validateUser): the message stays the SAME constant
    // "Invalid credentials" either way (buyers have no email-verification
    // login gate to explain), but checking status FIRST used to make a
    // SUSPENDED account's response consistently fast (no bcrypt) while an
    // ACTIVE account's wrong-password response was consistently slow (bcrypt
    // runs) — a timing oracle for "is this email a suspended buyer account"
    // that the message-level fix above never addressed. Only reachable with
    // the CORRECT password, so nothing new leaks to a stranger guessing.
    if (account.status !== "ACTIVE") {
      throw new UnauthorizedException("Invalid credentials");
    }
    if (account.failedLoginAttempts > 0 || account.lockedUntil) {
      await this.prisma.buyerAccount.update({
        where: { id: account.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }

    const tokens = await this.issueBuyerTokenPair(
      account.id,
      account.email,
      account.name,
      deviceInfo,
      account.passwordSet,
    );

    return {
      ...tokens,
      buyer: {
        id: account.id,
        email: account.email,
        name: account.name,
        hasPassword: account.passwordSet,
      },
    };
  }

  // ─── Refresh ──────────────────────────────────────────────────────────────────

  async refresh(incomingToken: string, deviceInfo?: BuyerDeviceInfo) {
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
    // typed for another realm (e.g. a staff refresh token) is rejected here.
    // Legacy tokens issued before this change carry no `type` — allow them
    // (grace) so live sessions are never force-logged-out. Defense-in-depth on
    // top of the per-table hash lookup below.
    if (payload.type && payload.type !== "buyer") {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    const tokenHash = this.hashToken(incomingToken);
    const stored = await this.prisma.buyerRefreshToken.findUnique({ where: { tokenHash } });

    if (!stored || stored.buyerAccountId !== payload.sub || stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token revoked or expired");
    }

    // Rotate — delete old, issue new pair
    await this.prisma.buyerRefreshToken.deleteMany({ where: { tokenHash } });

    const account = await this.prisma.buyerAccount.findUnique({ where: { id: payload.sub } });
    if (!account || account.status !== "ACTIVE" || account.deletedAt) {
      throw new UnauthorizedException("Account unavailable");
    }

    // Preserve device info from old token if not provided
    const effectiveDeviceInfo: BuyerDeviceInfo = deviceInfo ?? {
      userAgent: stored.userAgent ?? undefined,
      ipAddress: stored.ipAddress ?? undefined,
      deviceName: stored.deviceName ?? undefined,
    };

    const tokens = await this.issueBuyerTokenPair(
      account.id,
      account.email,
      account.name,
      effectiveDeviceInfo,
      account.passwordSet,
    );
    return {
      ...tokens,
      buyer: {
        id: account.id,
        email: account.email,
        name: account.name,
        hasPassword: account.passwordSet,
      },
    };
  }

  // ─── Logout ───────────────────────────────────────────────────────────────────

  async logout(buyerAccountId: string) {
    await this.prisma.buyerRefreshToken.deleteMany({ where: { buyerAccountId } });
    return { message: "Logged out successfully" };
  }

  // ─── Session management ───────────────────────────────────────────────────────

  async listSessions(buyerAccountId: string) {
    const sessions = await this.prisma.buyerRefreshToken.findMany({
      where: { buyerAccountId, expiresAt: { gt: new Date() } },
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

  async revokeSession(buyerAccountId: string, sessionId: string) {
    const session = await this.prisma.buyerRefreshToken.findUnique({ where: { id: sessionId } });
    if (!session || session.buyerAccountId !== buyerAccountId) {
      throw new ForbiddenException("Session not found");
    }
    await this.prisma.buyerRefreshToken.delete({ where: { id: sessionId } });
    return { message: "Session revoked" };
  }

  // ─── Delete account ───────────────────────────────────────────────────────────

  async deleteAccount(buyerAccountId: string) {
    // Soft delete account
    await this.prisma.buyerAccount.update({
      where: { id: buyerAccountId },
      data: { status: "DELETED", deletedAt: new Date() },
    });

    // Disconnect all active/pending links
    await this.prisma.customerLink.updateMany({
      where: {
        buyerAccountId,
        status: { notIn: ["DISCONNECTED"] },
      },
      data: {
        status: "DISCONNECTED",
        disconnectedBy: "BUYER",
        disconnectedAt: new Date(),
      },
    });

    // Revoke all refresh tokens
    await this.prisma.buyerRefreshToken.deleteMany({ where: { buyerAccountId } });

    this.logger.log(`BuyerAccount soft-deleted: ${buyerAccountId}`);
    return { message: "Account deleted. All seller connections have been removed." };
  }

  // ─── Change password ──────────────────────────────────────────────────────────

  async changePassword(buyerAccountId: string, currentPassword: string, newPassword: string) {
    const account = await this.prisma.buyerAccount.findUnique({ where: { id: buyerAccountId } });
    if (!account) throw new UnauthorizedException();

    const valid = await bcrypt.compare(currentPassword, account.passwordHash);
    if (!valid) throw new BadRequestException("Current password is incorrect");

    const sameAsOld = await bcrypt.compare(newPassword, account.passwordHash);
    if (sameAsOld) throw new BadRequestException("New password must differ from current password");

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.buyerAccount.update({
      where: { id: buyerAccountId },
      // passwordSet:true is defensive — proving the current password means it
      // was already a real one, but keep the invariant explicit.
      data: { passwordHash, passwordSet: true },
    });

    // Revoke all refresh tokens on password change
    await this.prisma.buyerRefreshToken.deleteMany({ where: { buyerAccountId } });

    return { message: "Password changed successfully" };
  }

  // ─── Set password (Google-only accounts) ──────────────────────────────────────

  /**
   * First-password setup for a signed-in Google-auto-created account
   * (passwordSet=false — its hash is a random placeholder nobody knows).
   * Refuses when a real password exists — overwriting one requires the
   * current-password proof in changePassword. The flag is checked against the
   * database, never a JWT claim, so a stale token can't authorize a takeover.
   * Note: accounts auto-created via Google BEFORE the passwordSet column
   * existed default to true and must use the email reset flow instead.
   */
  async setPassword(buyerAccountId: string, newPassword: string, deviceInfo?: BuyerDeviceInfo) {
    const account = await this.prisma.buyerAccount.findUnique({ where: { id: buyerAccountId } });
    if (!account || account.deletedAt || account.status !== "ACTIVE") {
      throw new UnauthorizedException();
    }

    if (account.passwordSet)
      throw new BadRequestException(
        "This account already has a password — use change password instead",
      );

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.buyerAccount.update({
      where: { id: buyerAccountId },
      data: { passwordHash, passwordSet: true },
    });

    // Revoke every session, then reissue a pair so the caller stays signed in
    // with a token that reflects hasPassword:true.
    await this.prisma.buyerRefreshToken.deleteMany({ where: { buyerAccountId } });
    const tokens = await this.issueBuyerTokenPair(
      account.id,
      account.email,
      account.name,
      deviceInfo,
      true,
    );

    // Fire-and-forget — email failures must not block the mutation.
    this.emailService
      .send({
        to: account.email,
        subject: "A password was set on your RouteFlow account",
        html: `<p>A password was just set on your RouteFlow portal account, which previously signed in with Google only.</p>
               <p><strong>Time:</strong> ${new Date().toUTCString()}</p>
               <p><strong>IP address:</strong> ${deviceInfo?.ipAddress ?? "unknown"}</p>
               <p>You can now sign in with your email and this password as well as with Google. If this wasn't you, reset your password immediately and contact support.</p>`,
        // email-connect-google PR-3: platform sender only — never a tenant mailbox/SMTP.
        senderClass: "platform",
      })
      .catch(() => {});

    return {
      message: "Password set successfully. All other sessions have been invalidated.",
      ...tokens,
      buyer: { id: account.id, email: account.email, name: account.name, hasPassword: true },
    };
  }

  // ─── Password reset (mirrors auth.service.ts RF-018) ──────────────────────────

  /**
   * Generates a single-use password reset token and emails a link to the buyer.
   * Always returns the same shape to prevent email enumeration.
   */
  async requestPasswordReset(email: string): Promise<{ message: string }> {
    const MSG = { message: "If that address is registered you will receive a reset link shortly." };

    const account = await this.prisma.buyerAccount.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!account || account.deletedAt || account.status !== "ACTIVE") return MSG;

    // Raw 32-byte random token
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    // Clean up any previous unexpired tokens for this buyer to avoid table bloat
    await this.prisma.buyerPasswordResetToken.deleteMany({
      where: { buyerAccountId: account.id, usedAt: null, expiresAt: { gt: new Date() } },
    });

    await this.prisma.buyerPasswordResetToken.create({
      data: { buyerAccountId: account.id, tokenHash, expiresAt },
    });

    // The base URL is resolved strictly server-side from config — accepting a
    // client-supplied URL here would let an attacker exfiltrate reset tokens.
    const urls = this.configService.get<AppConfig["urls"]>("urls")!;
    const resetUrl = `${urls.web}/buyer/reset-password?token=${rawToken}`;

    // B212-class fix: a real delivery failure for a real buyer used to leave
    // zero trace anywhere. Still fire-and-forget (NOT awaited): the response
    // text is the SAME fixed, enumeration-safe message regardless of delivery
    // outcome, and awaiting the send here would make a registered address
    // cost an extra SMTP/Resend round-trip that an unknown address never pays
    // for — a timing oracle on the one endpoint whose whole contract is
    // enumeration safety (review finding on PR #778). The attempt is logged,
    // just never blocks the response.
    this.emailService
      .send({
        to: account.email,
        subject: "Reset your RouteFlow password",
        html: `<p>Hi,</p>
<p>We received a request to reset the password for your RouteFlow portal account.</p>
<p><a href="${resetUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Reset password</a></p>
<p>This link expires in <strong>15 minutes</strong>. If you didn't request this, you can safely ignore this email — your password will not change.</p>`,
        // email-connect-google PR-3: platform sender only — never a tenant mailbox/SMTP.
        senderClass: "platform",
      })
      .then((sendResult) => {
        if (!sendResult.delivered) {
          this.logger.error(
            `Password reset email NOT delivered for buyer ${account.id} (${account.email}) — ` +
              `transport=${sendResult.transport} ` +
              `error=${sendResult.error ?? sendResult.smtpFallbackReason ?? "unknown"}.`,
          );
        }
      })
      .catch((err: Error) => {
        this.logger.error(
          `Failed to send password reset email for buyer ${account.id} (${account.email}): ${err.message}`,
        );
      });

    return MSG;
  }

  /**
   * Validates a reset token, updates the buyer's password, and invalidates all
   * existing refresh tokens so active sessions are force-logged-out. Also flips
   * passwordSet:true — this is the supported "claim a password" path for buyer
   * accounts auto-created via Google before the passwordSet column existed.
   */
  async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
    const tokenHash = this.hashToken(token);
    const record = await this.prisma.buyerPasswordResetToken.findUnique({ where: { tokenHash } });

    if (!record) throw new BadRequestException("Reset link is invalid or has already been used.");
    if (record.usedAt) throw new BadRequestException("Reset link has already been used.");
    if (record.expiresAt < new Date()) throw new BadRequestException("Reset link has expired.");

    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Mark token used and update password in a transaction
    await this.prisma.$transaction([
      this.prisma.buyerPasswordResetToken.update({
        where: { tokenHash },
        data: { usedAt: new Date() },
      }),
      this.prisma.buyerAccount.update({
        where: { id: record.buyerAccountId },
        data: { passwordHash, passwordSet: true },
      }),
      this.prisma.buyerRefreshToken.deleteMany({
        where: { buyerAccountId: record.buyerAccountId },
      }),
    ]);

    return { message: "Password reset successfully. Please log in with your new password." };
  }

  // ─── Get profile ──────────────────────────────────────────────────────────────

  async getProfile(buyerAccountId: string) {
    const account = await this.prisma.buyerAccount.findUnique({
      where: { id: buyerAccountId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        mobile: true,
        emailVerified: true,
        createdAt: true,
        googleId: true,
        passwordSet: true,
      },
    });
    if (!account) throw new UnauthorizedException();
    const { googleId, passwordSet, ...rest } = account;
    // Authoritative hasPassword read — JWT claims go stale after a set/reset.
    return { ...rest, googleLinked: !!googleId, hasPassword: passwordSet };
  }

  async updateProfile(
    buyerAccountId: string,
    dto: { name?: string; phone?: string; mobile?: string },
  ) {
    return this.prisma.buyerAccount.update({
      where: { id: buyerAccountId },
      data: dto,
      select: { id: true, email: true, name: true, phone: true, mobile: true, emailVerified: true },
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  /** Mirrors AuthService: 10 consecutive failures → 15-minute lock. */
  static readonly LOCKOUT_THRESHOLD = 10;
  static readonly LOCKOUT_WINDOW_MS = 15 * 60_000;

  private async recordFailedLogin(
    buyerAccountId: string,
    priorFailures: number,
    lockedUntil: Date | null,
  ) {
    // An expired lock starts a fresh streak (otherwise one failure re-locks).
    const lockExpired = lockedUntil != null && lockedUntil <= new Date();
    const attempts = lockExpired ? 1 : (priorFailures || 0) + 1;
    const lockNow = attempts >= BuyerAuthService.LOCKOUT_THRESHOLD;
    await this.prisma.buyerAccount.update({
      where: { id: buyerAccountId },
      data: lockNow
        ? {
            failedLoginAttempts: 0,
            lockedUntil: new Date(Date.now() + BuyerAuthService.LOCKOUT_WINDOW_MS),
          }
        : { failedLoginAttempts: attempts, ...(lockExpired ? { lockedUntil: null } : {}) },
    });
  }

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private async storeBuyerRefreshToken(
    buyerAccountId: string,
    token: string,
    deviceInfo?: BuyerDeviceInfo,
  ) {
    const tokenHash = this.hashToken(token);
    const decoded = this.jwtService.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);
    await this.prisma.buyerRefreshToken.upsert({
      where: { tokenHash },
      create: {
        buyerAccountId,
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

  async issueBuyerTokenPair(
    buyerAccountId: string,
    email: string,
    name: string = "",
    deviceInfo?: BuyerDeviceInfo,
    hasPassword: boolean = true,
  ) {
    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

    const payload: BuyerJwtPayload = {
      sub: buyerAccountId,
      email,
      name,
      type: "BUYER",
      hasPassword,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.expiresIn as any,
    });

    const refreshToken = this.jwtService.sign(
      // F5-003: tag buyer refresh tokens with a realm discriminator so a staff
      // refresh token can never be replayed on the buyer refresh path.
      { sub: buyerAccountId, type: "buyer" },
      { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn as any },
    );

    await this.storeBuyerRefreshToken(buyerAccountId, refreshToken, deviceInfo);

    return { accessToken, refreshToken };
  }
}
