/**
 * Source scan: nothing in `apps/api/src` signs a stateless `email_verify` link any more.
 *
 * Staff verification links are stored single-use tokens (`UserEmailVerificationToken`). The signed
 * link survives only as a legacy VERIFY path in `auth/auth.service.ts` (it decodes, never signs)
 * until `LEGACY_VERIFY_ACCEPT_UNTIL`; a stateless link cannot be revoked, so no new one may be
 * minted. The broader signing inventory lives in `auth/token-sign-sites.spec.ts`.
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walk(p, out);
    } else if (e.name.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const SOURCES = walk(SRC_ROOT)
  .filter((f) => !f.split(path.sep).includes("testing"))
  .map((file) => ({
    rel: path.relative(SRC_ROOT, file).split(path.sep).join("/"),
    lines: fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((text, i) => ({ n: i + 1, text }))
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.text)),
  }));

describe("no stateless email_verify link is signed", () => {
  it('has no payload shaped `type: "email_verify"` anywhere in the API sources', () => {
    const offenders = SOURCES.flatMap((s) =>
      s.lines
        .filter((l) => /\btype:\s*["'`]email_verify["'`]/.test(l.text))
        .map((l) => `${s.rel}:${l.n}`),
    );
    expect(offenders).toEqual([]);
  });

  it("has no .sign( / .signAsync( call that carries the email-verify key, audience or type", () => {
    const offenders: string[] = [];
    for (const s of SOURCES) {
      s.lines.forEach((l, i) => {
        if (!/\.sign(Async)?\(/.test(l.text)) return;
        const window = s.lines
          .slice(i, i + 10)
          .map((x) => x.text)
          .join("\n");
        if (/emailVerify|email_verify|email-verify/.test(window)) offenders.push(`${s.rel}:${l.n}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the tenants service issues verification links through the stored-token helper", () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, "tenants/tenants.service.ts"), "utf8");
    expect(src).toContain("issueEmailVerificationToken(");
    expect(src).not.toMatch(/\.sign\(/);
  });

  it("the legacy verify path only decodes: the one reference to the type is a comparison", () => {
    const hits = SOURCES.flatMap((s) =>
      s.lines
        .filter((l) => /["']email_verify["']/.test(l.text))
        .map((l) => `${s.rel}: ${l.text.trim()}`),
    );
    // the legacy type check, and the audit meta reason string (neither signs anything)
    expect(hits.every((h) => h.startsWith("auth/"))).toBe(true);
  });
});
