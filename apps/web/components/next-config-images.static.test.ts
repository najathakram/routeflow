/**
 * @jest-environment node
 */
// Defence in depth for GHSA-2xp9-vwfh-vxw4 (libheif/AVIF RCE in Next's Image Optimization API).
// Next 15.5.25 fixes the advisory, which retired its security/audit-allowlist.json entry. The pin
// stays: this app never renders `next/image` (see components/no-next-image.test.ts), and
// `images.unoptimized: true` disables the `/_next/image` optimizer route entirely, keeping that
// code path unreachable regardless of the installed next version. Pinned here so the config can't
// drift back to the default silently.
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

describe("next.config.mjs images (GHSA-2xp9-vwfh-vxw4 defence in depth)", () => {
  it("disables the /_next/image optimizer (images.unoptimized === true)", () => {
    const images = loadNextConfigImages();
    expect(images).toEqual({ unoptimized: true });
  });
});
