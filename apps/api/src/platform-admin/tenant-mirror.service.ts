import { Injectable, Logger } from "@nestjs/common";
import { TenantClass, UserRole } from "@prisma/client";
import * as bcrypt from "bcrypt"; // match the hasher import used at customers.service.ts:484-509
import * as crypto from "crypto";
import { LeaderCron } from "../common/cron-lock";
import { PrismaService } from "../prisma/prisma.service";
import { PlatformConfigService } from "./platform-config.service";

/** Tenant classes that get an HQ mirror — shared by upsert() and the nightly sweep. */
export const MIRROR_CLASSES: TenantClass[] = [TenantClass.PRODUCTION, TenantClass.DEMO];

/**
 * Deterministic, non-routable identity for the placeholder User that backs a mirrored Customer
 * (Customer.userId is a required unique FK). Keyed by the immutable tenant id — never the slug,
 * which can be reassigned — and unique inside the house tenant via
 * @@unique([tenantId, email]) / @@unique([tenantId, username]).
 */
export function mirrorUserIdentity(tenantId: string): { email: string; username: string } {
  return { email: `mirror+${tenantId}@placeholder.local`, username: `mirror_${tenantId}` };
}

/**
 * Prisma's unique-constraint violation (P2002) — the shape a LOST create race takes here, on
 * `Customer.representsTenantId` or `User(tenantId, email|username)`. Read off `.code` rather than
 * `instanceof PrismaClientKnownRequestError` so a rejection surfaced through `$transaction` (or a
 * test double) is still recognised.
 */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === "P2002";
}

/**
 * Keeps one HQ Customer row per real tenant in sync (name + admin contacts), so Phase 1's
 * invoicing and Phase 4's messaging always have a current record to bill/message against.
 * Best-effort: a failure here must never fail tenant creation or config updates — it is
 * caught and logged by every caller, and the nightly sweep isolates failures per tenant.
 *
 * Tenancy invariant: every row written here carries tenantId = the HOUSE tenant, never the
 * represented tenant. Writes go through the bare Prisma client with an explicit tenantId
 * (the platform-admin.service.ts:243-288 pattern) — NOT forTenant()/tenantCtx.run(); L-124
 * is about forTenant() silently unscoping and does not apply to this pattern.
 */
@Injectable()
export class TenantMirrorService {
  private readonly logger = new Logger(TenantMirrorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformConfig: PlatformConfigService,
  ) {}

