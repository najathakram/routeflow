import { OnboardingIntakeService } from "./onboarding-intake.service";
import { paragraphsMissingFromText } from "../testing/email-text-parity";

/**
 * W-1163: the setup email's ONLY job is to carry the setup link. The link is the button (its
 * target) and the full url is in the text part; the body paragraphs no longer repeat it. A
 * refactor that drops the cta would ship a setup email with no way in.
 */
describe("OnboardingIntakeService.issueLink: the setup email", () => {
  const prev = process.env.ONBOARDING_TOKEN_SECRET;
  beforeEach(() => {
    process.env.ONBOARDING_TOKEN_SECRET = "k".repeat(48);
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ONBOARDING_TOKEN_SECRET;
    else process.env.ONBOARDING_TOKEN_SECRET = prev;
  });

  function arrange() {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      intakeSection: { createMany: jest.fn().mockResolvedValue({}) },
      intakeAccessToken: {
        updateMany: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
      onboardingEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      onboardingCase: {
        findUnique: jest.fn().mockResolvedValue({
          id: "case-1",
          status: "OPEN",
          tenantId: null,
          contactName: "Pat Owner",
          contactEmail: "pat@acme.example",
          companyName: "Acme Wholesale LLC",
        }),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const email = { sendPlatform: jest.fn().mockResolvedValue({ delivered: true }) };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const svc = new OnboardingIntakeService(
      prisma as never,
      audit as never,
      email as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, email };
  }

  it("sends one platform email whose button and text part carry the setup link", async () => {
    const { svc, email } = arrange();
    const res = await svc.issueLink("case-1", "admin-1", true);
    expect(res.emailed).toBe(true);
    expect(email.sendPlatform).toHaveBeenCalledTimes(1);
    const mail = email.sendPlatform.mock.calls[0][0];
    expect(mail.to).toBe("pat@acme.example");
    // the link is the button's target (an href) and is in full in the text part
    expect(mail.html).toContain(`href="${res.url}"`);
    expect(mail.html).toContain(">Open your setup page</a>");
    expect(mail.text).toContain(res.url);
    expect(paragraphsMissingFromText(mail.html, mail.text)).toEqual([]);
  });
});
