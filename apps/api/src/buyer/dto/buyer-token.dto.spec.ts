/**
 * The emailed single-use tokens are `randomBytes(32).toString("hex")` = exactly 64 hex chars.
 * The verify DTOs reject anything else at the edge, before it reaches a DB lookup.
 */
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BuyerVerifyMergeDto } from "./buyer-verify-merge.dto";
import { BuyerVerifyEmailDto } from "./buyer-verify-email.dto";

const GOOD = "ab12".repeat(16);

describe.each([
  ["BuyerVerifyMergeDto", BuyerVerifyMergeDto],
  ["BuyerVerifyEmailDto", BuyerVerifyEmailDto],
])("%s token format", (_name, Cls) => {
  const check = (token: unknown) => validate(plainToInstance(Cls, { token }));

  it("accepts a 64-char hex token", async () => {
    expect(await check(GOOD)).toHaveLength(0);
    expect(await check("A".repeat(64))).toHaveLength(0);
  });

  it("rejects a short token", async () => {
    const errors = await check("abc123");
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe("token");
  });

  it("rejects a too-long token", async () => {
    expect(await check(GOOD + "a")).toHaveLength(1);
  });

  it("rejects a 64-char non-hex token", async () => {
    const errors = await check("z".repeat(64));
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0].constraints ?? {})).toContain("isHexadecimal");
  });

  it("rejects empty and non-string tokens", async () => {
    expect(await check("")).not.toHaveLength(0);
    expect(await check(12345)).not.toHaveLength(0);
  });
});
