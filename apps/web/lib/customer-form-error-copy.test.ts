import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_ERROR_CODES } from "@routeflow/types";
import { customerFormErrorCopy } from "./customer-form-error-copy";

/**
 * B979 (owner rule: no raw strings in the UI): the customer form's error banner shows FIXED copy.
 * It never shows axios's "Request failed with status code …", a server message, or a camelCase key.
 */
const axiosErr = (status: number, data: unknown = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });

describe("customerFormErrorCopy (B979)", () => {
  it("a refused name keeps the B956 field-labelled copy", () => {
    const err = axiosErr(400, {
      code: API_ERROR_CODES.TEXT_CELL_FORMULA_LEAD,
      field: "contactName",
      message: "contactName must not start with = + - @ or a tab/line break",
    });
    expect(customerFormErrorCopy(err)).toBe(
      "Contact name can't start with =, +, -, @ or a tab/line break.",
    );
  });

  it("the two known product sentences map to fixed copy (a closed allow-list)", () => {
    expect(
      customerFormErrorCopy(axiosErr(400, { message: "Email or username already taken" })),
    ).toBe("That email is already in use. Use a different email.");
    expect(customerFormErrorCopy(axiosErr(400, { message: "Unknown sales agent" }))).toBe(
      "That sales agent is no longer available. Pick another.",
    );
  });

  it("the customer plan cap (PLAN_GATE, meter.customers) says so", () => {
    expect(
      customerFormErrorCopy(
        axiosErr(403, {
          code: "PLAN_GATE",
          flag: "meter.customers",
          message: "This feature requires …",
        }),
      ),
    ).toBe("Your plan's customer limit has been reached. Upgrade your plan to add more customers.");
  });

  it("another plan/add-on gate gets the generic plan line, never its server text", () => {
    const text = customerFormErrorCopy(
      axiosErr(403, {
        code: "PLAN_GATE",
        flag: "x",
        message: "This feature requires the foo add-on.",
      }),
    );
    expect(text).toBe("This isn't included in your current plan.");
    expect(customerFormErrorCopy(axiosErr(403, { code: API_ERROR_CODES.ADDON_GATE }))).toBe(text);
  });

  it("a READ_ONLY 403 has its own sentence (matching the read-only toast), not the permission copy", () => {
    const text = customerFormErrorCopy(
      axiosErr(403, { code: "READ_ONLY", message: "raw guard text" }),
    );
    expect(text).toBe("Your workspace is read-only, so this action is unavailable.");
    expect(text).not.toBe(customerFormErrorCopy(axiosErr(403, {})));
  });

  it("PLAN_GATE_UNAVAILABLE (the gate service is down) is NOT the plan sentence", () => {
    const text = customerFormErrorCopy(
      axiosErr(503, { code: "PLAN_GATE_UNAVAILABLE", message: "x" }),
    );
    expect(text).toBe("Something went wrong on our side. Please try again.");
  });

  it("reads the gate through the shared parsePlanGate, with no hand-typed gate literals", () => {
    const src = readFileSync(join(__dirname, "customer-form-error-copy.ts"), "utf8");
    expect(src).toContain("parsePlanGate");
    expect(src).not.toMatch(/["']PLAN_GATE["']/);
  });

  it.each([
    [400, "Some details aren't valid. Check the form and try again."],
    [401, "You don't have permission to do that."],
    [403, "You don't have permission to do that."],
    [404, "This customer no longer exists. Refresh and try again."],
    [409, "This customer changed while you were editing. Refresh and try again."],
    [500, "Something went wrong on our side. Please try again."],
    [503, "Something went wrong on our side. Please try again."],
    [418, "Something went wrong. Please try again."],
  ])("status %s → fixed copy", (status, expected) => {
    expect(customerFormErrorCopy(axiosErr(status as number, { message: "raw server text" }))).toBe(
      expected,
    );
  });

  it("an unknown message or a class-validator array never leaks: it falls to the status copy", () => {
    const text = customerFormErrorCopy(
      axiosErr(400, { message: ["businessName should not be empty", "email must be an email"] }),
    );
    expect(text).toBe("Some details aren't valid. Check the form and try again.");
    expect(text).not.toMatch(/businessName|email must/);
    expect(customerFormErrorCopy(axiosErr(400, { message: "Something odd" }))).toBe(text);
  });

  it("no response at all (network, timeout) says so, never the axios text", () => {
    const text = customerFormErrorCopy(new Error("Network Error"));
    expect(text).toBe("We couldn't reach the server. Check your connection and try again.");
    expect(text).not.toMatch(/Network Error|status code/);
  });

  it("a null or non-object error gets the generic line", () => {
    expect(customerFormErrorCopy(null)).toBe("Something went wrong. Please try again.");
    expect(customerFormErrorCopy("boom")).toBe("Something went wrong. Please try again.");
  });
});
