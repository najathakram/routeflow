import type { Prisma } from "@prisma/client";
import { ACCOUNT_ADMIN_WHERE } from "../billing/account-admins";
import { FIRST_RUN_KEY } from "../billing/first-run-marker";
import { AUTOMATED_WRITE_STATUSES } from "../tenant/tenant-automation";

/**
 * The signup journey: who may be mailed after sign-up, and the constants the one tick and its tests share.
 * This file is pure (no I/O). PR-1 carries the welcome only; the later setup emails are not here.
 */
export const JOURNEY_WELCOME_MILESTONE = "onboarding.welcome";
/** The claim key of the one welcome row per business. */
export const JOURNEY_WELCOME_KEY = "";
/** A `SystemConfig` row: the business turned the setup emails off. Written by the stop route, read here. */
export const JOURNEY_OFF_KEY = "signup.journeyOff";
/** A business that signed up longer ago than this is never welcomed, whatever the gate's date says. */
export const JOURNEY_WINDOW_DAYS = 30;
/** Tenants considered per tick (newest first). */
export const JOURNEY_BATCH = 200;
/** Where the welcome's one button leads (both CSV panels live there). */
export const JOURNEY_WELCOME_PATH = "/settings/import";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a tick may do. `welcome` closed = nothing; `since` = the first sign-up day that may be mailed. */
export interface JourneyGate {
  welcome: boolean;
  since: Date | null;
}

/** The only gate PR-1 ever uses: shut. No environment value can open it. */
export const JOURNEY_GATE_CLOSED: JourneyGate = Object.freeze({ welcome: false, since: null });

/**
 * Builds the link a setup email carries for stopping them. The implementation (a signed token) is not
 * registered anywhere yet, so with no provider the tick sends nothing. `webUrl` is the web origin to build on.
 */
export interface JourneyStopLinks {
  stopUrl(tenantId: string, webUrl: string): string;
}

/** Injection token for {@link JourneyStopLinks}. */
export const JOURNEY_STOP_LINKS = "JOURNEY_STOP_LINKS";

/** The earliest sign-up instant that may be welcomed: the later of `since` and `now` minus the window. */
export function journeyWindowStart(now: Date, since: Date): Date {
  const floor = new Date(now.getTime() - JOURNEY_WINDOW_DAYS * DAY_MS);
  return since.getTime() > floor.getTime() ? since : floor;
}

/**
 * Who may get the welcome (W10, W11 first half, W9). A production business, not deleted, signed up inside the
 * window, with the first-run marker (any value), not stopped, with an account admin to mail (the one shared
 * `ACCOUNT_ADMIN_WHERE`), in a status that accepts system writes (a TRIAL one also not past its end), with no
 * onboarding case or a LOST one, and not yet welcomed (so finished businesses never fill the batch).
 */
export function eligibleTenantWhere(now: Date, since: Date): Prisma.TenantWhereInput {
  return {
    deletedAt: null,
    class: "PRODUCTION",
    createdAt: { gte: journeyWindowStart(now, since) },
    AND: [
      { systemConfigs: { some: { key: FIRST_RUN_KEY } } },
      { systemConfigs: { none: { key: JOURNEY_OFF_KEY } } },
      { users: { some: ACCOUNT_ADMIN_WHERE } },
      { billingNotificationLogs: { none: { milestone: JOURNEY_WELCOME_MILESTONE } } },
      { status: { in: [...AUTOMATED_WRITE_STATUSES] } },
      { OR: [{ status: { not: "TRIAL" } }, { trialEndsAt: { gt: now } }] },
      { OR: [{ onboardingCase: { is: null } }, { onboardingCase: { is: { status: "LOST" } } }] },
    ],
  };
}
