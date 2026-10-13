import { uuidv5 } from "./uuidv5";

describe("uuidv5 (RFC 4122 section 4.3, local helper)", () => {
  it("matches the RFC vector for the DNS namespace", () => {
    expect(uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });

  it("is deterministic, sets version 5 and the RFC variant bits", () => {
    const ns = "a23aad82-7f3e-4540-a470-5476bbe31766";
    const a = uuidv5("order-1:0", ns);
    expect(uuidv5("order-1:0", ns)).toBe(a);
    expect(uuidv5("order-1:1", ns)).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("refuses a namespace that is not a UUID", () => {
    expect(() => uuidv5("x", "not-a-uuid")).toThrow();
  });
});
