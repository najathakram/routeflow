import { ConflictException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { resolveZone } from "../common/tenant-time-zone";
import { PrismaService } from "../prisma/prisma.service";
import { CatchupCheckoutService } from "./catchup-checkout.service";
import { claimRefusal } from "./catchup-claim";
import { CatchupClaimService } from "./catchup-claim.service";
import { chargeNowCents, describeStubPeriod } from "./catchup-plan";
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
  /**
   * SA-801 / SA-806: nothing is charged now (the planner's `chargeNowCents` is 0: the stub-free `trial` shape or a
   * forgiven line), but the card must be added by `cardBy` or the first charge `chargeStartsOn` is lost to the next
   * month's terms. `due` stays false for it. Mutually exclusive with `due`.
   */
  cardNeeded: boolean;
  /** ISO instant A, the first charge (the client prints it in the tenant's zone). Null unless `cardNeeded`. */
  chargeStartsOn: string | null;
  /**
   * ISO instant D = A - 72 h (the planner's `termsHoldUntil`): the last instant the quoted terms hold. The card
   * deadline the tenant sees. Null unless `cardNeeded`.
   */
  cardBy: string | null;
}

const NOT_DUE: PaymentDueView = {
  due: false,
  pastDue: false,
  amountCents: 0,
  periodLabel: null,
  periodStart: null,
  cardNeeded: false,
  chargeStartsOn: null,
  cardBy: null,
};

/** Where Stripe sends the admin back: a real payment, or a card add (nothing was charged: never "Payment received"). */
const PAID_RETURN_PATH = "/settings/billing?paid=1";
const CARD_RETURN_PATH = "/settings/billing?paid=1&card=1";

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

/**
 * Did `periodStart` fall on a calendar day before today's, in `timeZone`? The zone is the one `resolveZone` returned
 * (always valid, UTC when the tenant has none): this does not second-guess it.
 */
export function isPastDue(periodStart: Date, now: Date, timeZone: string): boolean {
  return dateKeyIn(periodStart, timeZone) < dateKeyIn(now, timeZone);
}

