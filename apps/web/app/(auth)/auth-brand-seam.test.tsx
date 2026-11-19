// Lane 2.6a: the signed-out React pages with a different brand. loadBrand() is mocked with a fixture
// (another name, host, mailbox, legal entity and icon paths) and every page and layout of the front
// door is rendered again. Nothing of the real brand may be left in the text, the links or the
// metadata, and the fixture's name, mailbox and paths must show where the real ones used to.
// The one allow-listed string is the public repository address of the security policy (a code
// location, not the brand's name). T45 (app/(marketing)/site-brand-fixture.test.ts) does the same for
// the ready-made pages and the frame.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadBrand } from "@routeflow/types/brand/load";
import { MAX_TITLE_LENGTH } from "@routeflow/types/brand";
import { renderWithProviders } from "@/test-utils/render";
import { CURRENT_BRAND } from "@/lib/test-support/site-brand-exemptions";

jest.mock("@routeflow/types/brand/load", () => {
  const actual = jest.requireActual("@routeflow/types/brand/load");
  const fixture = actual.validateBrand({
    name: "FIXTURE.TEST",
    formerly: "Fixture Former Name",
    legalEntity: "Fixture Legal Holdings Ltd",
    origin: "https://www.fixture-host.example",
    oldOrigin: "https://old.fixture-host.example",
    email: "writeto@fixture-host.example",
    securityEmail: "safety@fixture-host.example",
    titleSeparator: " :: ",
    shareLine: "Fixture share line.",
    logo: {
      onLight: "/fx/logo-light.svg",
      onDark: "/fx/logo-dark.svg",
      small: "/fx/logo-small.svg",
    },
    symbol: "/fx/symbol.svg",
    icon: {
      favicon: "/fx/tab-icon.png",
      apple: "/fx/apple.png",
      "192": "/fx/i192.png",
      "512": "/fx/i512.png",
    },
    emailLogo: "/fx/email.png",
    emailLogoWidth: 120,
    emailLogoHeight: 34,
  });
  return { ...actual, loadBrand: () => fixture };
});

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams("token=a.b.c&email=a@b.example&workspace=acme"),
  usePathname: () => "/x",
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }), post: jest.fn() },
}));

const FIXTURE = loadBrand();
const PLANNED_NAME = /rovio/i;
/** Exact strings the check ignores: the security policy's address in the public repository. */
const ALLOWED = ["https://github.com/najathakram/routeflow/blob/master/SECURITY.md"];
const clean = (text: string) => ALLOWED.reduce((t, a) => t.split(a).join(""), text);
const expectNoOldBrand = (text: string) => {
  expect(clean(text)).not.toMatch(CURRENT_BRAND);
  expect(clean(text)).not.toMatch(PLANNED_NAME);
};

const SHARE_DESCRIPTION = "Wholesale distribution, simplified.";
const BUYER_SHARE_DESCRIPTION = "Order from your sellers, track deliveries, manage invoices.";
const TEMPLATE = `%s · ${FIXTURE.name}`;

// [module, default tab title, share title, share description]
const LAYOUTS: Array<[string, string, string, string]> = [
  ["../(marketing)/layout", FIXTURE.name, FIXTURE.name, SHARE_DESCRIPTION],
  ["./login/layout", `Sign in · ${FIXTURE.name}`, FIXTURE.name, SHARE_DESCRIPTION],
  ["./signup/layout", `Start your free trial · ${FIXTURE.name}`, FIXTURE.name, SHARE_DESCRIPTION],
  [
    "./forgot-password/layout",
    `Reset your password · ${FIXTURE.name}`,
    FIXTURE.name,
    SHARE_DESCRIPTION,
  ],
  ["./reset-password/layout", FIXTURE.name, FIXTURE.name, SHARE_DESCRIPTION],
  [
    "../buyer/login/layout",
    `${FIXTURE.name} Buyer Portal`,
    `${FIXTURE.name} Buyer Portal`,
    BUYER_SHARE_DESCRIPTION,
  ],
];

