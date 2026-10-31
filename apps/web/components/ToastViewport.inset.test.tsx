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
 * The viewport must sit above every full-screen layer the app draws, except the camera overlay, which closes before it reports.
 */
describe("Toast viewport layer (SA-1067 C1)", () => {
  const ROOTS = [path.resolve(__dirname), path.resolve(__dirname, "../app")];
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : files(p);
      return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [p] : [];
    });

  it("sits above every other fixed full-screen layer in apps/web", () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>,
    );
    const toastZ = Number(/z-\[(\d+)\]/.exec(viewportOf().className)?.[1]);
    const layers = ROOTS.flatMap(files).flatMap((f) =>
      [...fs.readFileSync(f, "utf8").matchAll(/fixed inset-0 z-\[(\d+)\]/g)].map((m) => ({
        file: path.basename(f),
        z: Number(m[1]),
      })),
    );
    expect(layers.length).toBeGreaterThan(5); // the scan found the real layers, not an empty tree
    const above = layers.filter((l) => l.z >= toastZ && l.z < 9999);
    expect(above).toEqual([]);
  });
});