/** The pay race: another click claimed the catch-up between our read and our create (open() refused for that reason alone). */
function lostTheClaimRace(err: unknown): boolean {
  if (!(err instanceof ConflictException)) return false;
  const body = err.getResponse() as { code?: string; reasons?: unknown };
  if (body?.code === API_ERROR_CODES.CATCHUP_SESSION_OPEN) return true;
  return (
    body?.code === API_ERROR_CODES.CATCHUP_NOT_ELIGIBLE &&
    Array.isArray(body.reasons) &&
    body.reasons.length === 1 &&
    body.reasons[0] === "claim_held"
  );
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
    return (await this.read(tenantId, now)).view;
  }

  /**
   * The view AND the planner's own stub total from ONE planner read, so `pay` prices the session from the very read
   * that decided eligibility (never the view's display amount, never a client value).
   */
  private async read(
    tenantId: string,
    now: Date,
  ): Promise<{ view: PaymentDueView; stubCents: number }> {
    const none = { view: NOT_DUE, stubCents: 0 };
    const report = await this.catchup.plan(tenantId, now);
    if (report.tenantClass !== "PRODUCTION") return none;
    if (report.ineligible.some(HIDES_THE_BILL)) return none;
    const plan = report.plan;
    if (!plan.ok) return none;
    // SA-801 / SA-806: nothing is charged now (the stub-free `trial` shape, or a line forgiven under the Stripe
    // minimum): the card is still needed, by D. Same eligibility as a bill (PRODUCTION, ACTIVE, manual invoicing, no
    // hiding ineligibility): an app-trial (TRIAL status) or read-only tenant is refused above by `tenant_not_active`.
    if (chargeNowCents(plan) === 0) {
      return {
        view: {
          ...NOT_DUE,
          cardNeeded: true,
          chargeStartsOn: plan.trialEndAt.toISOString(),
          cardBy: plan.termsHoldUntil.toISOString(),
        },
        stubCents: plan.stub.totalCents,
      };
    }
    const zone = await resolveZone(this.prisma, { tenantId });
    return {
      view: {
        due: true,
        pastDue: isPastDue(plan.stub.from, now, zone.zone),
        amountCents: plan.stub.totalCents,
        periodLabel: describeStubPeriod(plan.stub.from, plan.stub.to),
        periodStart: plan.stub.from.toISOString(),
        cardNeeded: false,
        chargeStartsOn: null,
        cardBy: null,
      },
      stubCents: plan.stub.totalCents,
    };
  }

  /**
   * The Checkout URL of THIS tenant's catch-up. Reuses the open, unexpired session when one exists; otherwise
   * creates exactly one through `CatchupCheckoutService.open`, priced by the planner right now. No client amount.
   * Works for a payable bill and for a card-needed tenant (SA-801 / SA-806, a $0-now session).
   */
  async pay(tenantId: string, now: Date = new Date()): Promise<{ checkoutUrl: string }> {
    const { view, stubCents } = await this.read(tenantId, now);
    // SA-801 / SA-806: a card-needed tenant (nothing charged now) opens the very same catch-up session. The expected
    // stub is the planner's own `stub.totalCents` from the read above: 0 for the `trial` shape, the forgiven amount
    // for a forgiven line (open() compares it with its own fresh plan and refuses a mismatch).
    if (!view.due && !view.cardNeeded) {
      throw new ConflictException({
        code: API_ERROR_CODES.PAYMENT_NOT_DUE,
        message: "Nothing is due right now.",
      });
    }
    const open = await this.openSessionUrl(tenantId, now);
    if (open) return { checkoutUrl: open };

    try {
      const out = await this.catchup.open(tenantId, {
        expectedStubCents: stubCents,
        now,
        // paths: open() joins them to its one FRONTEND_URL base
        successPath: view.cardNeeded ? CARD_RETURN_PATH : PAID_RETURN_PATH,
        cancelPath: "/settings/billing?checkout=cancelled",
      });
      return { checkoutUrl: out.checkoutUrl };
    } catch (err) {
      // A parallel click won the claim between our read and our create: hand back its session, never a second one
      // (and never the operator-facing "not eligible" wording).
      if (lostTheClaimRace(err)) {
        // the racer's own coded refusals/503 from this read propagate as they are (all tenant-safe wording);
        // a claim we cannot see yet is "try again", never open()'s operator-facing "not eligible" text
        const raced = await this.openSessionUrl(tenantId, now);
        if (raced) return { checkoutUrl: raced };
        throw this.stateUnknown(tenantId, "read");
      }
      throw err;
    }
  }

  /**
   * The stored claim's session URL while it is still payable. Null when there is no claim, or its session is
   * confirmed EXPIRED at Stripe and the claim has just been released (exactly as the `checkout.session.expired`
   * webhook would). Any other held state is the claim's own coded 409: a payment already settling must not be paid
   * twice. Stripe is the authority, and nothing is released or created on a guess:
   *  - open and still live, with a url: that url;
   *  - open but past its time (or with no url): Stripe is told to expire it, and only its reply "expired" releases;
   *  - complete (on the read or on the expire reply): the claim's AWAITING_FIRST_PAYMENT 409, nothing released;
   *  - unreadable, an unknown status, or Stripe unreachable on either call: a retryable 503, nothing touched.
   */
  private async openSessionUrl(tenantId: string, now: Date): Promise<string | null> {
    const row = (await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: { catchupState: true, catchupSessionId: true },
    })) as { catchupState: string | null; catchupSessionId: string | null } | null;
    const state = row?.catchupState ?? null;
    if (!state) return null;
    if (state !== "SESSION_OPEN" || !row?.catchupSessionId) throw claimRefusal(state)!;
    const sessionId = row.catchupSessionId;

    let session: { status?: string; url?: string | null; expires_at?: number | null } | null;
    try {
      session = await this.stripe.getCheckoutSession(sessionId);
    } catch (err) {
      throw this.stateUnknown(tenantId, "read", err);
    }
    if (session?.status === "complete") throw claimRefusal("AWAITING_FIRST_PAYMENT")!;
    if (session?.status === "expired") {
      await this.release(tenantId, session);
      return null;
    }
    if (session?.status !== "open") throw this.stateUnknown(tenantId, "read");

    const expiresMs = Number(session.expires_at ?? 0) * 1000;
    if (session.url && expiresMs > now.getTime()) return session.url;

    // open, but past its time or without a url: tell Stripe it is dead before releasing anything
    let reply: { status?: string } | null;
    try {
      reply = await this.stripe.expireCheckoutSession(sessionId);
    } catch (err) {
      // Stripe REJECTS expire() on a session that is no longer open (it was paid in the gap): look once more
      // before deciding. complete -> the claim's own refusal; expired -> release; anything else -> try again later.
      return this.afterExpireRejected(tenantId, sessionId, err);
    }
    if (reply?.status === "expired") {
      await this.release(tenantId, reply);
      return null;
    }
    if (!reply || typeof reply.status !== "string") throw this.stateUnknown(tenantId, "expire");
    throw claimRefusal("AWAITING_FIRST_PAYMENT")!; // complete (or anything but expired): never release, never recreate
  }

  private async afterExpireRejected(
    tenantId: string,
    sessionId: string,
    expireErr: unknown,
  ): Promise<null> {
    let again: { status?: string } | null;
    try {
      again = await this.stripe.getCheckoutSession(sessionId);
    } catch {
      throw this.stateUnknown(tenantId, "expire", expireErr);
    }
    if (again?.status === "complete") throw claimRefusal("AWAITING_FIRST_PAYMENT")!;
    if (again?.status === "expired") {
      await this.release(tenantId, again);
      return null;
    }
    throw this.stateUnknown(tenantId, "expire", expireErr);
  }

  /** Release the claim by the same CAS the `checkout.session.expired` webhook uses. */
  private async release(tenantId: string, expired: unknown): Promise<void> {
    this.logger.log(`payment-due: releasing the expired catch-up session of tenant ${tenantId}`);
    await this.claim.onSessionExpired(expired);
  }

  private stateUnknown(tenantId: string, step: "read" | "expire", err?: unknown) {
    this.logger.warn(
      `payment-due: could not confirm the catch-up session of tenant ${tenantId} (${step})${err ? `: ${(err as Error).message}` : ""}`,
    );
    return new ServiceUnavailableException({
      code: API_ERROR_CODES.PAYMENT_STATE_UNKNOWN,
      message: "We couldn't confirm the status of your payment just now. Try again in a moment.",
    });
  }
}