  async upsert(tenantId: string): Promise<void> {
    const houseTenantId = await this.platformConfig.getHouseTenantId();
    if (!houseTenantId) {
      this.logger.warn(`Skipping mirror sync for ${tenantId}: no house tenant configured yet.`);
      return;
    }
    if (tenantId === houseTenantId) return; // never mirror HQ into itself

    // findUnique (not findUniqueOrThrow): a missing tenant is treated the same as "not
    // mirror-eligible" — this is a best-effort sync, never a source of a thrown error.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        class: true,
        users: {
          where: { role: UserRole.TENANT_ADMIN, deletedAt: null },
          orderBy: { createdAt: "asc" },
          select: { email: true, username: true },
        },
      },
    });
    if (!tenant) {
      this.logger.warn(`Skipping mirror sync for ${tenantId}: tenant not found.`);
      return;
    }
    if (!MIRROR_CLASSES.includes(tenant.class)) return; // same eligibility rule as the sweep

    let customerId: string | null;
    try {
      customerId = await this.resolveMirrorCustomerId(tenantId, houseTenantId, tenant);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A concurrent upsert() for the SAME tenant won the create race — createTenant(),
      // updateTenantConfig() and the nightly sweep can all overlap. Re-resolve once: the retry
      // finds the winner's row and takes the update path, instead of dropping this call's sync
      // (every caller catches at `debug`, so a propagated P2002 is invisible until the next sweep).
      this.logger.warn(`Mirror create for tenant ${tenantId} lost a concurrent race; retrying.`);
      customerId = await this.resolveMirrorCustomerId(tenantId, houseTenantId, tenant);
    }
    if (!customerId) return;

    for (const admin of tenant.users) {
      const contact = await this.prisma.contactPerson.findFirst({
        where: { customerId, email: admin.email },
        select: { id: true },
      });
      if (!contact) {
        await this.prisma.contactPerson.create({
          data: {
            customerId,
            tenantId: houseTenantId,
            firstName: admin.username,
            lastName: "",
            email: admin.email,
          },
        });
      }
    }
  }

  /**
   * Resolve the mirror Customer's id for `tenantId`: the existing HQ row (refreshing
   * `businessName`), or a newly created Customer plus its placeholder User. Returns `null` when
   * the mirror already lives in a FOREIGN tenant — logged and skipped, never rewritten.
   *
   * The find-then-create is deliberately NOT atomic: the foreign-tenant guard has to see the row
   * before deciding to write, which `customer.upsert()` cannot express. Losing that race is
   * therefore expected and handled by `upsert()`'s single P2002 retry above, not prevented here.
   */
  private async resolveMirrorCustomerId(
    tenantId: string,
    houseTenantId: string,
    tenant: { name: string; users: { username: string }[] },
  ): Promise<string | null> {
    const existing = await this.prisma.customer.findUnique({
      where: { representsTenantId: tenantId },
      select: { id: true, tenantId: true },
    });

    if (existing) {
      if (existing.tenantId !== houseTenantId) {
        this.logger.error(
          `Mirror for tenant ${tenantId} lives in tenant ${existing.tenantId}, not the house tenant ${houseTenantId}; skipping.`,
        );
        return null;
      }
      await this.prisma.customer.update({
        where: { id: existing.id },
        data: { businessName: tenant.name },
      });
      return existing.id;
    }

    const identity = mirrorUserIdentity(tenantId);
    const firstAdmin = tenant.users[0];
    return await this.prisma.$transaction(async (tx) => {
      const placeholder =
        (await tx.user.findFirst({
          where: { tenantId: houseTenantId, email: identity.email },
          select: { id: true },
        })) ??
        (await tx.user.create({
          data: {
            tenantId: houseTenantId,
            email: identity.email,
            username: identity.username,
            role: UserRole.CUSTOMER,
            password: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10),
            forcePasswordChange: true,
          },
        }));

      const created = await tx.customer.create({
        data: {
          tenantId: houseTenantId,
          userId: placeholder.id,
          businessName: tenant.name,
          contactName: firstAdmin?.username ?? tenant.name,
          representsTenantId: tenantId,
        },
      });
      return created.id;
    });
  }

  @LeaderCron("0 6 * * *", "platform-admin.mirrorSync")
  async mirrorSync(): Promise<void> {
    if (!(await this.platformConfig.getHouseTenantId())) {
      this.logger.warn("Mirror sync skipped: no house tenant configured yet.");
      return;
    }
    const tenants = await this.prisma.tenant.findMany({
      where: { class: { in: MIRROR_CLASSES }, deletedAt: null },
      select: { id: true },
    });
    const failures: string[] = [];
    for (const t of tenants) {
      try {
        await this.upsert(t.id);
      } catch (err) {
        failures.push(t.id);
        this.logger.error(`Mirror sync failed for tenant ${t.id}: ${(err as Error).message}`);
      }
    }
    if (failures.length) {
      this.logger.warn(
        `Mirror sync completed with ${failures.length} failure(s): ${failures.join(", ")}`,
      );
    }
    // One greppable line EVERY night, including a clean run and a run that found zero eligible
    // tenants: without it a sweep that silently stopped (lock never won, schedule wrong, class
    // filter emptied) is indistinguishable in the logs from one that ran and had nothing to do.
    this.logger.log(
      `Mirror sync finished: ${tenants.length} tenant(s) considered, ${failures.length} failure(s).`,
    );
  }
}
