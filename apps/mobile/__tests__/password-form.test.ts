/**
 * Pure logic behind the set/change password screens and the shared
 * forgot/reset flows: schema mode switching + endpoint selection.
 */
import {
  audienceFromParam,
  buildPasswordSchema,
  forgotPasswordEndpoint,
  passwordEndpoint,
  resetPasswordEndpoint,
  signInRouteFor,
} from "../lib/password-form";

describe("buildPasswordSchema", () => {
  const valid = { currentPassword: "old", newPassword: "Fresh123", confirmPassword: "Fresh123" };

  it("change mode requires the current password", () => {
    const schema = buildPasswordSchema("change");
    expect(schema.safeParse({ ...valid, currentPassword: "" }).success).toBe(false);
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it("set mode accepts an empty current password", () => {
    const schema = buildPasswordSchema("set");
    expect(schema.safeParse({ ...valid, currentPassword: "" }).success).toBe(true);
  });

  it.each([
    ["too short", "Sh0rt"],
    ["no uppercase", "alllower1"],
    ["no number", "NoNumbersHere"],
  ])("rejects a weak new password (%s) in both modes", (_label, newPassword) => {
    for (const mode of ["set", "change"] as const) {
      const result = buildPasswordSchema(mode).safeParse({
        ...valid,
        newPassword,
        confirmPassword: newPassword,
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects mismatched confirmation in both modes", () => {
    for (const mode of ["set", "change"] as const) {
      const result = buildPasswordSchema(mode).safeParse({
        ...valid,
        confirmPassword: "Different1",
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("endpoint selection", () => {
  it("maps audience × mode to the right password endpoint", () => {
    expect(passwordEndpoint("staff", "set")).toBe("/auth/set-password");
    expect(passwordEndpoint("staff", "change")).toBe("/auth/change-password");
    expect(passwordEndpoint("buyer", "set")).toBe("/buyer/auth/set-password");
    expect(passwordEndpoint("buyer", "change")).toBe("/buyer/auth/change-password");
  });

  it("maps audience to the right forgot/reset endpoints", () => {
    expect(forgotPasswordEndpoint("staff")).toBe("/auth/request-password-reset");
    expect(forgotPasswordEndpoint("buyer")).toBe("/buyer/auth/request-password-reset");
    expect(resetPasswordEndpoint("staff")).toBe("/auth/reset-password");
    expect(resetPasswordEndpoint("buyer")).toBe("/buyer/auth/reset-password");
  });

  it("audienceFromParam defaults to staff for anything but 'buyer'", () => {
    expect(audienceFromParam("buyer")).toBe("buyer");
    expect(audienceFromParam("staff")).toBe("staff");
    expect(audienceFromParam(undefined)).toBe("staff");
    expect(audienceFromParam("anything-else")).toBe("staff");
  });

  it("post-reset sign-in route matches the audience", () => {
    expect(signInRouteFor("staff")).toBe("/(auth)/login");
    expect(signInRouteFor("buyer")).toBe("/(auth)/customer-login");
  });
});
