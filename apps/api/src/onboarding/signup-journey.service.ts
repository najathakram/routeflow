import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BillingNotificationService } from "../billing/billing-notification.service";
import { LeaderCron } from "../common/cron-lock";
import { PrismaService } from "../prisma/prisma.service";
import {
  JOURNEY_BATCH,
  JOURNEY_GATE_CLOSED,
  JOURNEY_STOP_LINKS,
  JOURNEY_WELCOME_KEY,
  JOURNEY_WELCOME_MILESTONE,
  eligibleTenantWhere,
  type JourneyGate,
  type JourneyStopLinks,
} from "./signup-journey";
import { welcomeEmail } from "./signup-journey.templates";

export interface JourneyRunResult {
  sent: number;
  skipped?: "no-stop-link" | "gate-closed";
  failed?: number;
  considered?: number;
}

@Injectable()
export class SignupJourneyService {
  private readonly logger = new Logger(SignupJourneyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: BillingNotificationService,
    private readonly config: ConfigService,
    @Optional() @Inject(JOURNEY_STOP_LINKS) private readonly stopLinks?: JourneyStopLinks,
  ) {}

  /**
   * PR-1 cannot send: the tick passes the constant closed gate and reads no environment name, so there is no
   * switch to set early. (Shape: onboarding-lifecycle.service.ts, platform-level rows through forSystem.)
   */
  @LeaderCron("*/10 * * * *", "onboarding.signupJourney")
  async runCron(): Promise<void> {
    const r = await this.prisma.forSystem("onboarding: signup journey across businesses", () =>
      this.run(new Date(), JOURNEY_GATE_CLOSED),
    );
    if (r.sent > 0) this.logger.log(`signup journey: ${r.sent} welcome(s) sent`);
  }

  /**
   * The welcome path. Returns before any query when there is no stop-link provider, when the gate is closed, or when
   * WEB_URL is unset (no fallback host). Each tenant goes through the one claim door, so a rerun or a parallel tick
   * sends nothing twice.
   */
  async run(now: Date, gate: JourneyGate): Promise<JourneyRunResult> {
    if (!this.stopLinks) return { sent: 0, skipped: "no-stop-link" };
    if (!gate.welcome || !gate.since) return { sent: 0, skipped: "gate-closed" };
    const webUrl = this.config.get<string>("WEB_URL")?.trim();
    if (!webUrl) {
      this.logger.warn(
        "signup journey: WEB_URL is not set, no stop link can be built; nothing sent",
      );
      return { sent: 0, skipped: "no-stop-link" };
    }
    const tenants = await this.prisma.tenant.findMany({
      where: eligibleTenantWhere(now, gate.since),
      orderBy: { createdAt: "desc" },
      take: JOURNEY_BATCH,
      select: { id: true, slug: true },
    });
    if (tenants.length >= JOURNEY_BATCH) {
      this.logger.warn(
        `signup journey: the batch of ${JOURNEY_BATCH} is full; the rest wait for the next tick`,
      );
    }
    let sent = 0;
    let failed = 0;
    for (const t of tenants) {
      try {
        const stopUrl = this.stopLinks.stopUrl(t.id, webUrl);
        const r = await this.notifications.sendOnceToAdmins(
          t.id,
          JOURNEY_WELCOME_MILESTONE,
          JOURNEY_WELCOME_KEY,
          (_admin, businessName) =>
            welcomeEmail({ businessName, webUrl, workspaceId: t.slug, stopUrl }),
        );
        if (r.status === "sent") sent++;
        else if (r.status !== "skipped") failed++;
      } catch {
        failed++;
      }
    }
    return { sent, failed, considered: tenants.length };
  }
}
