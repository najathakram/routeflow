import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { OPERATOR_DEFAULT_DENIED_GROUPS } from "../auth/permissions/operator-default-denied";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { SUPPORT_SESSION_REFUSAL_MESSAGE } from "../auth/guards/no-impersonation.guard";
import { assertNotWalkIn } from "../customers/walk-in-protected";
import { assertMayChangeAccount } from "./admin-account-protection";
import { ConfigService } from "@nestjs/config";
import { User, UserRole, UserStatus } from "@prisma/client";
import * as crypto from "crypto";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { AddonService } from "../billing/addon.service";
import { ensureDriverRow, retireDriverRow } from "../drivers/drivers.service";
import { EmailService } from "../email/email.service";
import { AppConfig } from "../config/configuration";
import { ListUsersDto } from "./dto/list-users.dto";
import { CreateOperatorDto } from "./dto/create-operator.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { ChangeUserStatusDto } from "./dto/change-user-status.dto";
import { issueSetPasswordLink } from "./set-password-token";
import { hasActiveBuyerLink } from "./also-buyer";
import { revokeUserEmailChanges, revokeUserLinkTokens } from "../auth/link-token-revocation";
import {
  EMAIL_CHANGE_LINK_TTL_MS,
  emailChangeNeedsHold,
  issueEmailChange,
  maskEmail,
} from "./email-change";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly configService: ConfigService<AppConfig>,
    // SA-778: records a refused support-session identity edit. Optional so a bare unit module still builds.
    @Optional() private readonly audit?: AuditService,
    // B862 / SA-1171 K3: read only, to log what the route add-on gate WOULD decide at the two driver-row sites.
    @Optional() private readonly addons?: AddonService,
  ) {}

  /**
   * B862 / SA-1171 K3: the add-on gate on the two driver-row sites that predate it (role edit to DRIVER, driver permit)
   * ships DARK: one structured log line when ANY-of the three route add-ons is off, and the write goes ahead. It flips to
   * refusing only in a separate diff, after the owner runs report-addon-gate-blast-radius.mjs (CLAUDE.md). Never throws.
   */
  private async observeDriverRowGate(site: string, tenantId: string | null | undefined) {
    if (!this.addons || !tenantId) return;
    try {
      const held = await Promise.all(
        ["recurring_routes", "order_delivery", "developer_mode"].map((k) =>
          this.addons!.hasAddon(tenantId, k),
        ),
      );
      if (!held.some(Boolean)) {
        this.logger.warn(`driver-row gate would refuse site=${site} tenant=${tenantId}`);
      }
    } catch {
      /* observe only: a failed read never blocks the write */
    }
  }

  /**
   * SA-1096: the ONE rule for issuing a set-password link to an account: it has an address, is ACTIVE and is not
   * deleted. A link minted while the account is off survives to its reactivation, which hands a locked-out person
   * a way back in (the admin reset's N2 rule). Every issuer in this service asks here.
   */
  private mayMintInvite(account: {
    email: string | null;
    status: string;
    deletedAt?: Date | null;
  }): boolean {
    return !!account.email && account.status === "ACTIVE" && !account.deletedAt;
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
      const urls = this.configService.get<AppConfig["urls"]>("urls")!;
      const link = await issueSetPasswordLink(this.prisma, userId, urls.web);
      const result = await this.email.sendSetPasswordEmail({
        to,
        username,
        setPasswordUrl: link.url,
        expiryHours: link.expiryHours,
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

  /**
   * The ONE N2 #811 rule for a fresh set-password invite: an account still owing a first password
   * (`forcePasswordChange`) that `mayMintInvite` allows gets one, to its CURRENT address. Best-effort (a delivery
   * failure is logged, never thrown). The at-once email write, the role change, the admin toggle, the admin reset and
   * the email-change confirm (`AuthService`) all ask here.
   */
  async sendInviteIfOwed(account: {
    id: string;
    email: string | null;
    username: string;
    status: string;
    deletedAt?: Date | null;
    forcePasswordChange?: boolean;
  }): Promise<void> {
    if (!account.forcePasswordChange || !account.email || !this.mayMintInvite(account)) return;
    await this.sendSetPasswordInvite(account.id, account.email, account.username);
  }

  async findByUsername(username: string, tenantId?: string | null): Promise<User | null> {
    // Accept either username or email in the login field. Email match is
    // case-insensitive (N2 review fix, #811) — updateUser now lowercases a
    // stored email going forward, but neither web nor mobile lowercases the
    // identifier before sending a login request, so an existing user whose
    // email carries any uppercase (pre-dating that normalization, or an
    // admin who typed "Name@Acme.com" into the login field) must still be
    // found. Username stays exact-match — usernames are not email addresses
    // and are not normalized anywhere else in this codebase.
    return this.prisma.forTenant().user.findFirst({
      where: {
        OR: [
          { username, tenantId: tenantId ?? null },
          { email: { equals: username, mode: "insensitive" }, tenantId: tenantId ?? null },
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

  /**
   * B461 (SA-1116): the NEW address each of these users is waiting to confirm (a live, unexpired `UserEmailChange`
   * row), by user id. A user with none is absent from the map. The ids come from a tenant-scoped read the caller did.
   */
  private async pendingEmails(userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.userEmailChange.findMany({
      where: { userId: { in: userIds }, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "asc" },
      select: { userId: true, toEmail: true },
    });
    // oldest first, so a newer row (there is at most one live row per user) wins
    return new Map(rows.map((r) => [r.userId, r.toEmail]));
  }

  async findById(id: string): Promise<
    | (Omit<User, "password" | "googleId" | "deniedPermissionGroups" | "permissionsVersion"> & {
        googleLinked: boolean;
        hasPassword: boolean;
        pendingEmail: string | null;
      })
    | null
  > {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id } });
    if (!user) return null;
    // The feature-group columns are reported by the admin listing and GET /users/me/permissions only.
    const {
      password,
      googleId,
      deniedPermissionGroups: _deniedPermissionGroups,
      permissionsVersion: _permissionsVersion,
      ...rest
    } = user;
    const pending = await this.pendingEmails([id]);
    return {
      ...rest,
      googleLinked: !!googleId,
      hasPassword: !!password,
      pendingEmail: pending.get(id) ?? null,
    };
  }

  /**
   * W-839 / SA-937: GET /users/me only. The caller's own record (findById) plus `alsoBuyer`: is this staff user also an
   * ACTIVE buyer of their own tenant (`hasActiveBuyerLink`, on the STORED email and tenant). Never in findById, which also
   * serves admins' GET /users/:id, and never on a list (MUST 2). Boolean only (MUST 4).
   */
  async getMe(id: string) {
    const user = await this.findById(id);
    if (!user) return null;
    const alsoBuyer = await hasActiveBuyerLink(this.prisma, {
      email: user.email,
      tenantId: user.tenantId,
    });
    return { ...user, alsoBuyer };
  }

  /**
   * `callerRole` decides whether each row carries the feature-group columns: an account admin (or the
   * platform super admin) gets `deniedPermissionGroups` + `permissionsVersion`, every other caller does not.
   */
  async findAll(query: ListUsersDto, callerRole?: UserRole) {
    const { search, status, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const includePermissions =
      callerRole === UserRole.TENANT_ADMIN || callerRole === UserRole.SUPER_ADMIN;
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
          ...(includePermissions ? { deniedPermissionGroups: true, permissionsVersion: true } : {}),
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.forTenant().user.count({ where }),
    ]);

    const pending = await this.pendingEmails(data.map((u) => u.id));
    return {
      data: data.map((u) => ({ ...u, pendingEmail: pending.get(u.id) ?? null })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async createOperator(dto: CreateOperatorDto) {
    // B862 / SA-1171 K2: a driver account needs a driver profile, so it is created from the Drivers page (one writer).
    if (dto.role === UserRole.DRIVER) {
      throw new BadRequestException({
        code: API_ERROR_CODES.DRIVER_VIA_DRIVERS_PAGE,
        message: "Add a driver from the Drivers page.",
      });
    }
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

  async changeStatus(
    userId: string,
    dto: ChangeUserStatusDto,
    callerRole: UserRole,
    callerId?: string,
  ) {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    assertMayChangeAccount(user, callerRole);
    await this.assertNotWalkInAccount(userId);
    const deactivating = dto.status !== UserStatus.ACTIVE;
    // Perms PR1 M2: a workspace can never lock itself out of account administration.
    if (deactivating && callerId && userId === callerId) {
      throw new ConflictException({
        code: API_ERROR_CODES.SELF_DEACTIVATION_REFUSED,
        message: "You can't deactivate your own account. Ask another admin to do it.",
      });
    }
    const select = { id: true, username: true, email: true, role: true, status: true } as const;
    if (!(
      deactivating &&
      user.role === UserRole.TENANT_ADMIN &&
      user.status === UserStatus.ACTIVE
    )) {
      // F03 slice 2 (SA-1096): a deactivated account's live reset/verify links die in the same transaction.
      return this.prisma.tenantTransaction(async (tx) => {
        const updated = await tx.user.update({
          where: { id: userId },
          data: { status: dto.status },
          select,
        });
        if (deactivating) await revokeUserLinkTokens(tx, userId);
        return updated;
      });
    }
    // Deactivating an active admin: read the tenant's active admins FOR UPDATE inside the same transaction as the
    // write, so two admins deactivating each other at once serialize and the second sees the first's change.
    const tenantId = this.prisma.getTenantId();
    return this.prisma.tenantTransaction(async (tx) => {
      const admins = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "User"
        WHERE "tenantId" = ${tenantId} AND role = 'TENANT_ADMIN' AND status = 'ACTIVE' AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (!admins.some((a) => a.id !== userId)) {
        throw new ConflictException({
          code: API_ERROR_CODES.LAST_TENANT_ADMIN,
          message:
            "This is the workspace's only active admin. Make someone else an admin before deactivating this account.",
        });
      }
      const updated = await tx.user.update({
        where: { id: userId },
        data: { status: dto.status },
        select,
      });
      await revokeUserLinkTokens(tx, userId);
      return updated;
    });
  }

  async updateUser(
    userId: string,
    dto: UpdateUserDto,
    changedByUsername: string | undefined,
    callerRole: UserRole,
    impersonatedBy?: string,
    requestedByUserId?: string,
  ) {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    // Only an ACTUAL change of the sign-in identity (email or username) on an admin account is guarded: the
    // edit form always sends both, so an unchanged value must pass.
    // ONE normalized comparison drives the guard, the write and every email side effect below.
    const normalizedEmail = dto.email ? dto.email.trim().toLowerCase() : dto.email;
    const emailEdit =
      !!normalizedEmail && normalizedEmail !== (user.email ?? "").trim().toLowerCase();
    // Login matches usernames EXACTLY (findByUsername), so only padding is normalized: trim, never lowercase.
    const normalizedUsername = dto.username !== undefined ? dto.username.trim() : undefined;
    const usernameEdit =
      normalizedUsername !== undefined && normalizedUsername !== (user.username ?? "").trim();
    // SA-778: a support session may not change a sign-in identity (an email is the way to a reset link in its
    // own inbox; a username is how the account is found at login).
    if ((emailEdit || usernameEdit) && impersonatedBy != null) {
      await this.audit?.log({
        tenantId: user.tenantId ?? null,
        userId: null,
        impersonatedBy,
        action: AUDIT_ACTIONS.IMPERSONATION_ACTION_REFUSED,
        entityType: "account",
        entityId: userId,
        meta: {
          superAdminId: impersonatedBy,
          tenantId: user.tenantId ?? null,
          method: "PATCH",
          route: "/users/:id",
        },
      });
      throw new ForbiddenException({
        code: API_ERROR_CODES.IMPERSONATION_NOT_ALLOWED,
        message: SUPPORT_SESSION_REFUSAL_MESSAGE,
      });
    }
    if (emailEdit || usernameEdit) assertMayChangeAccount(user, callerRole);
    if (emailEdit || usernameEdit || (dto.role && dto.role !== user.role)) {
      await this.assertNotWalkInAccount(userId);
    }

    // Prevent changing role of TENANT_ADMIN users
    if (user.role === UserRole.TENANT_ADMIN && dto.role && dto.role !== UserRole.TENANT_ADMIN) {
      throw new ForbiddenException("Cannot change the role of the tenant admin.");
    }

    // B862: a CUSTOMER login is a buyer's account, never a driver. Handing it the DRIVER role would give it a Driver row
    // (ensureDriverRow), and a later customer delete or merge would then fail on Driver_userId_fkey. The list excludes
    // CUSTOMER, so only a direct API call reaches this. CUSTOMER -> OPERATOR stays allowed (SA-1050 A5-2 pins it).
    if (user.role === UserRole.CUSTOMER && dto.role === UserRole.DRIVER) {
      throw new BadRequestException("A customer login cannot be made a driver.");
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

    // N2 review fix: a case-only or padding-only edit ("Acme@Example.com" -> "acme@example.com")
    // is not a change: it fires no notices and does not rewrite the stored email.
    const previousEmail = user.email;
    const previousRole = user.role;
    const emailChanged = emailEdit;
    // B461 (SA-1116): an email edit on an account that has signed in does not write the email. The new address is held
    // in a `UserEmailChange` row until the NEW mailbox confirms (`AuthService.confirmEmailChange`). A user who has
    // never signed in is written at once, as before: the set-password invite sent to the corrected address is the proof.
    const holdEmail = emailChanged && (await emailChangeNeedsHold(this.prisma, user));
    const emailWritten = emailChanged && !holdEmail;
    if (holdEmail && (user.status !== "ACTIVE" || user.deletedAt)) {
      // The confirm needs an ACTIVE account (its CAS), so a link for this one could never be used. Nothing is written.
      throw new ConflictException({
        code: API_ERROR_CODES.EMAIL_CHANGE_ACCOUNT_INACTIVE,
        message: "Reactivate this account, then change its email.",
      });
    }
    if (holdEmail) {
      // Refuse a taken address now, not a day later when the owner of the new mailbox clicks. The unique index at
      // confirm time stays the backstop for a race. `insensitive`: the same comparison the N2 normalisation makes. No
      // `deletedAt` filter: `@@unique([tenantId, email])` covers a soft-deleted row too.
      const taken = await this.prisma.forTenant().user.findFirst({
        where: {
          id: { not: userId },
          email: { equals: normalizedEmail as string, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException({
          code: API_ERROR_CODES.EMAIL_TAKEN,
          message: "This address is already used by another account.",
        });
      }
    }
    const roleChanged = !!dto.role && dto.role !== previousRole;
    if (roleChanged && dto.role === UserRole.DRIVER) {
      await this.observeDriverRowGate("updateUser", user.tenantId);
    }

    // SA-1050 A-5: a row that ENTERS the operator role starts without the groups the owner keeps off by default.
    // The server decides this from the stored row, never from the DTO; a row that already denies every one of them
    // writes neither the list nor the version.
    const deniedNow = user.deniedPermissionGroups ?? [];
    const defaultDenied =
      roleChanged && dto.role === UserRole.OPERATOR
        ? OPERATOR_DEFAULT_DENIED_GROUPS.filter((g) => !deniedNow.includes(g))
        : [];

    // An EXPLICIT field pick, never a spread of the body (SA-726 M5): whatever a caller manages to put on
    // the DTO, only the role, email and username come from it. `status`, `canActAsDriver` and `tenantId` have
    // their own endpoints, and the permission columns are written only by the server: the default-denied groups
    // above, with the version bump that every write to the deny list carries. Email and username are omitted
    // unless they actually changed; a change writes the normalized value.
    const data = {
      ...(dto.role !== undefined ? { role: dto.role } : {}),
      ...(defaultDenied.length > 0
        ? {
            deniedPermissionGroups: { push: [...defaultDenied] },
            permissionsVersion: { increment: 1 },
          }
        : {}),
      ...(emailWritten ? { email: normalizedEmail } : {}),
      ...(usernameEdit ? { username: normalizedUsername } : {}),
    };
    // F03 slice 2 (SA-1096): the write and the burn of the account's live links are ONE transaction, so a crash
    // between them can never leave a link that outlives the identity or role it was minted for.
    const {
      row: updated,
      changeToken,
      fromEmail,
    } = await this.prisma.tenantTransaction(async (tx) => {
      // B862 / SA-1171 K4: off DRIVER. A driver with an open run is refused (no silent unassign: the Drivers page moves
      // the run first); otherwise the row goes INACTIVE so the picker stops listing someone who no longer drives. A
      // dual-role person (canActAsDriver) keeps their row.
      if (roleChanged && previousRole === UserRole.DRIVER && !user.canActAsDriver) {
        await retireDriverRow(tx, userId);
      }
      const row = await tx.user.update({
        where: { id: userId },
        data,
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          status: true,
          isAdmin: true,
          canActAsDriver: true,
          forcePasswordChange: true,
        },
      });
      if (emailWritten || roleChanged) await revokeUserLinkTokens(tx, userId);
      // B862 / SA-1171 K1: a user who becomes a DRIVER gets their Driver row in this same transaction (one writer).
      if (roleChanged && dto.role === UserRole.DRIVER)
        await ensureDriverRow(tx, { ...row, tenantId: user.tenantId });
      // The hold's row is written AFTER the burn above, so a role change in the same edit cannot burn it. It burns the
      // user's older change rows itself: a newer request supersedes an older one.
      let changeToken: string | null = null;
      let fromEmail = user.email;
      if (holdEmail) {
        // The row records the address as it stands once the User row is locked, not the pre-transaction snapshot.
        await tx.$executeRaw`SELECT 1 FROM "User" WHERE id = ${userId} FOR UPDATE`;
        const now = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
        fromEmail = now?.email ?? user.email;
        // A set-password or reset link mailed to the OLD address dies with the hold, as it does on an at-once write: an
        // admin who corrects a mistyped address must not leave a live link in the wrong inbox. Burn only, never a
        // write to the sign-up table, so B448 stays closed. It also burns older change rows; the new row comes after.
        await revokeUserLinkTokens(tx, userId);
        // Someone already moved it to this very address: nothing to hold (the row's CHECK would refuse from = to).
        if (fromEmail.trim().toLowerCase() !== normalizedEmail) {
          changeToken = await issueEmailChange(tx, {
            userId,
            fromEmail,
            toEmail: normalizedEmail as string,
            requestedByUserId: requestedByUserId ?? userId,
          });
        }
      }
      return { row, changeToken, fromEmail };
    });

    // Best-effort account notices (NOTIFY-SPEC N2) — never let a delivery failure
    // undo or block an update that has already committed.
    if (holdEmail && changeToken) {
      await this.notifyEmailChangeRequested(
        userId,
        fromEmail,
        normalizedEmail as string,
        updated.username,
        changeToken,
      );
    }
    if (emailWritten) {
      // N2 review fix (#811 merge-session finding): a set-password invite link sent to
      // a mistyped address must not keep working after the admin corrects the email —
      // otherwise the wrong recipient can still set a password and log in. The burn above covers
      // any outstanding token; then — only if the user has never set their own password — mint and
      // send a fresh one to the corrected address so they aren't left with no way in at all.
      await this.notifyEmailChanged(userId, previousEmail, updated.email, updated.username);
      await this.sendInviteIfOwed({ ...updated, deletedAt: user.deletedAt });
    }
    if (roleChanged) {
      // A link minted for the old role does not carry over to the new one (burned above).
      await this.notifyRoleChanged(
        userId,
        updated.email,
        updated.username,
        previousRole,
        updated.role,
        changedByUsername ?? "an administrator",
      );
      // The same rule as the email branch: a person who has never set a password is not left with a dead first mail.
      if (!emailWritten) await this.sendInviteIfOwed({ ...updated, deletedAt: user.deletedAt });
    }

    // The user as it stands, plus the address it is waiting on. A write at once burned any pending row (above).
    const pendingEmail = changeToken
      ? (normalizedEmail as string)
      : emailWritten
        ? null
        : ((await this.pendingEmails([userId])).get(userId) ?? null);
    return { ...updated, pendingEmail };
  }

  /**
   * B461 (SA-1116): the mails of a held change. The NEW address gets the confirm link; the OLD address is told a
   * change was requested, with the new address masked, and that ignoring it keeps the address. Best-effort, like every
   * account notice: a delivery failure never undoes the committed row.
   */
  private async notifyEmailChangeRequested(
    userId: string,
    oldEmail: string,
    newEmail: string,
    username: string,
    token: string,
  ): Promise<void> {
    try {
      const urls = this.configService.get<AppConfig["urls"]>("urls")!;
      const confirmUrl = `${urls.web.replace(/\/+$/, "")}/confirm-email-change?token=${token}`;
      const link = await this.email.sendEmailChangeLink({
        to: newEmail,
        username,
        confirmUrl,
        expiryHours: EMAIL_CHANGE_LINK_TTL_MS / (60 * 60 * 1000),
      });
      if (!link.delivered) {
        this.logger.error(`Email-change link NOT delivered to the new address for user ${userId}.`);
      }
      const notice = await this.email.sendEmailChangeRequestedNotice({
        to: oldEmail,
        username,
        maskedNewEmail: maskEmail(newEmail),
      });
      if (!notice.delivered) {
        this.logger.error(
          `Email-change request notice NOT delivered to the old address for user ${userId}.`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to send email-change request mails for user ${userId}: ${(err as Error).message}`,
      );
    }
  }

  /** Notice to the OLD address (always) + confirmation to the NEW address, for an email written AT ONCE (a user who
   *  has never signed in). An email on an account that has signed in is held until the new address confirms
   *  (B461, `notifyEmailChangeRequested`); the same two notices go out when that confirm lands. */
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

  /** The walk-in customer's login account stays as it is: refuse before any write (WALK_IN_PROTECTED). */
  private async assertNotWalkInAccount(userId: string) {
    const customer = await this.prisma
      .forTenant()
      .customer.findFirst({ where: { userId }, select: { id: true, isWalkIn: true } });
    assertNotWalkIn(customer);
  }

  async unlockUser(userId: string, callerRole: UserRole) {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    assertMayChangeAccount(user, callerRole);
    await this.prisma.forTenant().user.update({
      where: { id: userId },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
    return { id: userId, unlocked: true };
  }

  async resetPassword(userId: string, callerRole: UserRole) {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    assertMayChangeAccount(user, callerRole);
    await this.assertNotWalkInAccount(userId);
    const tempPassword = `${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    // B461: a reset kills a pending login-email change (one requested from a stolen session must not outlive it), in
    // the same transaction as the write. User row first, then the burn: the lock order of confirm and changeStatus.
    await this.prisma.tenantTransaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { password: hashedPassword, forcePasswordChange: true },
      });
      await revokeUserEmailChanges(tx, userId);
    });

    // N2 review fix: never email a set-password link for a deactivated/deleted
    // account — an admin resetting a SUSPENDED/INACTIVE user's password (e.g. to
    // lock them out) must not hand them a working way back in.
    await this.sendInviteIfOwed({ ...user, forcePasswordChange: true });

    return { tempPassword };
  }

  /** Flips the LEGACY `isAdmin` display flag; it grants nothing (authority is the TENANT_ADMIN role). */
  async toggleAdmin(userId: string, callerIsAdmin: boolean) {
    if (!callerIsAdmin) {
      throw new ForbiddenException("Only admins can assign admin rights.");
    }
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    if (user.role !== UserRole.OPERATOR) {
      throw new BadRequestException("Admin rights can only be assigned to operators.");
    }
    // F03 slice 2 (SA-1096): a privilege change burns the account's live links in the same transaction.
    const updated = await this.prisma.tenantTransaction(async (tx) => {
      const row = await tx.user.update({
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
      await revokeUserLinkTokens(tx, userId);
      return row;
    });
    // Same rule as an email or role change: a person who has never set a password is not left with a dead first mail.
    await this.sendInviteIfOwed({
      ...updated,
      deletedAt: user.deletedAt,
      forcePasswordChange: user.forcePasswordChange,
    });
    return updated;
  }

  async toggleDriverPermit(userId: string, callerRole: UserRole) {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    assertMayChangeAccount(user, callerRole);
    if (user.role !== UserRole.OPERATOR && user.role !== UserRole.TENANT_ADMIN) {
      throw new BadRequestException("Driver permit can only be assigned to operators.");
    }

    const newValue = !user.canActAsDriver;

    // One transaction, one writer (SA-1171 K1): enabling writes the Driver row with the flag, and a concurrent double
    // toggle upserts the same row instead of failing on the unique userId.
    if (newValue) await this.observeDriverRowGate("toggleDriverPermit", user.tenantId);
    return this.prisma.tenantTransaction(async (tx) => {
      if (newValue) await ensureDriverRow(tx, user);
      return tx.user.update({
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
