import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "./email.service";
import { escapeHtml } from "../common/html-escape";
import { loadDemoBookingConfig } from "../demo-booking/demo-booking.config";
import { webBaseUrl } from "../config/web-base-url";

/** The self-service plan routes that can change what an account owes (settings-billing.controller.ts). */
export type PlanChangeKind = "subscribe" | "upgrade" | "downgrade" | "cancel" | "resume";

type AlertTenant = { id: string; name: string; slug: string; createdAt: Date; status: string };

/** `Team` from `TEAM`: the plan name as a person reads it. */
function planLabel(key: string | null | undefined): string {
  if (!key) return "a new plan";
  const lower = key.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function dateLabel(d: Date | null | undefined): string | null {
  return d
    ? d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;
}

/**
 * W1 (COPY 2q): a short mail to the owner when a trial needs a person. It goes to the same list that gets the
 * demo-booking notices (`DEMO_BOOKING_ADMIN_EMAIL`, with its default), one send per address, and it NEVER throws: an alert that fails
 * must not fail the sign-up, the verification, the plan change or the first question that raised it.
 */
@Injectable()
export class OwnerAlertService {
  private readonly logger = new Logger(OwnerAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /** The email was verified: the trial is live. */
  async trialVerified(tenantId: string, contactEmail: string): Promise<void> {
    await this.guarded("trial-verified", tenantId, async () => {
      const t = await this.tenant(tenantId);
      if (!t) return;
      await this.deliver(`New RouteFlow trial: ${t.name}`, [
        `${t.name} just verified their email.`,
        ...this.facts(t, contactEmail),
      ]);
    });
  }

  /** The verification mail did not go out: the account is waiting and cannot sign in. */
  async verificationMailFailed(tenantId: string, contactEmail: string): Promise<void> {
    await this.guarded("verification-failed", tenantId, async () => {
      const t = await this.tenant(tenantId);
      if (!t) return;
      await this.deliver(`New RouteFlow trial, verification email failed: ${t.name}`, [
        `${t.name} signed up, but their verification email did not go out. The account is waiting, and they can't sign in yet.`,
        ...this.facts(t, contactEmail),
      ]);
    });
  }

  /**
   * An ACTIVE account with no card on file changed its plan, so nothing bills it: the owner does it by hand. An account
   * with a Stripe subscription is billed by Stripe, and a trial or a read-only account owes nothing: neither sends anything.
   */
  async planChangeNoCard(tenantId: string, kind: PlanChangeKind): Promise<void> {
    await this.guarded("plan-change", tenantId, async () => {
      const t = await this.tenant(tenantId);
      const sub = await this.prisma.tenantSubscription.findUnique({
        where: { tenantId },
        select: {
          stripeSubId: true,
          planKey: true,
          cycle: true,
          periodEnd: true,
          downgradeToPlanKey: true,
          downgradeEffectiveAt: true,
        },
      });
      // Only an ACTIVE account with no Stripe subscription is billed by hand: a trial, a read-only account and a locked one are not.
      if (!t || t.status !== "ACTIVE" || !sub || sub.stripeSubId) return;
      const plan = planLabel(sub.planKey);
      const first = {
        subscribe: `${t.name} picked ${plan}, billed ${sub.cycle === "ANNUAL" ? "annually" : "monthly"}. No card was taken.`,
        upgrade: `${t.name} moved up to ${planLabel(sub.planKey)}.`,
        downgrade: `${t.name} moves down to ${planLabel(sub.downgradeToPlanKey)}${
          dateLabel(sub.downgradeEffectiveAt ?? sub.periodEnd)
            ? ` on ${dateLabel(sub.downgradeEffectiveAt ?? sub.periodEnd)}`
            : ""
        }.`,
        cancel: dateLabel(sub.periodEnd)
          ? `${t.name} cancelled. It ends on ${dateLabel(sub.periodEnd)}.`
          : `${t.name} cancelled.`,
        resume: `${t.name} undid its change.`,
      }[kind];
      await this.deliver(`RouteFlow plan change, no card: ${t.name}`, [
        first,
        this.backOfficeLink(t),
        "Bill them by hand from there.",
      ]);
    });
  }

  /** A first-question answer found the setup already changed (rows F16, F16b): it was left alone, and may be half set up. */
  async keptSetup(tenantId: string): Promise<void> {
    await this.guarded("kept-setup", tenantId, async () => {
      const t = await this.tenant(tenantId);
      if (!t) return;
      await this.deliver(`Check this new account: ${t.name}`, [
        `${t.name} answered the first question, but its setup had already changed, so we left it alone. It may be half set up.`,
        this.backOfficeLink(t),
      ]);
    });
  }

  // ─── internals ────────────────────────────────────────────────────────────────

  private async guarded(what: string, tenantId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(
        `owner alert "${what}" for tenant ${tenantId} not sent: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private tenant(id: string): Promise<AlertTenant | null> {
    return this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true, name: true, slug: true, createdAt: true, status: true },
    });
  }

  private backOfficeLink(t: AlertTenant): string {
    return `${webBaseUrl().replace(/\/+$/, "")}/admin/tenants/${t.id}`;
  }

  private facts(t: AlertTenant, contactEmail: string): string[] {
    return [
      `Contact email: ${contactEmail}`,
      `Workspace ID: ${t.slug}`,
      `Signed up: ${t.createdAt.toISOString()}`,
      this.backOfficeLink(t),
    ];
  }

  /** One send per address, so one bad address never costs the others theirs. */
  private async deliver(subject: string, lines: string[]): Promise<void> {
    const to = loadDemoBookingConfig().demoBookingAdminEmails;
    const html = lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("\n");
    await Promise.allSettled(
      to.map(async (address) => {
        try {
          const res = await this.email.send({
            to: address,
            subject,
            html,
            text: lines.join("\n\n"),
            senderClass: "platform",
          });
          if (!res.delivered) {
            this.logger.warn(`owner alert "${subject}" to ${address} not delivered`);
          }
        } catch (err) {
          this.logger.warn(
            `owner alert "${subject}" to ${address} failed: ${(err as Error)?.message ?? err}`,
          );
        }
      }),
    );
  }
}
