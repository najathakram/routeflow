import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PrismaService } from "../prisma/prisma.service";
import { CatchupCheckoutService } from "./catchup-checkout.service";
import { claimRefusal } from "./catchup-claim";
import { CatchupClaimService } from "./catchup-claim.service";
import { describeStubPeriod } from "./catchup-plan";
import { StripeService } from "./stripe.service";

/**
 * The tenant-side face of the October catch-up (the "payment due" banner and its Pay now). It decides NOTHING about
 * money: the amount, the period and the eligibility all come from the same planner the super-admin route uses
 * (`CatchupCheckoutService.plan` / `open`). This class only answers "is it this tenant's to pay right now", and
 * makes sure a second click never creates a second payable session.
 *
 * Tenant scope: every method takes the tenant id from the signed-in user's JWT (the controller passes it), never
 * from a body or query.
 */
export interface PaymentDueView {
  due: boolean;
  /** The stub period started before today in the tenant's zone (UTC when it has none). */
  pastDue: boolean;
  amountCents: number;
  /** "October 2026" (the planner's own period words). Null when nothing is due. */
  periodLabel: string | null;
  /** ISO start of the period the stub covers. Null when nothing is due. */
  periodStart: string | null;
}

const NOT_DUE: PaymentDueView = {
  due: false,
  pastDue: false,
  amountCents: 0,
  periodLabel: null,
  periodStart: null,
};

/** A held claim is the very state "a payment session is open"; it is not a reason to hide the bill. */
const HIDES_THE_BILL = (reason: string) => reason !== "claim_held";

function dateKeyIn(d: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which sorts as a string.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Did `periodStart` fall on a calendar day before today's, in `timeZone` (UTC for none or an unknown zone)? */
export function isPastDue(periodStart: Date, now: Date, timeZone: string | null): boolean {
  let zone = timeZone || "UTC";
  try {
    dateKeyIn(now, zone);
  } catch {
    zone = "UTC";
  }
  return dateKeyIn(periodStart, zone) < dateKeyIn(now, zone);
}

@Injectable()
export class PaymentDueService {
  private readonly logger = new Logger(PaymentDueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catchup: CatchupCheckoutService,
    private readonly claim: CatchupClaimService,
    private readonly stripe: StripeService,
  ) {}

  async get(tenantId: string, now: Date = new Date()): Promise<PaymentDueView> {
    const report = await this.catchup.plan(tenantId, now);
    if (report.tenantClass !== "PRODUCTION") return NOT_DUE;
    if (report.ineligible.some(HIDES_THE_BILL)) return NOT_DUE;
    const plan = report.plan;
    // below the Stripe minimum the line is forgiven (the session carries none): there is nothing to pay
    if (!plan.ok || plan.stub.totalCents <= 0 || plan.stub.belowStripeMinimum) return NOT_DUE;
    const tenant = (await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    })) as { timezone: string | null } | null;
    return {
      due: true,
      pastDue: isPastDue(plan.stub.from, now, tenant?.timezone ?? null),
      amountCents: plan.stub.totalCents,
      periodLabel: describeStubPeriod(plan.stub.from, plan.stub.to),
      periodStart: plan.stub.from.toISOString(),
    };
  }

  /**
   * The Checkout URL of THIS tenant's catch-up. Reuses the open, unexpired session when one exists; otherwise
   * creates exactly one through `CatchupCheckoutService.open`, priced by the planner right now. No client amount.
   */
  async pay(tenantId: string, now: Date = new Date()): Promise<{ checkoutUrl: string }> {
    const view = await this.get(tenantId, now);
    if (!view.due) {
      throw new ConflictException({
        code: API_ERROR_CODES.PAYMENT_NOT_DUE,
        message: "Nothing is due right now.",
      });
    }
    const open = await this.openSessionUrl(tenantId, now);
    if (open) return { checkoutUrl: open };

    const base = process.env.FRONTEND_URL ?? "http://localhost:3001";
    try {
      const out = await this.catchup.open(tenantId, {
        expectedStubCents: view.amountCents,
        now,
        successUrl: `${base}/settings/billing?paid=1`,
        cancelUrl: `${base}/settings/billing?checkout=cancelled`,
      });
      return { checkoutUrl: out.checkoutUrl };
    } catch (err) {
      // A parallel click won the claim between our read and our create: hand back its session, never a second one.
      if (
        err instanceof ConflictException &&
        (err.getResponse() as { code?: string })?.code === API_ERROR_CODES.CATCHUP_SESSION_OPEN
      ) {
        const raced = await this.openSessionUrl(tenantId, now).catch(() => null);
        if (raced) return { checkoutUrl: raced };
      }
      throw err;
    }
  }

  /**
   * The stored claim's session URL while it is still payable. Null when there is no claim (or its expired session
   * has just been released, exactly as the `checkout.session.expired` webhook would). Any other held state is the
   * claim's own coded 409: a payment already settling must not be paid twice.
   */
  private async openSessionUrl(tenantId: string, now: Date): Promise<string | null> {
    const row = (await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: { catchupState: true, catchupSessionId: true },
    })) as { catchupState: string | null; catchupSessionId: string | null } | null;
    const state = row?.catchupState ?? null;
    if (!state) return null;
    if (state !== "SESSION_OPEN" || !row?.catchupSessionId) throw claimRefusal(state)!;

    const session = await this.stripe.getCheckoutSession(row.catchupSessionId);
    const expiresMs = Number(session?.expires_at ?? 0) * 1000;
    if (session?.status === "open" && session.url && expiresMs > now.getTime()) {
      return session.url as string;
    }
    if (session?.status === "complete") throw claimRefusal("AWAITING_FIRST_PAYMENT")!;
    // expired (or gone past its time): release the claim by the same CAS the webhook uses, then create afresh
    this.logger.log(`payment-due: releasing the expired catch-up session of tenant ${tenantId}`);
    await this.claim.onSessionExpired(session);
    return null;
  }
}
