import { render } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";

// T1 — apps/web/components/auth/AuthShell.test.tsx (unit, RTL) — R1, R4
// .claude/pipeline/2026-09-07-auth-redesign/test-plan.md
//
// RED GATE: `@/components/auth` does not exist yet. It is loaded through a guarded
// module-scope require so a missing module cannot collapse this suite into a
// module-not-found ERROR — every test below still reaches and fails on its own named
// oracle. The placeholder renders nothing, and every query below is non-throwing, so
// today each test fails on a VALUE (`expected "Welcome back." received null`) rather
// than on a thrown `getByRole` — the assertion that has to flip when the shell lands.

type ShellProps = {
  audience?: "distributor" | "retailer";
  kicker?: string;
  title?: string;
  lead?: string;
  logoUrl?: string;
  logoAlt?: string;
  footer?: ReactNode;
  children?: ReactNode;
};

let AuthShell: ComponentType<ShellProps> = () => null;
try {
  AuthShell =
    (require("@/components/auth") as { AuthShell?: ComponentType<ShellProps> }).AuthShell ??
    AuthShell;
} catch {
  // red gate: the module does not exist yet — T1 below is the assertion that says so.
}

const DISTRIBUTOR: ShellProps = {
  audience: "distributor",
  kicker: "Distributor workspace",
  title: "Welcome back.",
  lead: "Sign in to your distributor workspace.",
};

const RETAILER: ShellProps = {
  audience: "retailer",
  kicker: "Retailer account",
  title: "Welcome back.",
  lead: "Sign in to your retailer account.",
};

function renderShell(props: ShellProps): HTMLElement {
  const { container } = render(
    <AuthShell {...props}>
      <form aria-label="probe" />
    </AuthShell>,
  );
  return container;
}

function textOf(el: Element | null): string | null {
  return el === null ? null : (el.textContent ?? "");
}

function attrOf(el: Element | null, name: string): string | null {
  return el === null ? null : el.getAttribute(name);
}

/** Deepest element whose trimmed text is exactly `text`; null when absent. */
function elementWithText(container: HTMLElement, text: string): Element | null {
  const matches = Array.from(container.querySelectorAll("*")).filter(
    (el) => (el.textContent ?? "").trim() === text,
  );
  return matches.length === 0 ? null : matches[matches.length - 1];
}

/** Anchor whose accessible name (text or aria-label) matches `pattern`; null when absent. */
function linkNamed(container: HTMLElement, pattern: RegExp): HTMLAnchorElement | null {
  return (
    Array.from(container.querySelectorAll("a")).find(
      (a) =>
        pattern.test((a.textContent ?? "").trim()) ||
        pattern.test(a.getAttribute("aria-label") ?? ""),
    ) ?? null
  );
}

/** Readable containment oracle: "inside <sel>" / "outside <sel>" / "missing". */
function placement(el: Element | null, selector: string): string {
  if (el === null) return "missing";
  return el.closest(selector) !== null ? `inside ${selector}` : `outside ${selector}`;
}

