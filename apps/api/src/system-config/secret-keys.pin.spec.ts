import * as fs from "fs";
import * as path from "path";
import { SECRET_KEYS } from "./system-config.service";
import { PLATFORM_SECRET_KEYS } from "../platform-admin/platform-config.service";
import { ENCRYPTED_FORMAT } from "../common/secret-at-rest";

/**
 * SA-1102 PR-A §2.5 (S-10): a config key whose NAME says it is a secret must be in the encrypted set. Every string
 * literal passed to `SystemConfigService.get/set` or `PlatformConfigService.getValue/setValue` that matches
 * /(api)?key$|secret|token|password/i is in SECRET_KEYS or PLATFORM_SECRET_KEYS, or in the short reviewed NOT_SECRET
 * list below with the reason. A new secret-named key that is not classified fails here, before it is stored in plaintext.
 */
const SECRET_NAME = /(api)?key$|secret|token|password/i;

/** Reviewed: the name matches, the value is not a secret. */
const NOT_SECRET: Record<string, string> = {
  "claude.maxTokens": "a token COUNT (an integer limit), not a credential",
  "platform.houseTenantId": "a tenant id, not a secret",
};

const SRC = path.join(__dirname, "..");
const CALL =
  /\b(?:systemConfig|systemConfigService|svc|this)\s*\??\.\s*(?:get|set|getValue|setValue|deleteValue)\(\s*"([^"]+)"/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function literalKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const r = path.relative(SRC, file).split(path.sep).join("/");
    if (r.endsWith(".spec.ts") || r.includes("/testing/")) continue;
    const text = fs.readFileSync(file, "utf8");
    if (!/SystemConfigService|PlatformConfigService|getValue\(|setValue\(/.test(text)) continue;
    for (const m of text.matchAll(CALL)) keys.set(m[1], [...(keys.get(m[1]) ?? []), r]);
  }
  return keys;
}

describe("secret-named config keys are encrypted at rest (SA-1102 S-10)", () => {
  it("the two sets hold the four SystemConfig secrets and the one PlatformConfig secret", () => {
    expect([...SECRET_KEYS].sort()).toEqual([
      "anthropic.apiKey",
      "email.smtpPassword",
      "zoho.clientSecret",
      "zoho.refreshToken",
    ]);
    expect([...PLATFORM_SECRET_KEYS]).toEqual(["claude.apiKey"]);
  });

  it("every secret-named literal key is in a secret set or the reviewed NOT_SECRET list", () => {
    const unlisted = [...literalKeys().entries()]
      .filter(([k]) => SECRET_NAME.test(k))
      .filter(([k]) => !SECRET_KEYS.has(k) && !PLATFORM_SECRET_KEYS.has(k) && !(k in NOT_SECRET))
      .map(([k, files]) => `${k} (${[...new Set(files)].join(", ")})`);
    expect(unlisted).toEqual([]);
  });

  it("the scan sees the real secret keys (the pin is not vacuous)", () => {
    const seen = [...literalKeys().keys()];
    expect(seen).toEqual(expect.arrayContaining(["anthropic.apiKey", "claude.apiKey"]));
  });

  it("a NOT_SECRET entry that is no longer a literal key anywhere is stale", () => {
    const seen = new Set(literalKeys().keys());
    const text = walk(SRC)
      .filter((f) => !f.endsWith(".spec.ts"))
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    for (const k of Object.keys(NOT_SECRET))
      expect(seen.has(k) || text.includes(`"${k}"`)).toBe(true);
  });

  it("the plaintext-secrets script lists exactly the same keys and the same cipher shape", () => {
    const script = fs.readFileSync(
      path.join(__dirname, "../../scripts/report-plaintext-secrets.mjs"),
      "utf8",
    );
    const list = (name: string) => {
      const body = script.match(new RegExp(`${name} = \\[([^\\]]*)\\]`))?.[1] ?? "";
      return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    };
    expect(list("SYSTEM_CONFIG_SECRET_KEYS").sort()).toEqual([...SECRET_KEYS].sort());
    expect(list("PLATFORM_CONFIG_SECRET_KEYS").sort()).toEqual([...PLATFORM_SECRET_KEYS].sort());
    expect(script).toContain(`CIPHER_SHAPE = "${ENCRYPTED_FORMAT.source}"`);
  });
});
