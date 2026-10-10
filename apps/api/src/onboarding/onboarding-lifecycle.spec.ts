import { BadRequestException } from "@nestjs/common";
import { median, reminderEmailHtml } from "./onboarding-lifecycle.service";
import { OnboardingController } from "./onboarding.controller";

describe("onboarding lifecycle (#2159 S5) — pure parts", () => {
  it("median: null for no data, middle value (or mean of the two middles), one decimal", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([0.04, 0.06])).toBe(0.1);
  });

  it("the reminder email escapes every value and never carries a link", () => {
    const html = reminderEmailHtml({
      contactName: "<b>Pat</b> Example",
      companyName: "Acme & <Sons>",
      owed: ["Tax & compliance", "<script>x</script>"],
      linkSentOn: new Date("2030-01-02T10:00:00Z"),
      linkExpiresOn: new Date("2030-02-01T10:00:00Z"),
    });
    expect(html).toContain("Hi &lt;b&gt;Pat&lt;/b&gt;,");
    expect(html).toContain("Acme &amp; &lt;Sons&gt;");
    expect(html).toContain("<li>Tax &amp; compliance</li>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("2030-01-02");
    expect(html).toContain("2030-02-01");
    expect(html).not.toMatch(/href=|token=|https?:\/\//);
  });

  it("the funnel route refuses a window whose `from` is not before `to`", () => {
    const lifecycle = { funnel: jest.fn() };
    const ctrl = new OnboardingController({} as never, {} as never, lifecycle as never);
    expect(() => ctrl.funnel({ from: "2030-02-01T00:00:00Z", to: "2030-01-01T00:00:00Z" })).toThrow(
      BadRequestException,
    );
    expect(lifecycle.funnel).not.toHaveBeenCalled();
    ctrl.funnel({ from: "2030-01-01T00:00:00Z", to: "2030-02-01T00:00:00Z" });
    expect(lifecycle.funnel).toHaveBeenCalledWith(
      new Date("2030-01-01T00:00:00Z"),
      new Date("2030-02-01T00:00:00Z"),
    );
  });
});
