/**
 * Server-token PR, review F2: the token's Basic form (base64 of `x-access-token:<token>`) is a
 * secret too, and redaction must run BEFORE a message is cut to length (a cut prefix of the
 * secret no longer matches the secret and would slip through). The error text here comes from
 * real git: a file:// origin whose path echoes the secret, placed so it straddles the 160-char
 * cut that `fetchMaster` applies.
 */
import { startServer } from "./helpers/start-server";
import type { Harness } from "./helpers/start-server";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));

const TOKEN = "tok-FAKE-redact-0123456789-abcdef";
const B64 = Buffer.from("x-access-token:" + TOKEN).toString("base64");

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** A master origin whose path puts `secret` so that it starts `at` chars into git's error line. */
const originWith = (secret: string, at: number): string => {
  // git prints: fatal: '<path>' does not appear to be a git repository   ("fatal: '" = 8 chars)
  const lead = "/nonexistent";
  const pad = "p".repeat(Math.max(1, at - 8 - lead.length - 1));
  return `file://${lead}/${pad}/${secret}`;
};

/** Boot a non-fixture server (a fixture swallows master-fetch failures) and return its /api/health body (carries the source warnings). */
const warningsOf = async (origin: string): Promise<string> => {
  const { loadConfig } = require("../src/config");
  const config = loadConfig({
    CONTROL_LOCAL: "1", // no password/origin ceremony; still not a fixture
    CONTROL_PORT: "0",
    CONTROL_REPO: "acme/acme",
    CONTROL_GITHUB_TOKEN: TOKEN,
    CONTROL_STATE_REPO: "acme/acme-control-state",
  });
  h = await startServer({ local: true, depsOver: { config, masterOrigin: origin } });
  await h.app.tick();
  const s = await h.session();
  const r = await h.req("GET", "/api/health", { headers: { cookie: s.cookie } });
  return r.text;
};

describe("redaction covers the Basic form and runs before truncation", () => {
  it("precondition: the base64 form has no '/' (so it can sit in a path)", () => {
    expect(B64).not.toContain("/");
  });

  it.each([100, 125, 140, 150])(
    "a base64 token starting %d chars into the error never shows a 12-char prefix",
    async (at) => {
      const out = await warningsOf(originWith(B64, at));
      expect(out).toContain("master fetch"); // the fetch really failed and was reported
      expect(out).not.toContain(B64.slice(0, 12));
      expect(out).not.toContain(B64);
    },
  );

  it("the full `Authorization: Basic <b64>` string is redacted too, split by the cut", async () => {
    const out = await warningsOf(originWith(`Authorization: Basic ${B64}`, 135));
    expect(out).toContain("master fetch");
    expect(out).not.toContain(B64.slice(0, 12));
    expect(out).not.toContain("Authorization: Basic");
  });

  it("the raw token is still redacted (existing behaviour)", async () => {
    const out = await warningsOf(originWith(TOKEN, 140));
    expect(out).toContain("master fetch");
    expect(out).not.toContain(TOKEN.slice(0, 12));
  });
});
