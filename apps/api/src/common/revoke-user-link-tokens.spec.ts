/**
 * Unit pins for the account link-revocation helper (`revoke-user-link-tokens.ts`).
 *
 * The helper burns a client's outstanding single-use links (set-password / password-reset and the
 * buyer verification + reset twins) inside the CALLER's transaction. It issues raw SQL on purpose:
 * the tenant transaction proxy (`prisma.tenantTransaction`) stamps `tenantId` into every model
 * `where`, and these token tables have no such column, so the model delegates would throw there.
 * `$executeRaw` passes through that proxy untouched, which is what lets ONE helper serve a raw
 * `$transaction` (billing cron, buyer admin) and a tenant transaction (users, customers) alike.
 *
 * Row-level behaviour (another account's rows untouched, used / expired rows untouched) is proven
 * against a real database in `revoke-user-link-tokens.db.spec.ts`; this file pins the statement
 * shape, the id guard and the schema parity of every table / column the SQL names.
 */
import * as fs from "fs";
import * as path from "path";
import {
  revokeBuyerLinkTokens,
  revokeUserLinkTokens,
  revokeUserLinkTokensMany,
} from "./revoke-user-link-tokens";

type Call = { sql: string; values: unknown[] };

function fakeTx(counts: number[] = []) {
  const calls: Call[] = [];
  const $executeRaw = jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
    return Promise.resolve(counts.shift() ?? 0);
  });
  return { tx: { $executeRaw }, calls, $executeRaw };
}

describe("revokeUserLinkTokens", () => {
  it("burns the user's outstanding reset and email-verification links and sums the count", async () => {
    const { tx, calls } = fakeTx([2, 1]);

    const burned = await revokeUserLinkTokens(tx, "user-1");

    expect(burned).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain('UPDATE "PasswordResetToken"');
    expect(calls[0].sql).toContain('SET "usedAt"');
    expect(calls[1].sql).toContain('UPDATE "UserEmailVerificationToken"');
    expect(calls[1].sql).toContain('SET "usedAt"');
  });

  it("selects by the user id as a bound parameter, and only unused, unexpired rows", async () => {
    const { tx, calls } = fakeTx();

    await revokeUserLinkTokens(tx, "user-1");

    for (const call of calls) {
      expect(call.values).toEqual(["user-1"]);
      expect(call.sql).toContain('"userId" = ?');
      expect(call.sql).toContain('"usedAt" IS NULL');
      expect(call.sql).toContain('"expiresAt" >');
      // never interpolated into the statement text
      expect(call.sql).not.toContain("user-1");
    }
  });

  it("is idempotent: a second call finds nothing left to burn", async () => {
    const { tx } = fakeTx([3, 0]);

    expect(await revokeUserLinkTokens(tx, "user-1")).toBe(3);
    expect(await revokeUserLinkTokens(tx, "user-1")).toBe(0);
  });

  it("returns 0 when the executor reports nothing", async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(undefined) };

    expect(await revokeUserLinkTokens(tx as any, "user-1")).toBe(0);
  });

  it.each([undefined, null, "", "   ", 42, {}, ["u"]])(
    "refuses %p as a user id without touching the database",
    async (bad) => {
      const { tx, $executeRaw } = fakeTx();

      await expect(revokeUserLinkTokens(tx, bad as any)).rejects.toThrow(/non-empty string/);
      expect($executeRaw).not.toHaveBeenCalled();
    },
  );
});

