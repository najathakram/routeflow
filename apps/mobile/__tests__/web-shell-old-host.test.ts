/**
 * T40a: the phone shell stays on the OLD host. The host the shell may load (eas.json, read through the
 * shell's own config, and the allow-list that web.tsx hands the WebView) must equal the brand file's
 * oldOrigin, never its origin. A switch commit that moves origin cannot move the shell, because the shell
 * reads neither. Adding the new host to the shell is a separate, later change with its own row.
 * Complements web-shell-eas-env.test.ts (every profile sets the env) and web-shell-config.test.ts.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { allowedOrigins } from "../lib/web-shell/url-policy";
import { readShellConfig } from "../lib/web-shell/shell-config";

const ROOT = join(__dirname, "..");
const brand = JSON.parse(
  readFileSync(join(ROOT, "..", "..", "packages", "types", "brand", "brand.json"), "utf8"),
) as { origin: string; oldOrigin: string };
const eas = JSON.parse(readFileSync(join(ROOT, "eas.json"), "utf8")) as {
  build: Record<string, { env?: Record<string, string> }>;
};
const storeProfiles = ["staging", "production"] as const;

describe("T40a: the shell loads the old host only", () => {
  it("the brand file has an old origin to compare against", () => {
    expect(brand.oldOrigin).toMatch(/^https:\/\/[^/]+$/);
  });

  it.each(storeProfiles)(
    "eas.json %s: the shell's allowed origins are exactly the old origin",
    (name) => {
      const env = eas.build[name]?.env ?? {};
      const cfg = readShellConfig(env);
      expect(cfg).not.toBeNull();
      expect(cfg!.allowed).toEqual(allowedOrigins(brand.oldOrigin));
      expect(cfg!.allowed).toEqual([new URL(brand.oldOrigin).origin]);
      expect(cfg!.webBaseUrl).toBe(new URL(brand.oldOrigin).origin);
    },
  );

  it.each(storeProfiles)("eas.json %s: the web URL is the old origin, not the new one", (name) => {
    const url = eas.build[name]?.env?.EXPO_PUBLIC_WEB_URL ?? "";
    expect(new URL(url).origin).toBe(new URL(brand.oldOrigin).origin);
    // Only meaningful once the two differ (the switch commit): then the shell must not follow origin.
    if (brand.origin !== brand.oldOrigin) {
      expect(new URL(url).origin).not.toBe(new URL(brand.origin).origin);
    }
  });

  it("web.tsx hands the WebView the shell's own allow-list and types no host", () => {
    const src = readFileSync(join(ROOT, "app", "(shell)", "web.tsx"), "utf8");
    // spacing may vary; the quote must be a template literal, so the host stays a variable, not a string
    expect(src).toMatch(
      /originWhitelist=\{\s*SHELL\.allowed\s*\.map\(\s*\(?\s*o\s*\)?\s*=>\s*`\$\{o\}\*`\s*\)\s*\}/,
    );
    expect(src).toMatch(
      /import\s*\{\s*SHELL_CONFIG\s*\}\s*from\s*['"]\.\.\/\.\.\/lib\/web-shell\/shell-env['"]/,
    );
    expect(src).not.toMatch(/https?:\/\/[a-z0-9]/i);
  });

  it("the shell's env reader takes the web URL from the build env, not from the brand file", () => {
    const env = readFileSync(join(ROOT, "lib", "web-shell", "shell-env.ts"), "utf8");
    expect(env).toContain("EXPO_PUBLIC_WEB_URL");
    expect(env).not.toMatch(/brand/i);
    expect(env).not.toMatch(/https?:\/\/[a-z0-9]/i);
  });
});
