/**
 * @jest-environment node
 */
// Pages that arrive with a single-use link token in the URL must send no Referer at all.
// next.config.mjs is loaded in a real `node` subprocess, not in-process: see
// components/next-config-images.static.test.ts for why the Jest/Babel transform can't import it.
import * as path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";

const WEB_ROOT = path.resolve(__dirname, "..");

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

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
  return JSON.parse(output) as HeaderRule[];
}

const NO_REFERRER_SOURCES = [
  "/reset-password",
  "/buyer/reset-password",
  "/verify-email",
  "/buyer/verify-email",
  "/buyer/invite/:path*",
  "/buyer/verify-merge",
];

describe("next.config.mjs headers() — Referrer-Policy on link-token pages", () => {
  const rules = loadHeaders();
  const referrerValue = (r: HeaderRule) =>
    r.headers.find((h) => h.key === "Referrer-Policy")?.value;

  it.each(NO_REFERRER_SOURCES)(
    "%s sends Referrer-Policy: no-referrer and nothing else",
    (source) => {
      const matches = rules.filter((r) => r.source === source);
      expect(matches).toHaveLength(1);
      expect(matches[0].headers).toEqual([{ key: "Referrer-Policy", value: "no-referrer" }]);
    },
  );

  it("no other rule sets no-referrer, and the site default is unchanged", () => {
    const withNoReferrer = rules.filter((r) => referrerValue(r) === "no-referrer");
    expect(withNoReferrer.map((r) => r.source).sort()).toEqual([...NO_REFERRER_SOURCES].sort());
    const catchAll = rules.find((r) => r.source === "/(.*)");
    expect(catchAll).toBeDefined();
    expect(referrerValue(catchAll!)).toBe("strict-origin-when-cross-origin");
    expect(catchAll!.headers.map((h) => h.key).sort()).toEqual(
      [
        "Content-Security-Policy",
        "Permissions-Policy",
        "Referrer-Policy",
        "X-Content-Type-Options",
        "X-Frame-Options",
      ].sort(),
    );
  });

  it("the cache rules for the marketing pages are still present", () => {
    expect(rules.some((r) => r.source === "/")).toBe(true);
    expect(rules.some((r) => r.source.includes("wholesalers"))).toBe(true);
  });

  it("the rules appear in the same order as before: catch-all, reset pages, then caching", () => {
    const sources = rules.map((r) => r.source);
    expect(sources[0]).toBe("/(.*)");
    expect(sources.slice(1, 7)).toEqual(NO_REFERRER_SOURCES);
  });
});
