import { createHash } from "crypto";
import { ConflictException, Logger, ServiceUnavailableException } from "@nestjs/common";
import type Stripe from "stripe";
import type { TenantSubscription } from "@prisma/client";
import type { CheckoutStart } from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../common/db-locks";
import type { PrismaService } from "../prisma/prisma.service";
import type { StripeService } from "./stripe.service";
import {
  TENANT_PRICE_LOCK_FAMILY,
  TENANT_PRICE_LOCK_SELF_SERVE_WAIT_MS,
  TENANT_PRICE_LOCK_WAIT_MS,
} from "./price-lock";
import {
  checkoutStartFromSession,
  checkoutUiMode,
  withCheckoutPolicy,
  type CheckoutSurface,
} from "./checkout-session-params";

/**
 * W-1338 / SA-1267 PR-1: the ONE slot for a business's subscription Checkout Session (admin link and Pay now alike).
 * Under the tenant-price lock the tenant's sessions are listed from Stripe (filtered on `metadata.tenantId`): an open,
 * unexpired, hosted one with the same terms (a hash in its metadata) is reused; any other open one is expired; a
 * complete one the webhook has not applied is "Payment in progress"; a list failure or lock timeout is one coded 503.
 * The idempotency key is the business, its Stripe customer, the terms and the newest session id: a retried create
 * replays, a cancel starts fresh, and two businesses never share a key (Stripe scopes keys to the account).
 * URLs are re-read from Stripe: never stored, logged, audited or put in an error.
 */

const logger = new Logger("OpenCheckoutSession");
const DAY_S = 86_400;
const LIST_PAGE = 100;
/** Sessions older than this are not listed: Stripe caps a session at 24 h, and the idempotency key's predecessor is at most that old. */
const LIST_WINDOW_S = 2 * DAY_S;
/** Pages read per customer (500 sessions). A customer with more fails closed (503): a blind spot is never a green light. */
const LIST_MAX_PAGES = 5;

export interface SlotDeps {
  prisma: PrismaService;
  stripe: StripeService;
}
export interface SessionTerms {
  planKey: string;
  unitAmount: number;
  addonSkus: string[];
  /** The add-on lines as billed (amount and quantity), so a price change under the same SKU is a new term. */
  addonLines: { unitAmount: number; quantity: number }[];
  anchorAt: Date;
}
export interface OpenLink {
  kind: "card" | "catch_up";
  url: string;
  expiresAt: string;
}
type Sess = Stripe.Checkout.Session;
type SubRow = Pick<
  TenantSubscription,
  "stripeCustomerId" | "stripeSubId" | "catchupState" | "catchupSessionId"
>;

const refusal = (E: typeof ConflictException, code: string, message: string) =>
  new E({ code, message });
const unavailable = () =>
  refusal(
    ServiceUnavailableException,
    API_ERROR_CODES.CHECKOUT_SLOT_UNAVAILABLE,
    "We couldn't reach our payment provider just now. Nothing was changed. Please try again.",
  );
const inProgress = () =>
  refusal(
    ConflictException,
    API_ERROR_CODES.CHECKOUT_PAYMENT_IN_PROGRESS,
    "Payment in progress. Check again in a moment.",
  );
const notExpired = () =>
  refusal(
    ConflictException,
    API_ERROR_CODES.CHECKOUT_LINK_NOT_EXPIRED,
    "The open payment link could not be closed, so nothing was changed. Please try again.",
  );

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const subIdOf = (v: unknown) => (typeof v === "string" ? v : ((v as { id?: string })?.id ?? null));

/** Run `fn` under the tenant-price lock; a timeout or an unreachable lock is the one coded 503 and `fn` never ran. */
export async function underSlotLock<T>(
  tenantId: string,
  fn: () => Promise<T>,
  waitMs = TENANT_PRICE_LOCK_WAIT_MS,
): Promise<T> {
  try {
    const r = await withAdvisoryLock(
      {
        family: TENANT_PRICE_LOCK_FAMILY,
        key: tenantId,
        mode: "wait",
        waitMs,
      },
      fn,
    );
    if (!r.acquired) throw unavailable();
    return r.value;
  } catch (e) {
    if (e instanceof LockTimeoutError || e instanceof LockUnavailableError) throw unavailable();
    throw e;
  }
}

