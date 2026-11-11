import {
  hasNeverSignedIn,
  SIGN_IN_TIMESTAMP_RELIABLE_FROM,
} from "../auth/verification-link-eligibility";
import {
  EMAIL_CHANGE_LINK_TTL_MS,
  emailChangeNeedsHold,
  hashEmailChangeToken,
  issueEmailChange,
  maskEmail,
} from "./email-change";

/** B461 (SA-1116): the pure parts of a held login-email change. The DB rows are in email-change-b461.db.spec.ts. */
describe("emailChangeNeedsHold (the one predicate, shared with the sign-up link)", () => {
  // Fixed dates, never the clock: SIGN_IN_TIMESTAMP_RELIABLE_FROM is 2026-09-29.
  const AFTER = new Date("2026-10-01T00:00:00Z");
  const BEFORE = new Date("2026-09-01T00:00:00Z");
  const db = (sessions: number) => ({
    refreshToken: { count: jest.fn().mockResolvedValue(sessions) },
  });
  const never = { id: "u1", lastLoginAt: null, createdAt: AFTER };

  it("a user who has never signed in is written at once", async () => {
    const d = db(0);
    expect(await emailChangeNeedsHold(d, never)).toBe(false);
    expect(d.refreshToken.count).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });

  it("a user who has signed in holds", async () => {
    expect(
      await emailChangeNeedsHold(db(0), {
        ...never,
        lastLoginAt: new Date("2026-11-01T00:00:00Z"),
      }),
    ).toBe(true);
  });

  it("an account created before the sign-in stamp was reliable holds even with no stamp", async () => {
    expect(await emailChangeNeedsHold(db(0), { ...never, createdAt: BEFORE })).toBe(true);
  });

  it("an account that owns a refresh-token row holds even with no stamp (refresh() never stamps)", async () => {
    expect(await emailChangeNeedsHold(db(1), never)).toBe(true);
  });

  it("fails closed: a missing user, an unknown lastLoginAt or an unknown createdAt holds", async () => {
    expect(await emailChangeNeedsHold(db(0), undefined)).toBe(true);
    expect(await emailChangeNeedsHold(db(0), null)).toBe(true);
    expect(await emailChangeNeedsHold(db(0), { id: "u1", createdAt: AFTER })).toBe(true);
    expect(
      await emailChangeNeedsHold(db(0), { id: "u1", lastLoginAt: undefined, createdAt: AFTER }),
    ).toBe(true);
    expect(await emailChangeNeedsHold(db(0), { id: "u1", lastLoginAt: null })).toBe(true);
    expect(
      await emailChangeNeedsHold(db(0), { id: "u1", lastLoginAt: null, createdAt: null }),
    ).toBe(true);
  });

  it("forcePasswordChange is not the test: a signed-in user an admin reset still holds", async () => {
    expect(
      await emailChangeNeedsHold(db(0), {
        ...never,
        lastLoginAt: new Date("2026-11-01T00:00:00Z"),
        forcePasswordChange: true,
      } as never),
    ).toBe(true);
  });
});

describe("hasNeverSignedIn (the helper behind both)", () => {
  const AFTER = new Date("2026-10-01T00:00:00Z");
  const db = (n: number) => ({ refreshToken: { count: jest.fn().mockResolvedValue(n) } });

  it("is true only when no stamp, a reliable creation date and no session row all hold", async () => {
    expect(await hasNeverSignedIn(db(0), { id: "u", lastLoginAt: null, createdAt: AFTER })).toBe(
      true,
    );
    expect(await hasNeverSignedIn(db(1), { id: "u", lastLoginAt: null, createdAt: AFTER })).toBe(
      false,
    );
    expect(
      await hasNeverSignedIn(db(0), {
        id: "u",
        lastLoginAt: null,
        createdAt: SIGN_IN_TIMESTAMP_RELIABLE_FROM,
      }),
    ).toBe(true);
    expect(
      await hasNeverSignedIn(db(0), {
        id: "u",
        lastLoginAt: null,
        createdAt: new Date(SIGN_IN_TIMESTAMP_RELIABLE_FROM.getTime() - 1),
      }),
    ).toBe(false);
  });
});

describe("maskEmail", () => {
  it("names the mailbox without giving it away", () => {
    expect(maskEmail("jane.doe@example.com")).toBe("j***@e***.com");
    expect(maskEmail("a@b.co")).toBe("a***@b***.co");
  });

  it("never returns the local part", () => {
    expect(maskEmail("longlocalpart@acme.example")).not.toContain("longlocalpart");
  });

  it("an input without a usable address is fully masked", () => {
    expect(maskEmail("")).toBe("***");
    expect(maskEmail("@example.com")).toBe("***");
    expect(maskEmail("no-at-sign")).toBe("***");
  });
});

describe("issueEmailChange", () => {
  const fakeDb = () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const db = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join("?"), values });
        return 1;
      },
    };
    return { db: db as never, calls };
  };

  it("burns the user's live rows first, then writes one row holding only the hash of the token", async () => {
    const { db, calls } = fakeDb();
    const now = new Date("2026-11-09T12:00:00Z");
    const token = await issueEmailChange(
      db,
      { userId: "u1", fromEmail: "old@x.test", toEmail: "new@x.test", requestedByUserId: "admin1" },
      now,
    );

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toMatch(/^UPDATE "UserEmailChange" SET "usedAt" = \?/);
    expect(calls[0].sql).toContain('"usedAt" IS NULL');
    expect(calls[1].sql).toMatch(/^INSERT INTO "UserEmailChange"/);
    // the raw token is never a bound value, its hash is
    expect(calls[1].values).not.toContain(token);
    expect(calls[1].values).toContain(hashEmailChangeToken(token));
    expect(calls[1].values).toEqual(
      expect.arrayContaining(["u1", "old@x.test", "new@x.test", "admin1"]),
    );
  });

  it("the link lives 24 hours and each request gets its own token", async () => {
    expect(EMAIL_CHANGE_LINK_TTL_MS).toBe(24 * 60 * 60 * 1000);
    const { db, calls } = fakeDb();
    const now = new Date("2026-11-09T12:00:00Z");
    const a = await issueEmailChange(
      db,
      { userId: "u1", fromEmail: "a@x.test", toEmail: "b@x.test", requestedByUserId: "u1" },
      now,
    );
    const b = await issueEmailChange(
      db,
      { userId: "u1", fromEmail: "a@x.test", toEmail: "c@x.test", requestedByUserId: "u1" },
      now,
    );
    expect(a).not.toBe(b);
    const expiresAt = calls[1].values.find((v) => v instanceof Date && v.getTime() > now.getTime());
    expect((expiresAt as Date).getTime()).toBe(now.getTime() + EMAIL_CHANGE_LINK_TTL_MS);
  });
});
