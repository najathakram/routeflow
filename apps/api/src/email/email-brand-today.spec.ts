import { BRAND } from "../common/brand";
import { renderPlatformMails } from "../testing/render-platform-mail";

/**
 * SA-1253 T3: the api reads the top level of brand.json (it has its own loader and never the site
 * overlay). Rendered with the REAL brand, every platform mail carries today's name, the logo on the
 * old host and the old mark; never `undefined`, and never the site's new asset folder.
 * The names are typed here on purpose: this pins which name the mail shows until the notice ends.
 */
jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));
jest.mock("resend", () => ({ Resend: jest.fn() }));

let out: Record<string, string>;
beforeAll(async () => {
  out = await renderPlatformMails();
});

describe("T3: platform mail shows today's brand", () => {
  it("the api brand is today's name, host and mail logo", () => {
    expect(BRAND.name).toBe("RouteFlow");
    expect(BRAND.origin).toBe("https://www.routeflow.info");
    expect(BRAND.emailLogo).toBe("/brand/routeflow-mark-192.png");
  });

  it("renders the whole set", () => {
    expect(Object.keys(out).length).toBeGreaterThan(100);
  });

  it("own-look mail carries the logo URL on the old host and today's name", () => {
    const labels = Object.keys(out).filter(
      (k) => k.endsWith("#html") && /^(verify|reset|bill-)/.test(k),
    );
    expect(labels.length).toBeGreaterThan(5);
    for (const label of labels) {
      expect(out[label]).toContain('src="https://www.routeflow.info/brand/routeflow-mark-192.png"');
      expect(out[label]).toContain('alt="RouteFlow"');
    }
  });

  it("no mail shows the new name, the new host, a hole or the site's asset folder", () => {
    for (const [label, value] of Object.entries(out)) {
      expect({ label, bad: /rovio|xrov/i.test(value) }).toEqual({ label, bad: false });
      expect({ label, bad: /\bundefined\b/.test(value) }).toEqual({ label, bad: false });
      expect({ label, bad: value.includes("img/brand/") }).toEqual({ label, bad: false });
    }
  });
});
