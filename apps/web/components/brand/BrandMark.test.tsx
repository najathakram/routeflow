import * as fs from "fs";
import * as path from "path";
import { render, screen } from "@testing-library/react";
import { Brand, BrandMark, BrandSignature } from "./BrandMark";

// R-MKT T4 — one shared brand mark, no more per-site logo treatments.
describe("BrandMark / BrandSignature / Brand — R-MKT T4", () => {
  it("BrandMark renders the mark PNG as a decorative image (R-MKT T4)", () => {
    const { container } = render(<BrandMark />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", expect.stringContaining("/brand/routeflow-mark-192.png"));
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("aria-hidden", "true");
  });

  // fix-round-3 B1 — a plain <img>, NOT next/image. Under `output: "standalone"`
  // with no `images` config a next/image render points at the `/_next/image`
  // optimizer, which production never built. No jest mock stands in here: the
  // `src` must be the literal public path, not an optimizer query string.
  it("BrandMark emits a plain <img> at the raw public path, never /_next/image (B1)", () => {
    const { container } = render(<BrandMark size={48} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/brand/routeflow-mark-192.png");
    expect(img.getAttribute("src")).not.toContain("/_next/image");
    expect(img).not.toHaveAttribute("srcset");
    expect(img).toHaveAttribute("width", "48");
    expect(img).toHaveAttribute("height", "48");
    expect(img).toHaveAttribute("decoding", "async");
  });

  // fix-round-3 B2 — the shipped PNG is dark-navy ink, ~2:1 on the dark shells.
  it('BrandMark inverts the mark to white ink only for tone="light" (B2)', () => {
    const { container: dark } = render(<BrandMark />);
    const darkMark = dark.querySelector("img")!;
    expect(darkMark).toHaveClass("brand-mark");
    expect(darkMark).not.toHaveClass("brand-mark--light");
    expect(darkMark).not.toHaveClass("brightness-0");
    expect(darkMark).not.toHaveClass("invert");

    const { container: light } = render(<BrandMark tone="light" />);
    const lightMark = light.querySelector("img")!;
    expect(lightMark).toHaveClass("brand-mark", "brand-mark--light", "brightness-0", "invert");
  });

  it("BrandMark keeps caller classes alongside the light tone (B2)", () => {
    const { container } = render(<BrandMark tone="light" className="rounded-lg" />);
    const img = container.querySelector("img")!;
    expect(img).toHaveClass("rounded-lg", "brand-mark--light");
  });

  it("BrandSignature forwards tone to the mark and paints the wordmark cream (B2)", () => {
    const { container: dark } = render(<BrandSignature />);
    expect(dark.querySelector("img")).not.toHaveClass("brand-mark--light");
    expect(dark.querySelector(".brand-wordmark")).not.toHaveClass("text-[#FAF6EE]");

    const { container: light } = render(<BrandSignature tone="light" />);
    expect(light.querySelector("img")).toHaveClass("brand-mark--light", "brightness-0", "invert");
    expect(light.querySelector(".brand-wordmark")).toHaveClass("text-[#FAF6EE]");
  });

  it("periodColor still wins over the light tone for the trailing period (B2)", () => {
    const { container } = render(<BrandSignature tone="light" periodColor="#7DDCD8" />);
    const period = container.querySelector<HTMLElement>(".brand-period");
    expect(period?.style.color).toBe("rgb(125, 220, 216)");
  });

  it("Brand forwards tone through the home link (B2)", () => {
    const { container } = render(<Brand tone="light" />);
    expect(container.querySelector("img")).toHaveClass("brand-mark--light");
  });

  it("BrandSignature pairs the mark with the wordmark, period in its own .brand-period span (R-MKT T4)", () => {
    const { container } = render(<BrandSignature />);

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", expect.stringContaining("/brand/routeflow-mark-192.png"));
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("aria-hidden", "true");

    expect(container).toHaveTextContent("routeflow.");

    const period = container.querySelector(".brand-period");
    expect(period).not.toBeNull();
    expect(period?.textContent).toBe(".");

    // Layout is self-contained (matches `.rf-marketing .brand-signature`), but the
    // marketing type metrics stay opt-in so the stylesheet keeps winning there.
    const wrapper = container.querySelector(".brand-signature");
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveClass("inline-flex", "items-center", "gap-[9px]");
    expect(wrapper).not.toHaveClass("text-[1.48rem]");
    expect(wrapper).not.toHaveClass("font-[650]");
    expect(wrapper).not.toHaveClass("tracking-[-0.065em]");
  });

  it("BrandSignature adds the marketing type metrics only when standalone (R-MKT T4)", () => {
    const { container } = render(<BrandSignature standalone />);

    const wrapper = container.querySelector(".brand-signature");
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveClass("inline-flex", "items-center", "gap-[9px]");
    expect(wrapper).toHaveClass(
      "text-[1.48rem]",
      "font-[650]",
      "leading-none",
      "tracking-[-0.065em]",
    );

    expect(container.querySelector("img")).not.toBeNull();
    expect(container).toHaveTextContent("routeflow.");
    expect(container.querySelector(".brand-period")?.textContent).toBe(".");
  });

  it("BrandSignature leaves the period colour to CSS unless a caller sets it (R-MKT T4)", () => {
    const { container: plain } = render(<BrandSignature />);
    const defaultPeriod = plain.querySelector<HTMLElement>(".brand-period");
    // No inline colour: the ported `.rf-marketing .brand-period` cascade must win.
    expect(defaultPeriod?.getAttribute("style")).toBeNull();
    expect(defaultPeriod?.style.color).toBe("");

    const { container: tinted } = render(<BrandSignature periodColor="#7DDCD8" />);
    const tintedPeriod = tinted.querySelector<HTMLElement>(".brand-period");
    expect(tintedPeriod?.style.color).toBe("rgb(125, 220, 216)");
  });

  it("Brand wraps the signature in a link with the accessible home name (R-MKT T4)", () => {
    render(<Brand />);
    const link = screen.getByRole("link", { name: "RouteFlow home" });
    expect(link).toHaveAttribute("href", "/");
  });
});

// R-MKT T4b — the shared mark must composite on any background, so every size
// ships with a real alpha channel (PNG colour type 6). An opaque, white-backed
// mark reads as a white square on the dark dashboard / buyer / platform-admin
// shells, where no `mix-blend-mode` rule applies (those live under
// `.rf-marketing` only).
describe("brand mark assets — R-MKT T4b", () => {
  const brandDir = path.join(__dirname, "..", "..", "public", "brand");

  it.each([64, 180, 192, 512])(
    "routeflow-mark-%s.png is an RGBA PNG with a transparent corner (R-MKT T4b)",
    (size) => {
      const png = fs.readFileSync(path.join(brandDir, `routeflow-mark-${size}.png`));
      // PNG signature, then the IHDR chunk: width/height at 16/20, bit depth at
      // 24, colour type at 25 (6 = truecolour + alpha).
      expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
      expect(png[25]).toBe(6);
    },
  );
});

// The brand components sit on the marketing pages' critical path, so they must
// not pull the whole `@routeflow/ui` barrel (Modal/Toast/Table/… client
// components) into the graph — `cn` is exported from the web subpath too.
describe("BrandMark module graph — R-MKT T4", () => {
  it("imports cn from the @routeflow/ui/web subpath (R-MKT T4)", () => {
    const source = fs.readFileSync(path.join(__dirname, "BrandMark.tsx"), "utf8");
    expect(source).toContain('from "@routeflow/ui/web"');
    expect(source).not.toMatch(/from "@routeflow\/ui"/);
  });
});

// `size` only becomes the image's width/height attributes, which lose to the
// `.rf-marketing .brand-mark` box rules inside the marketing scope. The 404's
// 40px mark therefore needs its own rule, keyed on the class the page passes.
// jsdom loads no stylesheet, so this is asserted against the CSS source.
describe("marketing-scoped mark sizing — R-MKT T4", () => {
  it("marketing.css sizes the 404 mark at 40px (R-MKT T4)", () => {
    const css = fs.readFileSync(
      path.join(__dirname, "..", "..", "app", "(marketing)", "marketing.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.rf-marketing \.not-found-brand \.brand-mark \{\s*width: 40px;\s*height: 40px;\s*\}/,
    );
  });
});
