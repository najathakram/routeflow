import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  passwordPolicyErrors,
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_PATTERN,
} from "@routeflow/types";
import { ChangePasswordDto } from "../auth/dto/change-password.dto";
import {
  PASSWORD_MIN_LENGTH as API_MIN,
  PASSWORD_POLICY_PATTERN as API_PATTERN,
} from "./password-policy";

/**
 * #2429: ONE password policy. The API keeps a LOCAL copy (common/password-policy.ts — it cannot
 * value-import @routeflow/types, whose entry is raw TS; check-transitions.ts precedent), used by
 * every password DTO; web and mobile use @routeflow/types. This pins the two copies equal AND the
 * real server DTO validation against the clients' passwordPolicyErrors: every sample the server
 * rejects, the clients reject, and vice versa.
 */
describe("password policy parity (#2429)", () => {
  it("the API's local copy equals @routeflow/types'", () => {
    expect(API_MIN).toBe(PASSWORD_MIN_LENGTH);
    expect(API_PATTERN.source).toBe(PASSWORD_POLICY_PATTERN.source);
    expect(API_PATTERN.flags).toBe(PASSWORD_POLICY_PATTERN.flags);
  });

  it.each([
    ["Fresh123", true],
    ["Fresh!pass", true],
    ["Aa1aaaaa", true],
    ["ABCDEFG1", false], // no lowercase — the #2429 mobile gap
    ["abcdefg1", false], // no uppercase
    ["Abcdefgh", false], // no number or special
    ["Ab1", false], // too short
    ["Abcdef_1", true],
    ["Abcdefg_", false], // "_" is a word character, not a special
  ])("%s: server valid = %s, and the clients agree", async (pw, serverValid) => {
    const dto = plainToInstance(ChangePasswordDto, { currentPassword: "x", newPassword: pw });
    const errors = await validate(dto);
    expect(errors.length === 0).toBe(serverValid);
    expect(passwordPolicyErrors(pw).length === 0).toBe(serverValid);
  });
});
