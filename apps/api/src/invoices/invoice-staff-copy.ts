import type { Logger } from "@nestjs/common";
import { isInternalEmail } from "../common/internal-email";
import type { EmailService } from "../email/email.service";

/**
 * W-1443 (SA-1516): a PRIVATE copy of an invoice email to the staff member who pressed Send. A separate email
 * (never a cc or bcc): the customer sees nothing new, and a failed or bounced copy can never stop the customer's
 * invoice. Opt-in per user through the `invoiceEmailCopy` preference (absent = off). The copy reuses the customer's
 * already-built payload, so no amount is re-derived and nothing is re-rendered.
 *
 * The one place that decides "does this sender get a copy"; reminders, statements and credit notes call it later.
 */

/** The preference key (`PREF.invoiceEmailCopy` in @routeflow/types; the api cannot value-import that package). */
const COPY_PREF_KEY = "invoiceEmailCopy";
const COPY_ROLES = ["TENANT_ADMIN", "OPERATOR"];
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type PrismaLike = { forTenant(): any; getTenantId(): string | null | undefined };

/**
 * R2. The address to copy, or null. First miss wins, in this order: an actor exists (a recurring or system send has
 * none); a tenant is in scope; the actor is an ACTIVE, undeleted TENANT_ADMIN / OPERATOR of THIS tenant; their
 * preference is exactly "true"; their address is well formed and not an internal sentinel; and it is not one of the
 * customer's own recipient addresses (no duplicate to a staff user who emailed themselves).
 */
export async function resolveInvoiceCopyRecipient(
  prisma: PrismaLike,
  actorId: string | null,
  customerTo: string,
): Promise<string | null> {
  if (!actorId) return null;
  const tenantId = prisma.getTenantId();
  if (!tenantId) return null;
  const db = prisma.forTenant();
  const user = await db.user.findFirst({
    where: {
      id: actorId,
      tenantId,
      status: "ACTIVE",
      deletedAt: null,
      role: { in: COPY_ROLES },
    },
    select: { email: true },
  });
  if (!user) return null;
  const pref = await db.userPreference.findUnique({
    where: { userId_key: { userId: actorId, key: COPY_PREF_KEY } },
    select: { value: true },
  });
  if (pref?.value !== "true") return null;
  const email = String(user.email ?? "").trim();
  if (!EMAIL_SHAPE.test(email) || isInternalEmail(email)) return null;
  const customers = customerTo.split(/[,;]/).map((a) => a.trim().toLowerCase());
  if (customers.includes(email.toLowerCase())) return null;
  return email;
}

export interface StaffCopyDeps {
  prisma: PrismaLike;
  emailService: Pick<EmailService, "sendInvoice">;
  logger: Pick<Logger, "warn">;
}

/**
 * R3. Send the copy AFTER the customer send was delivered. Never throws and never changes the customer result:
 * returns `{ copiedTo }` only when the copy was delivered. A failed copy leaves its own FAILED INVOICE_STAFF_COPY
 * delivery row (written by EmailService.send); no retry.
 */
export async function sendInvoiceStaffCopy(
  deps: StaffCopyDeps,
  p: {
    emailPayload: Parameters<EmailService["sendInvoice"]>[0];
    actorId: string | null;
    customerTo: string;
  },
): Promise<{ copiedTo?: string }> {
  try {
    const to = await resolveInvoiceCopyRecipient(deps.prisma, p.actorId, p.customerTo);
    if (!to) return {};
    const res = await deps.emailService.sendInvoice({
      ...p.emailPayload,
      to,
      staffCopy: { sentTo: p.customerTo },
    });
    return res?.delivered ? { copiedTo: to } : {};
  } catch (err) {
    deps.logger.warn(
      `invoice staff copy failed (${err instanceof Error ? err.message : String(err)}); the customer's email is unaffected`,
    );
    return {};
  }
}
