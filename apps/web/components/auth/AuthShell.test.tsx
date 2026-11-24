import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthShell } from "@/components/auth";

// The sign-in, sign-up and password pages wear the site frame ("no old look left anywhere"): the
// same header and footer as the ready-made pages, one card in the middle, no story panel. These
// pin the parts a page can break: the landmark, the single h1, the tenant logo, the footer slot,
// the way home, and that nothing from the old story panel comes back.

type ShellProps = {
  kicker?: string;
  title?: string;
  lead?: string;
  logoUrl?: string;
  logoAlt?: string;
  footer?: ReactNode;
};

const DISTRIBUTOR: ShellProps = {
  kicker: "Distributor workspace",
  title: "Welcome back.",
  lead: "Sign in to your distributor workspace.",
};

function renderShell(props: ShellProps): HTMLElement {
  const { container } = render(
    <AuthShell audience="distributor" kicker="" title="" {...props}>
      <form aria-label="probe" />
    </AuthShell>,
  );
  return container;
}

describe("AuthShell in the site frame", () => {
  it("renders one main landmark that holds the card, inside the site header and footer", () => {
    const container = renderShell(DISTRIBUTOR);
    const mains = container.querySelectorAll("main#main-content");
    expect(mains).toHaveLength(1);
    expect(mains[0].querySelector(".rf-auth .rf-auth-card")).not.toBeNull();
    expect(container.querySelector("header.site-header")).not.toBeNull();
    expect(container.querySelector("footer.site-footer")).not.toBeNull();
  });

  it("has exactly one h1, the page title, with the kicker and lead around it", () => {
    const container = renderShell(DISTRIBUTOR);
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe("Welcome back.");
    expect(container.querySelector(".rf-kicker")?.textContent).toBe("Distributor workspace");
    expect(container.querySelector(".rf-auth-lead")?.textContent).toBe(
      "Sign in to your distributor workspace.",
    );
  });

  it("renders the children inside the card", () => {
    const container = renderShell(DISTRIBUTOR);
    expect(container.querySelector(".rf-auth-card form[aria-label='probe']")).not.toBeNull();
  });

  it("shows the workspace logo when there is one, with its alt text", () => {
    const container = renderShell({
      ...DISTRIBUTOR,
      logoUrl: "https://cdn.example/acme.png",
      logoAlt: "Acme Foods logo",
    });
    const logo = container.querySelector("img.rf-auth-tenant-logo");
    expect(logo?.getAttribute("src")).toBe("https://cdn.example/acme.png");
    expect(logo?.getAttribute("alt")).toBe("Acme Foods logo");
  });

  it("shows no logo when there is none", () => {
    expect(renderShell(DISTRIBUTOR).querySelector("img.rf-auth-tenant-logo")).toBeNull();
  });

  it("keeps the page's footer links, then Need help? last, pointing at the contact page", () => {
    const container = renderShell({ ...DISTRIBUTOR, footer: <a href="/signup">Create account</a> });
    const bar = container.querySelector(".rf-auth-footer") as HTMLElement;
    expect(bar.querySelector(".rf-auth-footer-links a")?.getAttribute("href")).toBe("/signup");
    const last = bar.lastElementChild as HTMLAnchorElement;
    expect(last.textContent).toBe("Need help?");
    expect(last.getAttribute("href")).toBe("/contact");
  });

  it("renders the footer slot even when the page passes none", () => {
    expect(renderShell(DISTRIBUTOR).querySelector(".rf-auth-footer-links")).not.toBeNull();
  });

  it("leads home from the header logo, and has no back link of its own", () => {
    const container = renderShell(DISTRIBUTOR);
    expect(container.querySelector("header a.brand")?.getAttribute("href")).toBe("/");
    expect(container.querySelector(".rf-back")).toBeNull();
  });

  it("brings back nothing from the old story panel", () => {
    const html = renderShell(DISTRIBUTOR).innerHTML;
    for (const gone of [
      "rf-auth-story",
      "rf-auth-orbit",
      "rf-auth-ai",
      "AI purchase-invoice scanning",
      "Order RF-1042",
      "One brand. One connected workflow.",
      "A clearer picture of your business.",
    ]) {
      expect(html).not.toContain(gone);
    }
  });
});

// SA-1211: a store (buyer) arriving from an invite or a verify link is not a prospect, so the
// marketing "Start free trial" button is gone from the retailer doors; the distributor doors keep it.
describe("AuthShell trial button", () => {
  const trialLinks = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("a")).filter((a) =>
      /start free trial/i.test(a.textContent ?? ""),
    );

  it("keeps Start free trial on the distributor doors", () => {
    expect(trialLinks(renderShell(DISTRIBUTOR)).length).toBeGreaterThan(0);
  });

  it("shows no Start free trial link on the retailer doors (header, phone menu or footer)", () => {
    const { container } = render(
      <AuthShell audience="retailer" kicker="Retailer account" title="Confirm your email.">
        <form aria-label="probe" />
      </AuthShell>,
    );
    expect(trialLinks(container)).toHaveLength(0);
  });
});