describe("revokeUserLinkTokensMany", () => {
  it("burns every listed user's outstanding links, one statement per table with one array parameter", async () => {
    const { tx, calls } = fakeTx([3, 2]);

    const burned = await revokeUserLinkTokensMany(tx, ["user-1", "user-2", "user-3"]);

    expect(burned).toBe(5);
    // two tables, NOT one statement per user
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain('UPDATE "PasswordResetToken"');
    expect(calls[1].sql).toContain('UPDATE "UserEmailVerificationToken"');
    for (const call of calls) {
      expect(call.sql).toContain('"userId" = ANY(?::text[])');
      expect(call.sql).toContain('"usedAt" IS NULL');
      expect(call.sql).toContain('"expiresAt" >');
      expect(call.values).toEqual([["user-1", "user-2", "user-3"]]);
      // never interpolated into the statement text
      expect(call.sql).not.toContain("user-1");
    }
  });

  it("de-duplicates ids", async () => {
    const { tx, calls } = fakeTx();

    await revokeUserLinkTokensMany(tx, ["user-1", "user-1", "user-2"]);

    expect(calls[0].values).toEqual([["user-1", "user-2"]]);
  });

  it("an empty list issues no statement and burns nothing", async () => {
    const { tx, $executeRaw } = fakeTx();

    expect(await revokeUserLinkTokensMany(tx, [])).toBe(0);
    expect($executeRaw).not.toHaveBeenCalled();
  });

  it("returns 0 when the executor reports nothing", async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(undefined) };

    expect(await revokeUserLinkTokensMany(tx as any, ["user-1"])).toBe(0);
  });

  it.each([[[""]], [["  "]], [["u1", ""]], [[null]], [[42]], [["u1", undefined]]])(
    "refuses the id list %p without touching the database",
    async (bad) => {
      const { tx, $executeRaw } = fakeTx();

      await expect(revokeUserLinkTokensMany(tx, bad as any)).rejects.toThrow(/non-empty string/);
      expect($executeRaw).not.toHaveBeenCalled();
    },
  );

  it.each([[undefined], [null], ["user-1"]])("refuses %p as the list itself", async (bad) => {
    const { tx, $executeRaw } = fakeTx();

    await expect(revokeUserLinkTokensMany(tx, bad as any)).rejects.toThrow(/array/);
    expect($executeRaw).not.toHaveBeenCalled();
  });
});

describe("revokeBuyerLinkTokens", () => {
  it("burns both buyer twins (password reset + email verification) and sums the count", async () => {
    const { tx, calls } = fakeTx([1, 2]);

    const burned = await revokeBuyerLinkTokens(tx, "buyer-1");

    expect(burned).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain('UPDATE "BuyerPasswordResetToken"');
    expect(calls[1].sql).toContain('UPDATE "BuyerEmailVerificationToken"');
  });

  it("binds the buyer id and keeps the unused / unexpired filter on both statements", async () => {
    const { tx, calls } = fakeTx();

    await revokeBuyerLinkTokens(tx, "buyer-1");

    for (const call of calls) {
      expect(call.values).toEqual(["buyer-1"]);
      expect(call.sql).toContain('"buyerAccountId" = ?');
      expect(call.sql).toContain('"usedAt" IS NULL');
      expect(call.sql).toContain('"expiresAt" >');
      expect(call.sql).not.toContain("buyer-1");
    }
  });

  it.each([undefined, null, "", "  ", 7])(
    "refuses %p as a buyer id without touching the database",
    async (bad) => {
      const { tx, $executeRaw } = fakeTx();

      await expect(revokeBuyerLinkTokens(tx, bad as any)).rejects.toThrow(/non-empty string/);
      expect($executeRaw).not.toHaveBeenCalled();
    },
  );
});

describe("schema parity of the statements the helper issues", () => {
  const schema = fs.readFileSync(
    path.resolve(__dirname, "../../prisma/schema/tenancy.prisma"),
    "utf8",
  );

  function modelBody(name: string): string {
    const m = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
    if (!m) throw new Error(`model ${name} not found in tenancy.prisma`);
    return m[1];
  }

  it.each([
    ["PasswordResetToken", "userId"],
    ["UserEmailVerificationToken", "userId"],
    ["BuyerPasswordResetToken", "buyerAccountId"],
    ["BuyerEmailVerificationToken", "buyerAccountId"],
  ])("%s has the %s / usedAt / expiresAt columns and no @@map rename", (model, owner) => {
    const body = modelBody(model);
    for (const column of [owner, "usedAt", "expiresAt"]) {
      expect(body).toMatch(new RegExp(`^\\s+${column}\\s`, "m"));
    }
    // the SQL names the table by its model name, so a rename would silently miss every row
    expect(body).not.toContain("@@map");
  });

  it("the many-user variant burns the same table set as the single-user one", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "revoke-user-link-tokens.ts"), "utf8");
    const single = /export async function revokeUserLinkTokens\(([\s\S]*?)\n}\n/.exec(src)![1];
    const many = /export async function revokeUserLinkTokensMany\(([\s\S]*?)\n}\n/.exec(src)![1];
    const tablesOf = (body: string) =>
      [...body.matchAll(/UPDATE "([A-Za-z]+)"/g)].map((m) => m[1]).sort();
    expect(tablesOf(many)).toEqual(tablesOf(single));
  });

  it("the helper source names exactly those four tables", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "revoke-user-link-tokens.ts"), "utf8");
    const tables = [...new Set([...src.matchAll(/UPDATE "([A-Za-z]+)"/g)].map((m) => m[1]))].sort();

    expect(tables).toEqual([
      "BuyerEmailVerificationToken",
      "BuyerPasswordResetToken",
      "PasswordResetToken",
      "UserEmailVerificationToken",
    ]);
  });
});
