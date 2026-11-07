import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "./email.service";
import { roundMoney } from "@routeflow/pricing";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `12 Jan`: the day and the short month, in UTC (the end of a free period is a UTC date everywhere else). */
function shortDayMonth(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
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

  /**
   * R25 / SA-1100 §1: a billable free period ends within a week. A grant never bills: when it ends the business LOSES
   * the feature and nothing is charged automatically, so the mail says exactly that and never claims a paid add-on
   * starts by itself. The owner decides: extend the free period, or turn on the paid add-on. Plain words only; the
   * caller (`billablePilotEnding`) has already decided that the feature is really lost and has a flat paid add-on.
   */
  async pilotEnding(
    tenantId: string,
    p: { featureName: string; endsAt: Date; monthlyPrice: number },
  ): Promise<void> {
    await this.guarded("pilot-ending", tenantId, async () => {
      const t = await this.tenant(tenantId);
      if (!t) return;
      const ends = shortDayMonth(p.endsAt);
      const price =
        p.monthlyPrice % 1 === 0 ? String(p.monthlyPrice) : roundMoney(p.monthlyPrice).toFixed(2);
      await this.deliver(`${t.name}: ${p.featureName} free period ends ${ends}`, [
        `The free period of ${p.featureName} for ${t.name} ends on ${ends}.`,
        `After that, ${t.name} loses ${p.featureName}. Nothing is charged automatically.`,
        `To keep it, extend the free period or turn on the paid add-on ($${price} a month) from the business page: ${this.backOfficeLink(t)}`,
      ]);
    });
  }

  /** Set once this process has sent (or tried) the boot alert: one per boot, never per request. */
  private planFlagBootAlerted = false;

  /**
   * FG-1 WP3: `PLAN_FLAG_ENFORCEMENT` is on at boot, so plan features the courtesy kept on are now enforced for every
   * business. The owner flips that switch on purpose, per command; this is the one mail that says it is on, so a stray
   * environment variable cannot do it quietly. Deduped per boot, and it NEVER throws.
   */
  async planFlagEnforcementOnAtBoot(): Promise<void> {
    if (this.planFlagBootAlerted) return;
    this.planFlagBootAlerted = true;
    await this.guarded("plan-flag-enforcement", "platform", async () => {
      await this.deliver("Plan feature enforcement is on", [
        "Plan feature enforcement is on. A business whose plan doesn't include a feature can no longer use it.",
        "If you didn't turn this on, check the PLAN_FLAG_ENFORCEMENT setting.",
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
