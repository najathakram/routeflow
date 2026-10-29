import {
  STRIPE_CHECKOUT_APPLIED_ACTION,
  STRIPE_CHECKOUT_ENTITY,
  STRIPE_CHECKOUT_LINK_ENTITY,
  STRIPE_CHECKOUT_LINKED_ACTION,
  STRIPE_CHECKOUT_UNLINKED_ACTION,
} from "./config-snapshot-audit.constants";
import { isLinkPending } from "./link-pending";

type Row = {
  action: string;
  entityType: string;
  entityId: string;
  meta?: unknown;
  createdAt: Date;
};

/** A tiny in-memory AuditLog that answers the `findFirst` shape `isLinkPending` uses. */
function client(rows: Row[]) {
  return {
    auditLog: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const hit = rows
          .filter(
            (r) =>
              (where.action === undefined || r.action === where.action) &&
              (where.entityType === undefined || r.entityType === where.entityType) &&
              (where.entityId === undefined || r.entityId === where.entityId),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        return hit ?? null;
      }),
    },
  };
}

const linked = (sub: string, session: string, day = 1): Row => ({
  action: STRIPE_CHECKOUT_LINKED_ACTION,
  entityType: STRIPE_CHECKOUT_LINK_ENTITY,
  entityId: sub,
  meta: { sessionId: session },
  createdAt: new Date(2026, 9, day),
});
const activated = (session: string, day = 2): Row => ({
  action: STRIPE_CHECKOUT_APPLIED_ACTION,
  entityType: STRIPE_CHECKOUT_ENTITY,
  entityId: session,
  createdAt: new Date(2026, 9, day),
});
const unlinked = (sub: string, day = 3): Row => ({
  action: STRIPE_CHECKOUT_UNLINKED_ACTION,
  entityType: STRIPE_CHECKOUT_LINK_ENTITY,
  entityId: sub,
  createdAt: new Date(2026, 9, day),
});

describe("isLinkPending (SA-774 r6: LINKED marker without an ACTIVATED marker)", () => {
  it("is false with no Stripe subscription id", async () => {
    expect(await isLinkPending(client([]) as never, "t1", null)).toBe(false);
  });

  it("is false when nothing was ever linked (a legacy or stale stripeSubId is not link-pending)", async () => {
    expect(await isLinkPending(client([]) as never, "t1", "sub_acme")).toBe(false);
  });

  it("is true for a LINKED marker with no ACTIVATED marker for its session", async () => {
    const rows = [linked("sub_acme", "cs_1")];
    expect(await isLinkPending(client(rows) as never, "t1", "sub_acme")).toBe(true);
  });

  it("is false once the session's ACTIVATED marker exists", async () => {
    const rows = [linked("sub_acme", "cs_1"), activated("cs_1")];
    expect(await isLinkPending(client(rows) as never, "t1", "sub_acme")).toBe(false);
  });

  it("an ACTIVATED marker of a different session does not clear the pending link", async () => {
    const rows = [linked("sub_acme", "cs_2"), activated("cs_1")];
    expect(await isLinkPending(client(rows) as never, "t1", "sub_acme")).toBe(true);
  });

  it("is false after an UNLINKED marker that is newer than the LINKED one", async () => {
    const rows = [linked("sub_acme", "cs_1"), unlinked("sub_acme")];
    expect(await isLinkPending(client(rows) as never, "t1", "sub_acme")).toBe(false);
  });

  it("a LINKED marker for another subscription id is ignored", async () => {
    const rows = [linked("sub_other", "cs_1")];
    expect(await isLinkPending(client(rows) as never, "t1", "sub_acme")).toBe(false);
  });

  it("is false when the marker has no readable session id (open to today's behaviour, never a lockout)", async () => {
    const bad: Row = { ...linked("sub_acme", "cs_1"), meta: null };
    expect(await isLinkPending(client([bad]) as never, "t1", "sub_acme")).toBe(false);
  });
});
