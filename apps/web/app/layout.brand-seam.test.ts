// B1: the root layout's browser identity (title and template, share card, home-screen name, icons,
// the base URL of relative links) reads the brand seam. loadBrand() is mocked with a fixture; the
// real brand must not survive in the metadata, and the moved favicon is in the icon list.
// The signed-in app's own identity (theme colour, manifest) is Program B and stays as it was.
import { loadBrand } from "@routeflow/types/brand/load";
import { CURRENT_BRAND } from "@/lib/test-support/site-brand-exemptions";

jest.mock("@routeflow/types/brand/load", () => {
  const actual = jest.requireActual("@routeflow/types/brand/load");
  const fixture = actual.validateBrand({
    name: "FIXTURE.TEST",
    officialName: "FIXTURE-OFFICIAL",
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
    symbolOnDark: "/fx/symbol-dark.svg",
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
// The layout's other imports (fonts, providers, stylesheets) are not under test.
jest.mock("./fonts", () => {
  const font = { variable: "" };
  return {
    geistSans: font,
    geistMono: font,
    inter: font,
    instrumentSerif: font,
    splineSans: font,
    splineSansMono: font,
  };
});
jest.mock("./providers", () => ({ Providers: () => null }));
jest.mock("@/components/tenant-provider", () => ({ TenantProvider: () => null }));
jest.mock("@/components/ServiceWorkerRegistry", () => ({ ServiceWorkerRegistry: () => null }));
jest.mock("@/components/SentryInit", () => ({ SentryInit: () => null }));

import { metadata } from "./layout";

const FIXTURE = loadBrand();

describe("root layout metadata reads the brand seam", () => {
  it("title, template, share card and home-screen name carry the brand's name", () => {
    expect(metadata.title).toEqual({
      default: FIXTURE.name,
      template: `%s · ${FIXTURE.name}`,
    });
    expect(metadata.openGraph?.title).toBe(FIXTURE.name);
    expect(metadata.openGraph?.siteName).toBe(FIXTURE.name);
    expect((metadata.appleWebApp as { title: string }).title).toBe(FIXTURE.name);
  });

  it("relative links resolve against the brand's site", () => {
    expect(metadata.metadataBase?.href).toBe(`${FIXTURE.origin}/`);
  });

  it("icons come from the brand's icon files, with the moved favicon in the tab-icon list", () => {
    const icons = metadata.icons as {
      icon: Array<{ url: string }>;
      apple: Array<{ url: string }>;
      shortcut: string;
    };
    expect(icons.icon.map((i) => i.url)).toEqual(["/favicon.ico", FIXTURE.icon.favicon]);
    expect(icons.apple.map((i) => i.url)).toEqual([FIXTURE.icon.apple]);
    expect(icons.shortcut).toBe(FIXTURE.icon.favicon);
    expect((metadata.appleWebApp as { startupImage: string }).startupImage).toBe(
      FIXTURE.icon["192"],
    );
    expect(metadata.openGraph?.images).toEqual([{ url: FIXTURE.icon["512"] }]);
  });

  it("nothing of the real brand is left in the metadata", () => {
    expect(JSON.stringify(metadata)).not.toMatch(CURRENT_BRAND);
  });

  it("the favicon file is served from public/, not the file-based app/ slot", () => {
    const fs = jest.requireActual("fs") as typeof import("fs");
    const path = jest.requireActual("path") as typeof import("path");
    const root = path.resolve(__dirname, "..");
    expect(fs.existsSync(path.join(root, "public", "favicon.ico"))).toBe(true);
    expect(fs.existsSync(path.join(root, "app", "favicon.ico"))).toBe(false);
  });
});
