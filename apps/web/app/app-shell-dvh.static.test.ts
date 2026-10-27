import * as fs from "fs";
import * as path from "path";

/**
 * Row 364: the app shells were `h-screen` (100vh). On a phone with the browser toolbar showing, 100vh is
 * taller than the visible area, so the bottom of the shell (the page's last controls) sat under the toolbar.
 * A shell root now carries `supports-[height:100dvh]:h-dvh` (100dvh, the visible height) after the `h-screen`
 * fallback, which a browser without dvh support keeps. The variant form is deliberate: a plain `h-dvh` is emitted
 * BEFORE `h-screen` in Tailwind's CSS, so `h-screen h-dvh` would still resolve to 100vh.
 */
const SHELLS: Array<[string, RegExp]> = [
  ["(dashboard)/layout.tsx", /surface-operator[^"]*\bh-screen\b[^"]*"/],
  ["(dashboard)/layout.tsx", /flex h-screen[^"]*w-full items-center justify-center bg-background/],
  ["(platform-admin)/layout.tsx", /surface-admin[^"]*\bh-screen\b[^"]*"/],
];

describe("app shell height (row 364)", () => {
  it.each(SHELLS)(
    "%s: every full-height shell root has the dvh variant after h-screen",
    (file, pattern) => {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      const m = src.match(pattern);
      expect(m).not.toBeNull();
      const classes = m![0];
      expect(classes).toMatch(/supports-\[height:100dvh\]:h-dvh/);
      expect(classes.indexOf("h-screen")).toBeLessThan(classes.indexOf("supports-"));
    },
  );
});
