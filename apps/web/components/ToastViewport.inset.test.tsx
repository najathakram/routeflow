import * as React from "react";
import { render, screen } from "@testing-library/react";
import * as fs from "fs";
import * as path from "path";
import { ToastProvider } from "@routeflow/ui/web";

/** B1182: a page with a sticky bar lifts the toasts clear of it through --toast-bottom-inset; unset keeps 1rem. */
const viewportOf = () =>
  screen.getByRole("region", { name: /notifications/i }).querySelector("ol") as HTMLElement;
const INSET_CLASS = "bottom-[max(1rem,var(--toast-bottom-inset,1rem))]";

describe("Toast viewport bottom inset (B1182)", () => {
  afterEach(() => document.documentElement.style.removeProperty("--toast-bottom-inset"));

  it("reads --toast-bottom-inset and falls back to 1rem when it is unset", () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>,
    );
    const viewport = viewportOf();
    expect(viewport.className).toContain(INSET_CLASS);
    expect(viewport.className).not.toMatch(/(^|\s)bottom-4(\s|$)/);
    expect(viewport.className).toContain("right-4");
    expect(viewport.className).toContain("z-[400]");
  });

  it("the variable resolves from the root element the register sets it on", () => {
    document.documentElement.style.setProperty("--toast-bottom-inset", "120px");
    render(
      <ToastProvider>
        <div />
      </ToastProvider>,
    );
    expect(
      getComputedStyle(document.documentElement).getPropertyValue("--toast-bottom-inset"),
    ).toBe("120px");
    expect(viewportOf().className).toContain(INSET_CLASS);
  });
});

/**
 * SA-1067 C1: a message raised from inside a window (the New item window on the till, z-[200]) was dimmed behind it at z-[100].
 * The viewport must sit above every layer the app draws, except the camera overlay (BarcodeScannerButton), which closes before
 * it reports. Every `z-[N]` token and every inline `zIndex: N` is read on its own, whatever classes sit beside it, across
 * apps/web/{app,components,lib} and packages/ui/src. The camera is exempt BY FILE, never by value, so a new 9999 layer fails.
 */
const WEB = path.resolve(__dirname, "..");
const UI_SRC = path.resolve(__dirname, "../../../packages/ui/src");
const SCAN_ROOTS = [
  path.join(WEB, "app"),
  path.join(WEB, "components"),
  path.join(WEB, "lib"),
  UI_SRC,
];
/** The camera overlay closes before it reports; the toast file is the layer being measured. */
const EXEMPT_FILES = new Set(["BarcodeScannerButton.tsx", "Toast.tsx"]);

/** Every layer value in a source text: the Tailwind token `z-[N]` and the inline `zIndex: N` (a bare number). */
export function layerValues(source: string): number[] {
  const out: number[] = [];
  for (const m of source.matchAll(/(?<![\w-])z-\[(\d+)\]/g)) out.push(Number(m[1]));
  for (const m of source.matchAll(/\bzIndex\s*:\s*(\d+)/g)) out.push(Number(m[1]));
  return out;
}

/** Layers in `source` that sit at or above the toast, unless the file is one of the two exempt files. */
export function layersAtOrAbove(file: string, source: string, toastZ: number): number[] {
  if (EXEMPT_FILES.has(path.basename(file))) return [];
  return layerValues(source).filter((z) => z >= toastZ);
}

describe("Toast viewport layer (SA-1067 C1)", () => {
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : files(p);
      return /\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) ? [p] : [];
    });
  const toastLayer = () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>,
    );
    return Number(/z-\[(\d+)\]/.exec(viewportOf().className)?.[1]);
  };

  it("sits above every other z-[N] and inline zIndex layer in apps/web and packages/ui", () => {
    const toastZ = toastLayer();
    const all = SCAN_ROOTS.flatMap(files);
    expect(all.length).toBeGreaterThan(300); // the scan found the real tree, not an empty one
    const layers = all.flatMap((f) => layerValues(fs.readFileSync(f, "utf8")));
    expect(layers.length).toBeGreaterThan(20);
    const above = all.flatMap((f) =>
      layersAtOrAbove(f, fs.readFileSync(f, "utf8"), toastZ).map(
        (z) => `${path.basename(f)}: ${z}`,
      ),
    );
    expect(above).toEqual([]);
  });

  it("the exempt files are exactly the camera overlay and the toast, and both exist", () => {
    const names = SCAN_ROOTS.flatMap(files).map((f) => path.basename(f));
    for (const exempt of EXEMPT_FILES) expect(names).toContain(exempt);
    expect([...EXEMPT_FILES].sort()).toEqual(["BarcodeScannerButton.tsx", "Toast.tsx"]);
  });

  describe("self-test: a planted layer above the toast goes red, in every spelling", () => {
    const Z = 400;
    const planted = (src: string, file = "Modal.tsx") => layersAtOrAbove(file, src, Z);
    it.each([
      ["the usual order", '<div className="fixed inset-0 z-[500] flex">'],
      ["z before inset", '<div className="fixed z-[500] inset-0 flex">'],
      ["inset before fixed", '<div className="inset-0 fixed z-[500] flex">'],
      ["z after flex", '<div className="fixed inset-0 flex z-[500] items-center">'],
      ["no inset-0, sized by hand", '<div className="fixed left-0 top-0 h-full w-full z-[500]">'],
      ["an inline zIndex", "<div style={{ position: 'fixed', zIndex: 500 }}>"],
      ["an inline zIndex with no space", "<div style={{zIndex:500}}>"],
      ["exactly the toast layer", '<div className="fixed inset-0 z-[400]">'],
      ["a 9999 layer in any file but the camera", '<div className="fixed inset-0 z-[9999]">'],
    ])("%s", (_name, src) => {
      expect(planted(src)).not.toEqual([]);
    });

    it("the same planting in a packages/ui file name is caught (the scan roots include packages/ui/src)", () => {
      expect(UI_SRC).toContain(path.join("packages", "ui", "src"));
      expect(planted('<div className="fixed inset-0 z-[500]">', "Modal.tsx")).toEqual([500]);
    });

    it("layers below the toast and the two exempt files stay green", () => {
      expect(planted('<div className="fixed inset-0 z-[300]">')).toEqual([]);
      expect(planted("<div style={{ zIndex: 250 }}>")).toEqual([]);
      expect(
        planted('<div className="fixed inset-0 z-[9999]">', "BarcodeScannerButton.tsx"),
      ).toEqual([]);
      expect(planted('<div className="z-[400]">', "Toast.tsx")).toEqual([]);
    });
  });
});
