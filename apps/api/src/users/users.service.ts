import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { User, UserRole } from "@prisma/client";
import * as crypto from "crypto";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { AppConfig } from "../config/configuration";
import { ListUsersDto } from "./dto/list-users.dto";
import { CreateOperatorDto } from "./dto/create-operator.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { ChangeUserStatusDto } from "./dto/change-user-status.dto";

/** How long a staff invite / admin-reset set-password link stays valid (NOTIFY-SPEC N2). */
const SET_PASSWORD_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly configService: ConfigService<AppConfig>,
  ) {}

  /** Hash a raw token with SHA-256 for storage — same shape as auth.service.ts's and
   *  buyer-auth.service.ts's own copies (no shared helper exists in this codebase yet). */
  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  /**
   * Creates a single-use, 72h PasswordResetToken (the same model/consuming endpoint as
   * self-service password reset — POST /auth/reset-password) and emails a set-password
   * link. Used by both createOperator (staff invite) and resetPassword (admin-triggered).
   * Fails closed: a delivery failure is logged, never thrown — the caller's own action
   * (account created / password reset) always succeeds regardless of email delivery.
   */
  private async sendSetPasswordInvite(userId: string, to: string, username: string): Promise<void> {
    try {
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = this.hashToken(rawToken);
      const expiresAt = new Date(Date.now() + SET_PASSWORD_TOKEN_TTL_MS);

      await this.prisma.passwordResetToken.deleteMany({
        where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
      });
      await this.prisma.passwordResetToken.create({ data: { userId, tokenHash, expiresAt } });

      const urls = this.configService.get<AppConfig["urls"]>("urls")!;
      const setPasswordUrl = `${urls.web}/reset-password?token=${rawToken}`;
      const result = await this.email.sendSetPasswordEmail({
        to,
        username,
        setPasswordUrl,
        expiryHours: SET_PASSWORD_TOKEN_TTL_MS / (60 * 60 * 1000),
      });
      if (!result.delivered) {
        this.logger.error(
          `Set-password email NOT delivered for user ${userId} (${to}): transport=${result.transport} error=${result.error ?? "unknown"}.`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to send set-password email for user ${userId} (${to}): ${(err as Error).message}`,
      );
    }
  }

  async findByUsername(username: string, tenantId?: string | null): Promise<User | null> {
    // Accept either username or email in the login field
    return this.prisma.forTenant().user.findFirst({
      where: {
        OR: [
          { username, tenantId: tenantId ?? null },
          { email: username, tenantId: tenantId ?? null },
        ],
      },
    });
  }

  /**
   * Cross-tenant email lookup — used as fallback when no tenant cookie is present.
   * Finds a user by email across ALL tenants. Returns null if zero or multiple matches
   * (ambiguous), so login is only allowed when the email is globally unique.
   */
  async findByEmailCrossTenant(email: string): Promise<User | null> {
    const matches = await this.prisma.user.findMany({
      where: { email, deletedAt: null, status: "ACTIVE" },
      take: 2, // we only need to know if there's 0, 1, or 2+
    });
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * Cross-tenant username lookup — fallback for username-based logins with a stale cookie.
   * Returns null if zero or multiple matches (common usernames like "admin" exist in
   * multiple tenants and won't trigger the fallback — user must use email instead).
   */
  async findByUsernameCrossTenant(username: string): Promise<User | null> {
    const matches = await this.prisma.user.findMany({
      where: { username, deletedAt: null, status: "ACTIVE" },
      take: 2,
    });
    return matches.length === 1 ? matches[0] : null;
  }

  async findById(
    id: string,
  ): Promise<
    (Omit<User, "password" | "googleId"> & { googleLinked: boolean; hasPassword: boolean }) | null
  > {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id } });
    if (!user) return null;
    const { password, googleId, ...rest } = user;
    return { ...rest, googleLinked: !!googleId, hasPassword: !!password };
  }

  async findAll(query: ListUsersDto) {
    const { search, status, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = {
      role: { not: UserRole.CUSTOMER },
    };
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { username: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.forTenant().user.findMany({
        where,
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          status: true,
          forcePasswordChange: true,
          isAdmin: true,
          canActAsDriver: true,
          createdAt: true,
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.forTenant().user.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async createOperator(dto: CreateOperatorDto) {
    const [existingEmail, existingUsername] = await Promise.all([
      this.prisma.forTenant().user.findFirst({ where: { email: dto.email } }),
      this.prisma.forTenant().user.findFirst({ where: { username: dto.username } }),
    ]);
    if (existingEmail) throw new BadRequestException("Email already in use");
    if (existingUsername) throw new BadRequestException("Username already in use");

    const tempPassword = `${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const user = await this.prisma.forTenant().user.create({
      data: {
        email: dto.email,
        username: dto.username,
        password: hashedPassword,
        role: UserRole.OPERATOR,
        forcePasswordChange: true,
      },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        status: true,
        forcePasswordChange: true,
      },
    });

    await this.sendSetPasswordInvite(user.id, user.email, user.username);

    return { user, tempPassword };
  }

  async changeStatus(userId: string, dto: ChangeUserStatusDto) {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    return this.prisma.forTenant().user.update({
      where: { id: userId },
      data: { status: dto.status },
      select: { id: true, username: true, email: true, role: true, status: true },
    });
  }

  async updateUser(userId: string, dto: UpdateUserDto, changedByUsername?: string) {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");

    // Prevent changing role of TENANT_ADMIN users
    if (user.role === UserRole.TENANT_ADMIN && dto.role && dto.role !== UserRole.TENANT_ADMIN) {
      throw new ForbiddenException("Cannot change the role of the tenant admin.");
    }

    // Only allow OPERATOR or DRIVER roles when changing role
    if (
      dto.role &&
      dto.role !== user.role &&
      dto.role !== UserRole.OPERATOR &&
      dto.role !== UserRole.DRIVER
    ) {
      throw new BadRequestException("Users can only be assigned OPERATOR or DRIVER roles.");
    }

    // N2 review fix: normalize BEFORE compare and write — a case-only edit
    // ("Acme@Example.com" -> "acme@example.com") must not read as a change (it
    // fires both notices for nothing) and must not persist inconsistently with
    // every other email lookup in this codebase, which is case-sensitive as
    // stored.
    const normalizedEmail = dto.email ? dto.email.trim().toLowerCase() : dto.email;

    const previousEmail = user.email;
    const previousRole = user.role;
    const emailChanged = !!normalizedEmail && normalizedEmail !== previousEmail;
    const roleChanged = !!dto.role && dto.role !== previousRole;

    const updated = await this.prisma.forTenant().user.update({
      where: { id: userId },
      data: { ...dto, email: normalizedEmail },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        status: true,
        isAdmin: true,
        canActAsDriver: true,
      },
    });

    // Best-effort account notices (NOTIFY-SPEC N2) — never let a delivery failure
    // undo or block an update that has already committed.
    if (emailChanged) {
      await this.notifyEmailChanged(userId, previousEmail, updated.email, updated.username);
    }
    if (roleChanged) {
      await this.notifyRoleChanged(
        userId,
        updated.email,
        updated.username,
        previousRole,
        updated.role,
        changedByUsername ?? "an administrator",
      );
    }

    return updated;
  }

  /** Notice to the OLD address (always) + confirmation to the NEW address (notice-only —
   *  see NOTIFY-SPEC N2: real hold-until-verified gating is a follow-up, not this PR;
   *  tenants.service.ts:155's JWT verification flow is registration-specific and holds
   *  no pending-email state to reuse for an in-place change without adding that state). */
  private async notifyEmailChanged(
    userId: string,
    previousEmail: string | null,
    newEmail: string | null,
    username: string,
  ): Promise<void> {
    if (!newEmail) return;
    try {
      if (previousEmail) {
        const result = await this.email.sendEmailChangedNotice({
          to: previousEmail,
          username,
          newEmail,
        });
        if (!result.delivered) {
          this.logger.error(
            `Email-changed notice NOT delivered to old address for user ${userId}.`,
          );
        }
      }
      const confirmResult = await this.email.sendEmailChangeConfirmation({
        to: newEmail,
        username,
      });
      if (!confirmResult.delivered) {
        this.logger.error(
          `Email-change confirmation NOT delivered to new address for user ${userId}.`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to send email-change notices for user ${userId}: ${(err as Error).message}`,
      );
    }
  }

  private async notifyRoleChanged(
    userId: string,
    to: string | null,
    username: string,
    oldRole: UserRole,
    newRole: UserRole,
    changedBy: string,
  ): Promise<void> {
    if (!to) return;
    try {
      const result = await this.email.sendRoleChangedNotice({
        to,
        username,
        oldRole,
        newRole,
        changedBy,
      });
      if (!result.delivered) {
        this.logger.error(`Role-changed notice NOT delivered for user ${userId}.`);
      }
    } catch (err) {
      this.logger.error(
        `Failed to send role-changed notice for user ${userId}: ${(err as Error).message}`,
      );
    }
  }

  async unlockUser(userId: string) {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    await this.prisma.forTenant().user.update({
      where: { id: userId },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
    return { id: userId, unlocked: true };
  }

  async resetPassword(userId: string) {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    const tempPassword = `${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    await this.prisma.forTenant().user.update({
      where: { id: userId },
      data: { password: hashedPassword, forcePasswordChange: true },
    });

    // N2 review fix: never email a set-password link for a deactivated/deleted
    // account — an admin resetting a SUSPENDED/INACTIVE user's password (e.g. to
    // lock them out) must not hand them a working way back in.
    if (user.email && user.status === "ACTIVE" && !user.deletedAt) {
      await this.sendSetPasswordInvite(userId, user.email, user.username);
    }

    return { tempPassword };
  }

  async toggleAdmin(userId: string, callerIsAdmin: boolean) {
    if (!callerIsAdmin) {
      throw new ForbiddenException("Only admins can assign admin rights.");
    }
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    if (user.role !== UserRole.OPERATOR) {
      throw new BadRequestException("Admin rights can only be assigned to operators.");
    }
    return this.prisma.forTenant().user.update({
      where: { id: userId },
      data: { isAdmin: !user.isAdmin },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        status: true,
        isAdmin: true,
        canActAsDriver: true,
      },
    });
  }

  async toggleDriverPermit(userId: string) {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    if (user.role !== UserRole.OPERATOR && user.role !== UserRole.TENANT_ADMIN) {
      throw new BadRequestException("Driver permit can only be assigned to operators.");
    }

    const newValue = !user.canActAsDriver;

    // Auto-create Driver record if enabling and no driver record exists
    if (newValue) {
      const existingDriver = await this.prisma.forTenant().driver.findFirst({
        where: { userId: user.id },
      });
      if (!existingDriver) {
        await this.prisma.forTenant().driver.create({
          data: {
            userId: user.id,
            contactName: user.username,
            phone: "",
            status: "ACTIVE",
          },
        });
      }
    }

    return this.prisma.forTenant().user.update({
      where: { id: userId },
      data: { canActAsDriver: newValue },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        status: true,
        isAdmin: true,
        canActAsDriver: true,
      },
    });
  }

  async getPreferences(userId: string): Promise<Record<string, string>> {
    const prefs = await this.prisma.forTenant().userPreference.findMany({ where: { userId } });
    return Object.fromEntries(prefs.map((p) => [p.key, p.value]));
  }

  async setPreference(userId: string, key: string, value: string): Promise<void> {
    await this.prisma.forTenant().userPreference.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, value },
      update: { value },
    });
  }

  async setPreferences(userId: string, prefs: Record<string, string>): Promise<void> {
    await Promise.all(
      Object.entries(prefs).map(([key, value]) => this.setPreference(userId, key, value)),
    );
  }
}