describe("AuthShell — T1", () => {
  it("T1: @/components/auth exports AuthShell (R1)", () => {
    let mod: { AuthShell?: unknown } | null = null;
    try {
      mod = require("@/components/auth");
    } catch {
      mod = null;
    }
    expect(mod?.AuthShell).toBeDefined();
  });

  it("T1a: the shell renders a #main-content.rf-auth landmark (R1, R4)", () => {
    const container = renderShell(DISTRIBUTOR);
    const main = container.querySelector("main");
    expect({
      hasRfAuthClass: main !== null && main.classList.contains("rf-auth"),
      id: attrOf(main, "id"),
    }).toEqual({ hasRfAuthClass: true, id: "main-content" });
  });

  it('T1a: the h1 is exactly the `title` prop ("Welcome back.") (R1, R4)', () => {
    const container = renderShell(DISTRIBUTOR);
    expect(textOf(container.querySelector("h1"))).toBe("Welcome back.");
  });

  it('T1a: the distributor h2 is "A clearer picture of your business." (R1, R4)', () => {
    const container = renderShell(DISTRIBUTOR);
    expect(textOf(container.querySelector("h2"))).toBe("A clearer picture of your business.");
  });

  it('T1a: "For distributors" sits inside .rf-auth-story-copy (R1, R4)', () => {
    const container = renderShell(DISTRIBUTOR);
    expect(placement(elementWithText(container, "For distributors"), ".rf-auth-story-copy")).toBe(
      "inside .rf-auth-story-copy",
    );
  });

  it("T1a: the kicker prop renders inside .rf-auth-card (R1, R4)", () => {
    const container = renderShell(DISTRIBUTOR);
    expect(placement(elementWithText(container, "Distributor workspace"), ".rf-auth-card")).toBe(
      "inside .rf-auth-card",
    );
  });

  it("T1a: children render inside .rf-auth-card (R1, R4)", () => {
    const container = renderShell(DISTRIBUTOR);
    expect(placement(container.querySelector('form[aria-label="probe"]'), ".rf-auth-card")).toBe(
      "inside .rf-auth-card",
    );
  });

  it('T1a: the "back to website" link points at / (R1, R4)', () => {
    const container = renderShell(DISTRIBUTOR);
    expect(attrOf(linkNamed(container, /back to website/i), "href")).toBe("/");
  });

  it('T1a: the "Need help?" link points at /contact (R1, R4)', () => {
    const container = renderShell(DISTRIBUTOR);
    expect(attrOf(linkNamed(container, /need help/i), "href")).toBe("/contact");
  });

  it('T1a: a "RouteFlow home" brand link is present (R1, R4)', () => {
    const container = renderShell(DISTRIBUTOR);
    expect(linkNamed(container, /routeflow home/i) === null ? "missing" : "present").toBe(
      "present",
    );
  });

  it("T1a: the brand signature carries the standalone type metrics (R1, R4)", () => {
    // The auth shell loads no `.rf-marketing` cascade, so `.brand-signature`
    // has no stylesheet rule here — the wordmark metrics have to come from
    // `standalone`. Without it the lockup falls back to inherited 1rem/normal.
    const container = renderShell(DISTRIBUTOR);
    const brandLink = linkNamed(container, /routeflow home/i);
    expect(
      brandLink === null
        ? "missing"
        : brandLink.querySelector(".font-\\[650\\]") === null
          ? "no standalone metrics"
          : "standalone metrics",
    ).toBe("standalone metrics");
  });

  it("T1b: retailer shell swaps the story copy (R1, R4)", () => {
    const container = renderShell(RETAILER);
    // Presence and absence asserted together so neither half can pass vacuously
    // on an empty DOM.
    expect({
      heading: textOf(container.querySelector("h2")),
      retailerKicker: elementWithText(container, "For retailers") !== null,
      distributorKicker: elementWithText(container, "For distributors") !== null,
    }).toEqual({
      heading: "Stock your shelves. Stay in control.",
      retailerKicker: true,
      distributorKicker: false,
    });
  });

  it("T1c: renders the tenant logo only when logoUrl is provided (R1, R4)", () => {
    const withLogo = renderShell({ ...DISTRIBUTOR, logoUrl: "/x.png", logoAlt: "Acme" });
    const logo = withLogo.querySelector(".rf-auth-card img");
    const withoutLogo = renderShell(DISTRIBUTOR);
    // Both halves in one expectation — the "only when" half cannot pass vacuously.
    expect({
      src: attrOf(logo, "src"),
      alt: attrOf(logo, "alt"),
      imgsWithoutLogoUrl: withoutLogo.querySelectorAll(".rf-auth-card img").length,
    }).toEqual({ src: "/x.png", alt: "Acme", imgsWithoutLogoUrl: 0 });
  });

  it("T1d: footer content renders inside .rf-auth-footer before Need help? (R1, R4)", () => {
    const container = renderShell({
      ...DISTRIBUTOR,
      footer: <a href="/buyer/login">Sign in to the buyer portal</a>,
    });

    const footer = container.querySelector(".rf-auth-footer");
    const order = ((): string => {
      if (footer === null) return "no .rf-auth-footer";
      const links = Array.from(footer.querySelectorAll("a"));
      const footerIndex = links.findIndex((a) =>
        /sign in to the buyer portal/i.test(a.textContent ?? ""),
      );
      const needHelpIndex = links.findIndex((a) => /need help/i.test(a.textContent ?? ""));
      if (footerIndex < 0) return "footer prop missing from .rf-auth-footer";
      if (needHelpIndex < 0) return "Need help? missing from .rf-auth-footer";
      return footerIndex < needHelpIndex
        ? "footer prop before Need help?"
        : "footer prop after Need help?";
    })();

    expect(order).toBe("footer prop before Need help?");
  });

  it("T1e: exactly one h1 in the document; the decorative order card is aria-hidden (R1, R4)", () => {
    const container = renderShell(DISTRIBUTOR);
    // Deepest match, mirroring `elementWithText`: ux-spec.md:21 puts the order
    // label in a div that ALSO holds `.rf-auth-track`, so a childless-element
    // filter would fail a spec-shaped DOM.
    const orderCardMatches = Array.from(container.querySelectorAll("*")).filter((el) =>
      /Order RF-1042/.test(el.textContent ?? ""),
    );
    const orderCard =
      orderCardMatches.length === 0 ? null : orderCardMatches[orderCardMatches.length - 1];

    expect({
      h1Count: document.querySelectorAll("h1").length,
      orderCard:
        orderCard === null
          ? "missing"
          : orderCard.closest('[aria-hidden="true"]') !== null
            ? "aria-hidden"
            : "exposed to assistive tech",
    }).toEqual({ h1Count: 1, orderCard: "aria-hidden" });
  });

  it("T1e: the order card mirrors the source element mapping — no <small> on navy (R1, R4)", () => {
    // `.rf-auth small` paints #616b7c (~2.8:1 on the #10264d panel) and
    // `.rf-auth-orbit strong` is the 1.5rem headline slot: the step caption
    // must be a <span> and the status line the <strong>.
    const container = renderShell(DISTRIBUTOR);
    const card = container.querySelector(".rf-auth-orbit > div:first-child");
    expect({
      smallInOrderCard: card === null ? "no order card" : card.querySelectorAll("small").length,
      strong: textOf(container.querySelector(".rf-auth-orbit strong")),
    }).toEqual({ smallInOrderCard: 0, strong: "Ready for the next stop." });
  });

  it("T1d: Need help? stays last in .rf-auth-footer even with no footer prop (R1, R4)", () => {
    // Without a first child, `justify-content: space-between` puts the lone
    // link at the LEFT edge — the wrapper keeps it at the end on every page.
    const container = renderShell(DISTRIBUTOR);
    const footer = container.querySelector(".rf-auth-footer");
    const children = footer === null ? [] : Array.from(footer.children);
    expect({
      linksWrapper: placement(container.querySelector(".rf-auth-footer-links"), ".rf-auth-footer"),
      lastChildIsNeedHelp: /need help/i.test(children[children.length - 1]?.textContent ?? ""),
      childCount: children.length,
    }).toEqual({
      linksWrapper: "inside .rf-auth-footer",
      lastChildIsNeedHelp: true,
      childCount: 2,
    });
  });
});
