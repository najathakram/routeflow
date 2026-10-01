import { resolveEmailSender } from "./useEmailSender";

/**
 * Which address do notification emails actually go out from? A usable connected mailbox beats the
 * tenant's fully-entered SMTP (`smtpConfigured`: host + user + password), which beats RouteFlow's own
 * address. `null` = we do not know yet, so the page makes no claim (fail closed, never a wrong one).
 */
const NOW = new Date("2026-09-30T12:00:00.000Z");
const smtpOn = { smtpConfigured: true, fromEmail: "billing@acme.test" };
const smtpOff = { smtpConfigured: false, fromEmail: "" };
const mailbox = (over: Record<string, unknown> = {}) => ({
  connected: true,
  status: "CONNECTED",
  accountEmail: "ops@acme.test",
  ...over,
});

describe("resolveEmailSender (#1965)", () => {
  it("a connected mailbox wins and is named", () => {
    expect(
      resolveEmailSender({ mailbox: mailbox(), smtp: smtpOn, mailboxAvailable: true, now: NOW }),
    ).toEqual({
      kind: "mailbox",
      label: "your connected mailbox (ops@acme.test)",
      mailboxAvailable: true,
    });
  });

  it("a revoked mailbox falls through; a throttled one only while its window is still open", () => {
    const base = { smtp: smtpOn, mailboxAvailable: true, now: NOW };
    expect(resolveEmailSender({ ...base, mailbox: mailbox({ status: "REVOKED" }) })?.kind).toBe(
      "smtp",
    );
    // window still open: mail is falling back to SMTP right now
    expect(
      resolveEmailSender({
        ...base,
        mailbox: mailbox({ status: "THROTTLED", throttledUntil: "2026-09-30T13:00:00.000Z" }),
      })?.kind,
    ).toBe("smtp");
    // window already over: the mailbox is the sender again
    expect(
      resolveEmailSender({
        ...base,
        mailbox: mailbox({ status: "THROTTLED", throttledUntil: "2026-09-30T11:00:00.000Z" }),
      })?.kind,
    ).toBe("mailbox");
  });

  it("SMTP is keyed on smtpConfigured (password included) and labelled by fromEmail, never smtpUser", () => {
    expect(
      resolveEmailSender({ mailbox: null, smtp: smtpOn, mailboxAvailable: false, now: NOW }),
    ).toEqual({
      kind: "smtp",
      label: "your SMTP account (billing@acme.test)",
      mailboxAvailable: false,
    });
    // host + user saved but no password: smtpConfigured is false, so this is NOT an SMTP sender
    expect(
      resolveEmailSender({
        mailbox: null,
        smtp: { smtpConfigured: false, fromEmail: "billing@acme.test" },
        mailboxAvailable: false,
        now: NOW,
      })?.kind,
    ).toBe("default");
    // configured without a From address: name the account without inventing an address
    expect(
      resolveEmailSender({
        mailbox: null,
        smtp: { smtpConfigured: true, fromEmail: "" },
        mailboxAvailable: false,
        now: NOW,
      })?.label,
    ).toBe("your SMTP account");
  });

  it("nothing configured is RouteFlow's address", () => {
    expect(
      resolveEmailSender({ mailbox: null, smtp: smtpOff, mailboxAvailable: false, now: NOW }),
    ).toEqual({ kind: "default", label: "RouteFlow's address", mailboxAvailable: false });
  });

  it("FAILS CLOSED: unknown SMTP settings, or a mailbox add-on whose status is not known yet, claim nothing", () => {
    expect(
      resolveEmailSender({ mailbox: null, smtp: undefined, mailboxAvailable: false, now: NOW }),
    ).toBeNull();
    // add-on present but the mailbox query has not succeeded: a connected mailbox may be the real sender
    expect(
      resolveEmailSender({
        mailbox: undefined,
        smtp: smtpOn,
        mailboxAvailable: true,
        mailboxKnown: false,
        now: NOW,
      }),
    ).toBeNull();
  });
});
