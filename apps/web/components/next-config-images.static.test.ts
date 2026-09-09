/**
 * @jest-environment node
 */
// CI audit allowlist basis (security/audit-allowlist.json, GHSA-2xp9-vwfh-vxw4 — libheif/AVIF
// RCE in Next's Image Optimization API). This app never renders `next/image` (see
// components/no-next-image.test.ts), and `images.unoptimized: true` disables the
// `/_next/image` optimizer route entirely, so the vulnerable code path is unreachable in
// production regardless of the installed next version. Pinned here so the config can't drift
// back to the default silently — the allowlist entry's "reason" depends on it.
import * as path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";

const WEB_ROOT = path.resolve(__dirname, "..");

// next.config.mjs is deliberately NOT imported in-process here — see
// distributors-redirect.static.test.ts's header comment: it opens with
// `const __dirname = path.dirname(fileURLToPath(import.meta.url));`, and this workspace's
// Jest/Babel transform (next/jest) recompiles a dynamically imported .mjs to CJS and injects
// its OWN `__dirname` binding, colliding with that line ("Identifier '__dirname' has already
// been declared"). A real, unmodified `node` subprocess sidesteps the transform and actually
// resolves the config's default export.
function loadNextConfigImages(): unknown {
  const configUrl = pathToFileURL(path.join(WEB_ROOT, "next.config.mjs")).href;
  const script =
    `const m = await import(${JSON.stringify(configUrl)});` +
    `process.stdout.write(JSON.stringify(m.default.images));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: WEB_ROOT,
    encoding: "utf8",
    timeout: 15_000,
  });
  return JSON.parse(output);
}

describe("next.config.mjs images (GHSA-2xp9-vwfh-vxw4 allowlist basis)", () => {
  it("disables the /_next/image optimizer (images.unoptimized === true)", () => {
    const images = loadNextConfigImages();
    expect(images).toEqual({ unoptimized: true });
  });
});
