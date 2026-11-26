import { withCopyNote } from "./invoice-email-copy";

describe("withCopyNote (W-1443 T22)", () => {
  it("adds the copy line only when a copy was delivered", () => {
    expect(withCopyNote("Sent to buyer@acme.test.", "ops@acme.test")).toBe(
      "Sent to buyer@acme.test. A copy went to you.",
    );
    expect(withCopyNote("Sent to buyer@acme.test.", undefined)).toBe("Sent to buyer@acme.test.");
    expect(withCopyNote("Sent to buyer@acme.test.", null)).toBe("Sent to buyer@acme.test.");
    expect(withCopyNote("Sent to buyer@acme.test.", "")).toBe("Sent to buyer@acme.test.");
  });

  it("closes a sentence that has no period before appending", () => {
    expect(withCopyNote("Sent to buyer@acme.test", "ops@acme.test")).toBe(
      "Sent to buyer@acme.test. A copy went to you.",
    );
  });
});
