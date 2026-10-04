import { Injectable } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { assertSafeCustomerNames } from "../../customers/customer-name-guard";

/** The walk-in system user's fixed login name: the User @@unique([tenantId, username]) makes the lazy create race-safe. */
export const WALK_IN_USERNAME = "walk-in-counter";
const WALK_IN_NAMES = { businessName: "Walk-in customer", contactName: "Walk-in" };

/**
 * The tenant's ONE walk-in customer for counter sales (SA-655). Created lazily on the first walk-in
 * sale, reused by every later one, never duplicated: a concurrent first sale loses on the username
 * unique (P2002) and re-finds the winner.
 *
 * Deliberately NOT routed through CustomersService.create: the walk-in is a system row, so it skips
 * the plan's customer cap gate (assertCustomerCapNotExceeded) and never mints a temp password. The
 * user's password is a bcrypt hash of 48 random bytes that is never stored or shown, so no login path
 * exists for it (forcePasswordChange stays false: there is nothing to change to).
 */
@Injectable()
export class WalkInCustomerService {
  constructor(private readonly prisma: PrismaService) {}

  private find(): Promise<{ id: string } | null> {
    return this.prisma.forTenant().customer.findFirst({
      where: { isWalkIn: true, deletedAt: null },
      select: { id: true },
    });
  }

  async getOrCreateWalkIn(): Promise<string> {
    const existing = await this.find();
    if (existing) return existing.id;

    assertSafeCustomerNames(WALK_IN_NAMES); // constants, but every customer-name writer calls the shared guard (B956)
    const password = await bcrypt.hash(crypto.randomBytes(48).toString("hex"), 10);
    try {
      return await this.prisma.tenantTransaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            // Same non-routable placeholder CustomersService mints for an email-less customer.
            email: `no-email+${crypto.randomUUID()}@placeholder.local`,
            username: WALK_IN_USERNAME,
            password,
            role: "CUSTOMER",
            forcePasswordChange: false,
          },
        });
        const customer = await tx.customer.create({
          data: {
            userId: user.id,
            ...WALK_IN_NAMES,
            isWalkIn: true,
            orderStatusEmails: false,
          },
        });
        return customer.id as string;
      });
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") {
        const winner = await this.find();
        if (winner) return winner.id;
      }
      throw e;
    }
  }
}
