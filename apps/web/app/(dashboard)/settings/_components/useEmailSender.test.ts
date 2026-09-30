import { resolveEmailSender } from "./useEmailSender";

/**
 * Which address do notification emails actually go out from? Mailbox (connected, not revoked or
 * throttled) beats the tenant's SMTP account, which beats RouteFlow's own address. `null` = we
 * do not know yet, so the page shows no claim at all.
 */
describe("resolveEmailSender (#1965)", () => {
  it("a connected mailbox wins and is named", () => {
    expect(
      resolveEmailSender({
        mailbox: { connected: true, status: "CONNECTED", accountEmail: "ops@acme.test" },
        smtp: { smtpHost: "smtp.acme.test", smtpUser: "smtp@acme.test" },
      }),
    ).toEqual({ kind: "mailbox", label: "your connected mailbox (ops@acme.test)" });
  });

  it("a throttled or revoked mailbox falls through to SMTP, then to RouteFlow's address", () => {
    const smtp = { smtpHost: "smtp.acme.test", smtpUser: "smtp@acme.test" };
    for (const status of ["THROTTLED", "REVOKED"]) {
      expect(
        resolveEmailSender({
          mailbox: { connected: true, status, accountEmail: "ops@acme.test" },
          smtp,
        })?.kind,
      ).toBe("smtp");
    }
    expect(
      resolveEmailSender({
        mailbox: { connected: true, status: "REVOKED", accountEmail: "ops@acme.test" },
        smtp: { smtpHost: null, smtpUser: null },
      })?.kind,
    ).toBe("default");
  });

  it("saved SMTP is named; nothing configured is RouteFlow's address", () => {
    expect(
      resolveEmailSender({
        mailbox: null,
        smtp: { smtpHost: "smtp.acme.test", smtpUser: "smtp@acme.test" },
      }),
    ).toEqual({ kind: "smtp", label: "your SMTP account (smtp@acme.test)" });
    expect(resolveEmailSender({ mailbox: null, smtp: { smtpHost: "", smtpUser: "" } })).toEqual({
      kind: "default",
      label: "RouteFlow's address",
    });
  });

  it("returns null while the SMTP settings are unknown (never a wrong claim)", () => {
    expect(resolveEmailSender({ mailbox: null, smtp: undefined })).toBeNull();
  });
});
