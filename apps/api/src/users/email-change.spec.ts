import {
  EMAIL_CHANGE_LINK_TTL_MS,
  emailChangeNeedsHold,
  hashEmailChangeToken,
  issueEmailChange,
  maskEmail,
} from "./email-change";

/** B461 (SA-1116): the pure parts of a held login-email change. The DB rows are in email-change-b461.db.spec.ts. */
describe("emailChangeNeedsHold (the one predicate)", () => {
  it("a user who has never signed in is written at once", () => {
    expect(emailChangeNeedsHold({ lastLoginAt: null })).toBe(false);
  });

  it("a user who has signed in holds", () => {
    expect(emailChangeNeedsHold({ lastLoginAt: new Date("2026-11-01T00:00:00Z") })).toBe(true);
  });

  it("fails closed: a missing user or an unknown lastLoginAt holds", () => {
    expect(emailChangeNeedsHold(undefined)).toBe(true);
    expect(emailChangeNeedsHold(null)).toBe(true);
    expect(emailChangeNeedsHold({})).toBe(true);
    expect(emailChangeNeedsHold({ lastLoginAt: undefined })).toBe(true);
  });

  it("forcePasswordChange is not the test: a signed-in user an admin reset still holds", () => {
    expect(
      emailChangeNeedsHold({
        lastLoginAt: new Date("2026-11-01T00:00:00Z"),
        forcePasswordChange: true,
      } as never),
    ).toBe(true);
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
