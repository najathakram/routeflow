import { signIn } from "../email/routeflow-mail";
import { welcomeEmail } from "./signup-journey.templates";

const BASE = {
  businessName: "Acme Supply",
  webUrl: "https://app.test",
  workspaceId: "acme-supply",
  stopUrl: "https://app.test/email-stop#t=abc.def",
};

describe("welcomeEmail (T4)", () => {
  it("has the draft subject, heading, three steps, the button and the signer", () => {
    const m = welcomeEmail(BASE);
    expect(m.subject).toBe("Welcome to RouteFlow, Acme Supply");
    expect(m.html).toContain("You&#39;re in. Here&#39;s how to start.");
    for (const line of [
      "Three steps get you from sign-up to your first invoice:",
      "1. Add your products and customers.",
      "2. Take your first order.",
      "3. Send your first invoice.",
      "The RouteFlow team",
    ]) {
      expect(m.html).toContain(line);
      expect(m.text).toContain(line);
    }
    expect(m.html).toContain('href="https://app.test/settings/import"');
    expect(m.html).toContain("Add your products and customers</a>");
    expect(m.text).toContain("Add your products and customers: https://app.test/settings/import");
  });

  it("the stop link is a real anchor with the exact href, and never markdown", () => {
    const m = welcomeEmail(BASE);
    expect(m.html).toContain(`href="${BASE.stopUrl}"`);
    expect(m.html).toContain(">Stop these setup emails</a>");
    expect(m.html).not.toContain("[Stop these setup emails](");
    expect(m.text).not.toContain("[Stop these setup emails](");
    expect(m.text).toContain(`Stop these setup emails: ${BASE.stopUrl}`);
  });

  it("carries the sign-in line with the Workspace ID, built by the exported signIn()", () => {
    const m = welcomeEmail(BASE);
    const line = signIn(BASE.webUrl, BASE.workspaceId);
    expect(m.html).toContain(line.html);
    // the text part is derived from the html, so it holds the same sentence with the link spelled out
    expect(m.text).toContain("To sign in, go to https://app.test/login");
    expect(m.text).toContain("enter your Workspace ID: acme-supply.");
    expect(line.text).toContain("Workspace ID: acme-supply");
    expect(m.html).toContain("Workspace ID: <strong>acme-supply</strong>");
    expect(m.text).toContain("Workspace ID: acme-supply");
  });

  it("states the true reason in the footer, with the raw name escaped once", () => {
    const name = 'Acme <b>&"Co"';
    const m = welcomeEmail({ ...BASE, businessName: name, workspaceId: "acme-co" });
    expect(m.html).toContain(
      "You&#39;re getting this because you started a RouteFlow trial for Acme &lt;b&gt;&amp;&quot;Co&quot;.",
    );
    expect(m.html).not.toContain("&amp;lt;");
    expect(m.html).not.toContain("&amp;amp;");
    expect(m.html).not.toContain("<b>&");
    expect(m.text).toContain(
      `You're getting this because you started a RouteFlow trial for ${name}.`,
    );
  });

  it("promises no later emails, shows no reply line, and none of the banned claims", () => {
    const m = welcomeEmail(BASE);
    const all = `${m.subject}\n${m.html}\n${m.text}`;
    expect(all).not.toMatch(
      /import everything|all your columns|\bAI\b|delivery|\$\d|\d+ (products|customers)/i,
    );
    expect(all).not.toMatch(
      /reply to this|more emails|follow up|we.ll send|next few days|tomorrow/i,
    );
    expect(all).not.toMatch(/undefined|null|NaN/);
  });

  it("requires a stop link at the type level", () => {
    const { stopUrl: _omitted, ...withoutStop } = BASE;
    // @ts-expect-error stopUrl is REQUIRED (W3): a welcome with no stop link does not compile
    expect(() => welcomeEmail(withoutStop)).not.toThrow();
  });
});