const readRow = (d: SlotDeps, tenantId: string) =>
  d.prisma.tenantSubscription.findUnique({
    where: { tenantId },
    select: {
      stripeCustomerId: true,
      stripeSubId: true,
      catchupState: true,
      catchupSessionId: true,
    },
  }) as Promise<SubRow | null>;

/** The business's own sessions, newest first, every page up to the cap. Fails closed: a list error or overflow is the coded 503. */
async function tenantSessions(
  d: SlotDeps,
  tenantId: string,
  customerId: string,
  status?: "open",
): Promise<Sess[]> {
  try {
    const all: Sess[] = [];
    let after: string | undefined;
    for (let n = 0; n < LIST_MAX_PAGES; n++) {
      const page = await d.stripe.client.checkout.sessions.list({
        customer: customerId,
        created: { gte: Math.floor(Date.now() / 1000) - LIST_WINDOW_S },
        limit: LIST_PAGE,
        ...(status ? { status } : {}),
        ...(after ? { starting_after: after } : {}),
      });
      all.push(...(page.data as Sess[]));
      if (!page.has_more) return all.filter((s) => s.metadata?.tenantId === tenantId);
      after = page.data[page.data.length - 1].id;
    }
    throw new Error(`more than ${LIST_MAX_PAGES * LIST_PAGE} sessions on one customer`);
  } catch (err) {
    logger.error(`tenant ${tenantId}: session list failed: ${(err as Error)?.message}`);
    throw unavailable();
  }
}

/** A complete session (inside Stripe's 24 h window) whose subscription the webhook has not yet stored. */
const hasUnapplied = (sessions: Sess[], row: SubRow | null) =>
  sessions.some(
    (s) =>
      s.status === "complete" &&
      Date.now() / 1000 - s.created < DAY_S &&
      subIdOf(s.subscription) !== (row?.stripeSubId ?? null),
  );

/** Expire every open session in `sessions`. A failure on a still-live one refuses (a stale session could revert a plan). */
async function closeOpen(d: SlotDeps, tenantId: string, sessions: Sess[]): Promise<void> {
  for (const s of sessions.filter((x) => x.status === "open")) {
    try {
      await d.stripe.client.checkout.sessions.expire(s.id);
    } catch (err) {
      logger.error(`tenant ${tenantId}: expire ${s.id} failed: ${(err as Error)?.message}`);
      if (s.expires_at * 1000 > Date.now()) throw notExpired();
    }
  }
}

/** What the slot bills: the hashed terms and the full create body (without the hash). */
export interface SlotOffer {
  terms: SessionTerms;
  params: Stripe.Checkout.SessionCreateParams;
}
/**
 * Reads the business's terms. The slot calls it ONLY while it holds the tenant-price lock, after the unapplied
 * check (price-lock.ts: lock, then read). It takes no input: a caller gives the slot ids, never values.
 */
export type SlotOfferReader = () => Promise<SlotOffer>;

const termsHash = (terms: SessionTerms, surface: CheckoutSurface) =>
  sha(
    JSON.stringify([
      terms.planKey,
      terms.unitAmount,
      [...terms.addonSkus].sort(),
      terms.addonLines.map((l) => [l.unitAmount, l.quantity]).sort(),
      terms.anchorAt.getTime(),
      checkoutUiMode(surface),
    ]),
  ).slice(0, 32);

/**
 * Open (or reuse) the business's one session for the terms `readOffer` returns under the lock.
 * Hosted sessions only are reused: an embedded one has no url to hand a second click.
 */
