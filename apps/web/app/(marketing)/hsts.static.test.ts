/**
 * @jest-environment node
 */
// Site audit 2026-11-02 §7: `curl -sI https://www.routeflow.info/` returned no
// Strict-Transport-Security, so a first visit over http was never pinned to https.
//
// next.config.mjs is resolved in a real `node` subprocess, not imported in-process — see
// cache-headers.static.test.ts for why (the Jest/Babel `__dirname` collision).
import * as path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";

const WEB_ROOT = path.resolve(__dirname, "../..");

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

function loadHeaders(): HeaderRule[] {
  const configUrl = pathToFileURL(path.join(WEB_ROOT, "next.config.mjs")).href;
  const script =
    `const m = await import(${JSON.stringify(configUrl)});` +
    `process.stdout.write(JSON.stringify(await m.default.headers()));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: WEB_ROOT,
    encoding: "utf8",
    timeout: 15_000,
  });
  return JSON.parse(output);
}

describe("Strict-Transport-Security on every route", () => {
  const rules = loadHeaders();
  const hsts = rules.flatMap((r) =>
    r.headers
      .filter((h) => h.key === "Strict-Transport-Security")
      .map((h) => ({ source: r.source, value: h.value })),
  );

  it("is set once, on the catch-all rule", () => {
    expect(hsts).toEqual([{ source: "/(.*)", value: expect.any(String) }]);
  });

  it("lasts at least a year", () => {
    const maxAge = Number(/max-age=(\d+)/.exec(hsts[0].value)?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(31_536_000);
  });

  it("never pins other hosts or enters the preload list", () => {
    expect(hsts[0].value).not.toMatch(/includeSubDomains/i);
    expect(hsts[0].value).not.toMatch(/preload/i);
  });
});
