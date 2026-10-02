/**
 * SA-598 P1: the ONE sub-then-email resolver and CAS link, shared by Google and Apple (the #2495
 * defect: a nondeterministic `OR: [{ sub }, { email }]` and a check-then-update link). The matrix is
 * run against BOTH provider columns so a future provider edit cannot fork the rule.
 */
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { casLinkProviderId, resolveBySubThenEmail } from "./oauth-account-link";

const COLUMNS = [
  ["googleId", "google_account_mismatch"],
  ["appleId", "apple_account_mismatch"],
] as const;

describe.each(COLUMNS)("oauth-account-link (%s)", (column, mismatchCode) => {
  const BASE = { deletedAt: null };
  const row = (over: Record<string, unknown> = {}) => ({
    id: "row-1",
    email: "a@example.com",
    [column]: null,
    ...over,
  });

  describe("resolveBySubThenEmail", () => {
    it("falsy sub or email is refused before ANY query", async () => {
      for (const [sub, email] of [
        ["", "a@example.com"],
        ["sub-1", ""],
        [undefined, "a@example.com"],
        ["sub-1", undefined],
      ] as const) {
        const findFirst = jest.fn();
        await expect(
          resolveBySubThenEmail({ findFirst, baseWhere: BASE, column, sub, email }),
        ).rejects.toThrow(ForbiddenException);
        expect(findFirst).not.toHaveBeenCalled();
      }
    });

    describe("allowSubOnly (Apple: the identity token omits email after the first sign-in)", () => {
      it("a bound sub resolves with NO email, in one query", async () => {
        const bound = row({ id: "bound", [column]: "sub-1" });
        const findFirst = jest.fn().mockResolvedValueOnce(bound);
        const out = await resolveBySubThenEmail({
          findFirst,
          baseWhere: BASE,
          column,
          sub: "sub-1",
          email: undefined,
          allowSubOnly: true,
        });
        expect(out).toBe(bound);
        expect(findFirst).toHaveBeenCalledTimes(1);
      });

      it("no bound sub and no email: refused 403 after the single sub query; never an email query", async () => {
        for (const email of [undefined, null, ""]) {
          const findFirst = jest.fn().mockResolvedValue(null);
          await expect(
            resolveBySubThenEmail({
              findFirst,
              baseWhere: BASE,
              column,
              sub: "sub-1",
              email,
              allowSubOnly: true,
            }),
          ).rejects.toThrow(ForbiddenException);
          expect(findFirst).toHaveBeenCalledTimes(1);
        }
      });

      it("a falsy sub is still refused before ANY query", async () => {
        const findFirst = jest.fn();
        await expect(
          resolveBySubThenEmail({
            findFirst,
            baseWhere: BASE,
            column,
            sub: "",
            email: "a@example.com",
            allowSubOnly: true,
          }),
        ).rejects.toThrow(ForbiddenException);
        expect(findFirst).not.toHaveBeenCalled();
      });

      it("without the flag a missing email is still refused before any query (Google's contract)", async () => {
        const findFirst = jest.fn();
        await expect(
          resolveBySubThenEmail({
            findFirst,
            baseWhere: BASE,
            column,
            sub: "sub-1",
            email: undefined,
          }),
        ).rejects.toThrow(ForbiddenException);
        expect(findFirst).not.toHaveBeenCalled();
      });
    });

    it("the sub match wins over a row that merely shares the email (email never queried)", async () => {
      const bound = row({ id: "bound", [column]: "sub-1", email: "other@example.com" });
      const findFirst = jest.fn().mockResolvedValueOnce(bound);
      const out = await resolveBySubThenEmail({
        findFirst,
        baseWhere: BASE,
        column,
        sub: "sub-1",
        email: "a@example.com",
      });
      expect(out).toBe(bound);
      expect(findFirst).toHaveBeenCalledTimes(1);
      expect(findFirst).toHaveBeenCalledWith({ where: { ...BASE, [column]: "sub-1" } });
    });

    it("falls back to the email with a pinned createdAt,id order", async () => {
      const unbound = row();
      const findFirst = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(unbound);
      const out = await resolveBySubThenEmail({
        findFirst,
        baseWhere: BASE,
        column,
        sub: "sub-1",
        email: "a@example.com",
      });
      expect(out).toBe(unbound);
      expect(findFirst).toHaveBeenNthCalledWith(2, {
        where: { ...BASE, email: "a@example.com" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    });

    it("an email row bound to a DIFFERENT sub is a 409 (no row returned)", async () => {
      const findFirst = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(row({ [column]: "someone-else" }));
      const err = await resolveBySubThenEmail({
        findFirst,
        baseWhere: BASE,
        column,
        sub: "sub-1",
        email: "a@example.com",
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
      expect(err.message).toBe(mismatchCode);
    });

    it("no match at all resolves null", async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      await expect(
        resolveBySubThenEmail({
          findFirst,
          baseWhere: BASE,
          column,
          sub: "sub-1",
          email: "a@example.com",
        }),
      ).resolves.toBeNull();
    });
  });

  describe("casLinkProviderId", () => {
    it("links with a CAS scoped to the null column plus the caller's extra where; linked=true", async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const findUnique = jest.fn();
      const r = row();
      const out = await casLinkProviderId({
        updateMany,
        findUnique,
        row: r,
        column,
        sub: "sub-1",
        data: { forcePasswordChange: false },
        extraWhere: { tenantId: "t1" },
      });
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: "row-1", tenantId: "t1", [column]: null },
        data: { [column]: "sub-1", forcePasswordChange: false },
      });
      expect(out.linked).toBe(true);
      expect(out.row).toMatchObject({ [column]: "sub-1", forcePasswordChange: false });
      expect(findUnique).not.toHaveBeenCalled();
    });

    it("a lost race that now shows a DIFFERENT sub is a 409", async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const findUnique = jest.fn().mockResolvedValue(row({ [column]: "attacker" }));
      const err = await casLinkProviderId({
        updateMany,
        findUnique,
        row: row(),
        column,
        sub: "sub-1",
        data: {},
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe(mismatchCode);
    });

    it("a lost race to the SAME sub proceeds with linked=false", async () => {
      const fresh = row({ [column]: "sub-1" });
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const findUnique = jest.fn().mockResolvedValue(fresh);
      const out = await casLinkProviderId({
        updateMany,
        findUnique,
        row: row(),
        column,
        sub: "sub-1",
        data: {},
      });
      expect(out).toEqual({ row: fresh, linked: false });
    });

    it("a lost race where the row vanished is refused", async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const findUnique = jest.fn().mockResolvedValue(null);
      await expect(
        casLinkProviderId({ updateMany, findUnique, row: row(), column, sub: "sub-1", data: {} }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("a lost CAS where the row STILL shows no sub (scope mismatch, not a race) is refused, never reported as linked", async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const findUnique = jest.fn().mockResolvedValue(row({ [column]: null }));
      await expect(
        casLinkProviderId({ updateMany, findUnique, row: row(), column, sub: "sub-1", data: {} }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("a falsy sub is refused before the write", async () => {
      const updateMany = jest.fn();
      await expect(
        casLinkProviderId({
          updateMany,
          findUnique: jest.fn(),
          row: row(),
          column,
          sub: "",
          data: {},
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(updateMany).not.toHaveBeenCalled();
    });
  });
});
