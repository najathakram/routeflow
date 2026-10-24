import { redactAddresses } from "./redact-addresses";

describe("redactAddresses", () => {
  it("masks the local part and keeps the domain", () => {
    expect(redactAddresses("rejected jane@acme.example now")).toBe("rejected ***@acme.example now");
  });

  it("masks IPv4 and IPv6 literals", () => {
    expect(redactAddresses("connect 10.1.2.3 failed")).toBe("connect [address] failed");
    expect(redactAddresses("connect fe80::1:2 failed")).toBe("connect [address] failed");
  });

  it("leaves a bare user@localhost and plain text alone", () => {
    expect(redactAddresses("user@localhost")).toBe("user@localhost");
    expect(redactAddresses("Mailbox full")).toBe("Mailbox full");
  });

  it("masks an apostrophe local part entirely", () => {
    const out = redactAddresses("to jane.o'brien@x.com bounced");
    expect(out).toBe("to ***@x.com bounced");
    expect(out).not.toContain("jane");
    expect(out).not.toContain("brien");
  });

  it("masks a quoted local part with a space", () => {
    const out = redactAddresses('to "jane doe"@acme.example bounced');
    expect(out).toBe("to ***@acme.example bounced");
  });

  it("masks a quoted local part with an escaped quote", () => {
    const out = redactAddresses('to "ja\\"ne"@acme.example bounced');
    expect(out).toBe("to ***@acme.example bounced");
    expect(out).not.toContain("ne");
  });

  it("masks BEFORE capping: an address straddling the 4096 boundary does not leak", () => {
    const input = "a ".repeat(2045) + "secretuser@acme.example tail";
    const out = redactAddresses(input);
    expect(out).not.toContain("secretuser");
    expect(out).not.toContain("secret");
    expect(out.length).toBeLessThanOrEqual(4096);
  });

  it("a 50k-char hostile no-@ string completes quickly", () => {
    for (const filler of ["a".repeat(50_000), "a.".repeat(25_000), '"'.repeat(50_000)]) {
      const t = Date.now();
      redactAddresses(filler);
      expect(Date.now() - t).toBeLessThan(500);
    }
  });
});
