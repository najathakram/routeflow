import { missingMessage, missingRules, passwordErrorMessage } from "./password-policy";

const POLICY_400 = {
  response: {
    status: 400,
    data: {
      message: [
        "newPassword must contain at least one uppercase letter, one lowercase letter, and one number or special character",
      ],
    },
  },
};

describe("password policy copy", () => {
  it.each([
    ["test_tenant", "Add an uppercase letter."],
    ["Test_tenant", null],
    ["5C6AB7-E3B2041", "Add a lowercase letter."],
    ["lowercaseonly", "Add an uppercase letter and a number or symbol."],
    ["abc", "Use at least 8 characters and add an uppercase letter and a number or symbol."],
    ["Abcdef1", "Use at least 8 characters."],
    ["Valid-pass-1", null],
  ])("%s → %s", (pw, msg) => {
    expect(missingMessage(missingRules(pw))).toBe(msg);
  });

  it("a policy 400 (array) is narrowed with the password that was sent", () => {
    expect(passwordErrorMessage(POLICY_400, "5C6AB7-E3B2041")).toBe("Add a lowercase letter.");
    expect(passwordErrorMessage(POLICY_400, "test_tenant")).toBe("Add an uppercase letter.");
    expect(passwordErrorMessage(POLICY_400)).toBe(
      "Add an uppercase letter, a lowercase letter and a number or symbol.",
    );
  });

  it("only a message-less error falls back, and the fallback says Try again", () => {
    expect(passwordErrorMessage(new Error("x"))).toBe(
      "Your password couldn't be changed. Try again.",
    );
    expect(passwordErrorMessage({ response: { data: { message: [] } } })).toMatch(/Try again\.$/);
  });
});