describe("layout metadata reads the brand (title, share block, icons, app bar, colour)", () => {
  it.each(LAYOUTS)("%s", (mod, defaultTitle, shareTitle, shareDescription) => {
    const m = require(mod);
    const meta = m.metadata;
    const vp = m.viewport;
    expectNoOldBrand(JSON.stringify({ meta, vp }));
    expect(meta.metadataBase.href).toBe(`${FIXTURE.origin}/`);
    expect(meta.title).toEqual({ default: defaultTitle, template: TEMPLATE });
    // T37: a tab title is at most 60 characters
    expect(defaultTitle.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(meta.openGraph).toEqual({
      title: shareTitle,
      description: shareDescription,
      siteName: FIXTURE.name,
      type: "website",
      images: [{ url: FIXTURE.icon["512"] }],
    });
    // Next replaces appleWebApp as a unit: it is restated whole.
    expect(meta.appleWebApp).toEqual({
      capable: true,
      title: FIXTURE.name,
      statusBarStyle: "black-translucent",
      startupImage: FIXTURE.icon["192"],
    });
    expect(meta.icons).toEqual({
      icon: [{ url: FIXTURE.icon.favicon, type: "image/png", sizes: "64x64" }],
      apple: [{ url: FIXTURE.icon.apple, sizes: "180x180" }],
      shortcut: FIXTURE.icon.favicon,
    });
    // The root's ink and the buyer layout's green are inherited otherwise.
    expect(vp.themeColor).toBe("#ffffff");
  });
});

const SERVER_PAGES: Array<[string, string]> = [
  ["privacy", "../(marketing)/privacy/page"],
  ["terms", "../(marketing)/terms/page"],
  ["not-found", "../not-found"],
];
const CLIENT_PAGES: Array<[string, string]> = [
  ["login", "./login/page"],
  ["signup", "./signup/page"],
  ["check-email", "./signup/check-email/page"],
  ["forgot-password", "./forgot-password/page"],
  ["reset-password", "./reset-password/page"],
  ["buyer login", "../buyer/login/page"],
  ["verify-email", "../verify-email/page"],
  ["admin-login", "./admin-login/page"],
  ["choose-role", "./choose-role/page"],
];

const rendered: Record<string, string> = {};

describe("pages read the fixture brand and show none of the real one", () => {
  it.each(SERVER_PAGES)("%s", (name, mod) => {
    const Page = require(mod).default;
    rendered[name] = renderToStaticMarkup(<Page />);
    expectNoOldBrand(rendered[name]);
  });

  it.each(CLIENT_PAGES)("%s", (name, mod) => {
    const Page = require(mod).default;
    rendered[name] = renderWithProviders(<Page />).container.innerHTML;
    expectNoOldBrand(rendered[name]);
    // the site frame around every one of them names the fixture
    if (name !== "admin-login") expect(rendered[name]).toContain(FIXTURE.name);
  });

  it("privacy and terms use the fixture's name, legal entity and security mailbox", () => {
    for (const name of ["privacy", "terms"]) {
      const html = rendered[name];
      expect(html).toContain(FIXTURE.name);
      expect(html).toContain(FIXTURE.legalEntity);
      expect(html).toContain(`mailto:${FIXTURE.securityEmail}`);
      expect(html).toContain(`>${FIXTURE.securityEmail}</a>`);
    }
    // the all-capitals disclaimer reads the name too
    expect(rendered.terms).toContain(`${FIXTURE.name.toUpperCase()} DISCLAIMS ALL WARRANTIES`);
  });

  it("the small strings read the name", () => {
    expect(rendered["not-found"]).toContain(`Back to ${FIXTURE.name}`);
    expect(rendered.login).toContain(`New to ${FIXTURE.name}?`);
    expect(rendered["buyer login"]).toContain(`Selling on ${FIXTURE.name}?`);
    expect(rendered["admin-login"]).toContain(`${FIXTURE.name} Platform`);
    expect(rendered["choose-role"]).toContain(`How do you want to use ${FIXTURE.name}?`);
  });
});
