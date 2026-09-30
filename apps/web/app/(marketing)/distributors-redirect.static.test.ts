/**
 * @jest-environment node
 */
// R-MKT hotfix pin (#657 follow-through). /distributors used to be a
// prerendered `redirect()` page (app/(marketing)/distributors/page.tsx), but
// a prerendered redirect() page served from the ISR cache lost its Location
// header on the standalone server (307, no Location; spec 36 T1 red on
// 2026-09-08). The alias must never come back as a page — it must stay a
// next.config redirect, which next evaluates before middleware and which
// always carries the Location header.
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";

const WEB_ROOT = path.resolve(__dirname, "../..");

// next.config.mjs is deliberately NOT imported in-process here: it opens with
// `const __dirname = path.dirname(fileURLToPath(import.meta.url));`, and this
// workspace's Jest/Babel transform (next/jest) recompiles a dynamically
// imported .mjs to CJS and injects its OWN `__dirname` binding, colliding
// with that line ("Identifier '__dirname' has already been declared").
// csp.mjs was split out of next.config.mjs for exactly this reason (see its
// header comment). A real, unmodified `node` subprocess — the same technique
// lib/csp.test.ts's oracle comment documents for exercising next.config.mjs
// directly — sidesteps the transform and actually resolves redirects().
function loadRedirects(): Array<{ source: string; destination: string; permanent: boolean }> {
  const configUrl = pathToFileURL(path.join(WEB_ROOT, "next.config.mjs")).href;
  const script =
    `const m = await import(${JSON.stringify(configUrl)});` +
    `process.stdout.write(JSON.stringify(await m.default.redirects()));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: WEB_ROOT,
    encoding: "utf8",
    timeout: 15_000,
  });
  return JSON.parse(output);
}

describe("/distributors alias — next.config redirect (#657 follow-through)", () => {
  it("next.config.mjs redirects /distributors to /wholesalers, temporarily (307)", () => {
    const redirects = loadRedirects();
    const entry = redirects.find((r) => r.source === "/distributors");
    expect(entry).toEqual({
      source: "/distributors",
      destination: "/wholesalers",
      permanent: false,
    });
  });

  it("app/(marketing)/distributors/page.tsx does not exist (the alias must never come back as a prerendered redirect() page)", () => {
    const pagePath = path.join(WEB_ROOT, "app", "(marketing)", "distributors", "page.tsx");
    expect(fs.existsSync(pagePath)).toBe(false);
  });
});