export async function openCheckoutSession(
  d: SlotDeps,
  a: { tenantId: string; customerId: string; surface: CheckoutSurface; readOffer: SlotOfferReader },
): Promise<CheckoutStart> {
  return underSlotLock(
    a.tenantId,
    async () => {
      const sessions = await tenantSessions(d, a.tenantId, a.customerId);
      if (hasUnapplied(sessions, await readRow(d, a.tenantId))) throw inProgress();
      const { terms, params } = await a.readOffer(); // the ONLY term read, under the lock
      const hash = termsHash(terms, a.surface);
      const live = sessions.find(
        (s) =>
          s.status === "open" &&
          !!s.url &&
          s.expires_at * 1000 > Date.now() &&
          s.metadata?.termsHash === hash,
      );
      if (live) return checkoutStartFromSession({ id: live.id, url: live.url });
      await closeOpen(d, a.tenantId, sessions);
      const session = await d.stripe.client.checkout.sessions.create(
        withCheckoutPolicy(
          { ...params, metadata: { ...params.metadata, termsHash: hash } },
          { surface: a.surface },
        ),
        {
          idempotencyKey: `rf-slot-${sha(
            `${a.tenantId}:${a.customerId}:${hash}:${sessions[0]?.id ?? "none"}`,
          )}`,
        },
      );
      logger.log(`session ${session.id} opened for tenant ${a.tenantId}`);
      return checkoutStartFromSession(session);
    },
    // the tenant's own click waits briefly (the pool is small), the admin link waits as every admin price writer does
    a.surface === "TENANT_SELF" ? TENANT_PRICE_LOCK_SELF_SERVE_WAIT_MS : undefined,
  );
}

/**
 * Expire the business's open sessions before a plan or price change commits. The CALLER holds the tenant-price lock
 * ACROSS the whole change (upgrade, subscribe, downgrade, the plan edit and the fee save all take it before this call
 * and keep it through their write), and the slot reads its terms under the same lock, so a Pay now cannot open a
 * session at the old terms between the expire and the commit. A
 * complete-but-unapplied session or a failed expire refuses the change with a code: completion writes `planKey`
 * from the session's metadata. The unapplied check stays closed for the 24 h a session can still complete in.
 */
export async function expireOpenCheckoutSessions(
  d: SlotDeps,
  tenantId: string,
  /** A subscription row the caller has just read (customer and subscription ids), to spare a second read. */
  known?: Partial<SubRow> | null,
): Promise<void> {
  const row = known === undefined ? await readRow(d, tenantId) : (known as SubRow | null);
  if (!row?.stripeCustomerId) return;
  const sessions = await tenantSessions(d, tenantId, row.stripeCustomerId);
  if (hasUnapplied(sessions, row)) throw inProgress();
  await closeOpen(d, tenantId, sessions);
}

/** The business's open payable session (an ordinary one, else the catch-up claim's), or null. Tenant-checked. */
async function findOpen(
  d: SlotDeps,
  tenantId: string,
): Promise<{ s: Sess; kind: OpenLink["kind"] } | null> {
  const row = await readRow(d, tenantId);
  if (!row) return null;
  const live = (s: Sess | undefined | null) =>
    s && s.status === "open" && !!s.url && s.expires_at * 1000 > Date.now() ? s : null;
  if (row.catchupState === "SESSION_OPEN" && row.catchupSessionId) {
    const s = live(await d.stripe.getCheckoutSession(row.catchupSessionId));
    if (s && s.metadata?.tenantId === tenantId) return { s, kind: "catch_up" };
  }
  if (!row.stripeCustomerId) return null;
  const card = live(
    (await tenantSessions(d, tenantId, row.stripeCustomerId, "open")).find((x) => live(x)),
  );
  return card ? { s: card, kind: "card" } : null;
}

export async function readOpenLink(d: SlotDeps, tenantId: string): Promise<OpenLink | null> {
  const found = await findOpen(d, tenantId);
  return found
    ? {
        kind: found.kind,
        url: found.s.url!,
        expiresAt: new Date(found.s.expires_at * 1000).toISOString(),
      }
    : null;
}

/** Cancel link: expire the open session (a catch-up claim is released by Stripe's own `expired` webhook). */
export async function cancelOpenLink(
  d: SlotDeps,
  tenantId: string,
): Promise<{ cancelled: boolean }> {
  return underSlotLock(tenantId, async () => {
    const found = await findOpen(d, tenantId);
    if (!found) return { cancelled: false };
    await closeOpen(d, tenantId, [found.s]);
    return { cancelled: true };
  });
}
