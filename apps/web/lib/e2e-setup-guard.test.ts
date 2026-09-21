import fs from "fs";
import path from "path";
import {
  SetupGuardError,
  assertSafeSetupTarget,
  envInput,
  evaluateSetupTarget,
  requireBaseUrl,
  type SetupGuardCheck,
  type SetupTargetInput,
} from "./e2e-setup-guard";

const PROD = "https://routeflowweb-production.up.railway.app";

/** Refusal table: every row MUST be refused, by exactly the named check. */
const REFUSALS: Array<[string, SetupTargetInput, SetupGuardCheck]> = [
  // 1. unset / empty — a refusal, never a default
  ["unset", {}, "base-url-unset"],
  ["undefined explicitly", { baseUrl: undefined }, "base-url-unset"],
  ["empty string", { baseUrl: "" }, "base-url-unset"],
  ["whitespace only", { baseUrl: "   " }, "base-url-unset"],
  // malformed
  ["not a url", { baseUrl: "not a url" }, "base-url-invalid"],
  // `localhost:` parses as a URL *scheme*, so a bare host:port is refused by the scheme check.
  ["bare host:port, no scheme", { baseUrl: "localhost:3001" }, "scheme"],
  ["scheme-relative", { baseUrl: "//localhost:3001" }, "base-url-invalid"],
  // 2. the production URL (the value the old default resolved to)
  ["prod URL", { baseUrl: PROD }, "non-local"],
  ["prod URL with trailing slash + path", { baseUrl: `${PROD}/login` }, "non-local"],
  // 2. lookalike hosts — PARSED, never substring-matched
  ["lookalike: localhost.evil.com", { baseUrl: "http://localhost.evil.com" }, "non-local"],
  ["lookalike: localhost.attacker.net", { baseUrl: "http://localhost.attacker.net" }, "non-local"],
  [
    "localhost only in the query",
    { baseUrl: "https://evil.example.com/?x=localhost" },
    "non-local",
  ],
  ["localhost only in the path", { baseUrl: "https://evil.example.com/localhost" }, "non-local"],
  ["localhost as userinfo", { baseUrl: "http://localhost@evil.com" }, "non-local"],
  ["localhost as a port-less suffix", { baseUrl: "http://evillocalhost:3001" }, "non-local"],
  // non-loopback IPs (only exactly 127.0.0.1 / ::1 are loopback here)
  ["private LAN IP", { baseUrl: "http://192.168.1.10:3001" }, "non-local"],
  ["10.x IP", { baseUrl: "http://10.0.0.5" }, "non-local"],
  ["other 127.x address", { baseUrl: "http://127.0.0.2:3001" }, "non-local"],
  ["0.0.0.0", { baseUrl: "http://0.0.0.0:3001" }, "non-local"],
  ["public IP", { baseUrl: "http://8.8.8.8" }, "non-local"],
  ["IPv6 non-loopback", { baseUrl: "http://[2001:db8::1]:3001" }, "non-local"],
  // non-http schemes are refused regardless of the (local) host
  ["ftp scheme", { baseUrl: "ftp://localhost" }, "scheme"],
  ["file scheme", { baseUrl: "file://localhost/etc/passwd" }, "scheme"],
  ["ws scheme", { baseUrl: "ws://localhost:3001" }, "scheme"],
  ["javascript scheme", { baseUrl: "javascript:alert(1)" }, "scheme"],
  // 3. tenants that are not approved test tenants (the single list: assertTestTenant)
  ["live-looking tenant slug", { baseUrl: "http://localhost:3001", tenantSlug: "acme" }, "tenant"],
  ["empty tenant slug", { baseUrl: "http://localhost:3001", tenantSlug: "" }, "tenant"],
  [
    "uppercase of an approved slug",
    { baseUrl: "http://localhost:3001", tenantSlug: "E2E-ROUTEFLOW" },
    "tenant",
  ],
  [
    "prefix that is not the pattern",
    { baseUrl: "http://localhost:3001", tenantSlug: "qa" },
    "tenant",
  ],
  // remote-permit values that are NOT the sanctioned ones
  ["GITHUB_ACTIONS=1", { baseUrl: PROD, githubActions: "1" }, "non-local"],
  ["GITHUB_ACTIONS=false", { baseUrl: PROD, githubActions: "false" }, "non-local"],
  ["GITHUB_ACTIONS=TRUE (case)", { baseUrl: PROD, githubActions: "TRUE" }, "non-local"],
  ["E2E_ALLOW_REMOTE_AUTH=true", { baseUrl: PROD, allowRemote: "true" }, "non-local"],
  ["E2E_ALLOW_REMOTE_AUTH=yes", { baseUrl: PROD, allowRemote: "yes" }, "non-local"],
  ["E2E_ALLOW_REMOTE_AUTH=0", { baseUrl: PROD, allowRemote: "0" }, "non-local"],
  ["E2E_ALLOW_REMOTE_AUTH empty", { baseUrl: PROD, allowRemote: "" }, "non-local"],
  // a sanctioned remote path never relaxes scheme or tenant
  [
    "remote permitted, but ftp scheme",
    { baseUrl: "ftp://example.com", githubActions: "true" },
    "scheme",
  ],
  [
    "remote permitted, but live tenant",
    { baseUrl: PROD, allowRemote: "1", tenantSlug: "acme" },
    "tenant",
  ],
  // ordering: the first failing check names itself
  ["unset beats a bad tenant", { tenantSlug: "acme" }, "base-url-unset"],
  ["scheme beats non-local", { baseUrl: "ftp://evil.com" }, "scheme"],
  ["non-local beats tenant", { baseUrl: PROD, tenantSlug: "acme" }, "non-local"],
];

/** Pass table: every row MUST be accepted. */
const PASSES: Array<[string, SetupTargetInput, { remote: boolean; tenantSlug: string }]> = [
  [
    "the happy path",
    { baseUrl: "http://localhost:3001" },
    { remote: false, tenantSlug: "e2e-routeflow" },
  ],
  [
    "localhost with a path and query",
    { baseUrl: "http://localhost:3001/login?next=/dashboard" },
    { remote: false, tenantSlug: "e2e-routeflow" },
  ],
  [
    "https localhost",
    { baseUrl: "https://localhost:3443" },
    { remote: false, tenantSlug: "e2e-routeflow" },
  ],
  [
    "127.0.0.1",
    { baseUrl: "http://127.0.0.1:3001" },
    { remote: false, tenantSlug: "e2e-routeflow" },
  ],
  [
    "IPv6 loopback",
    { baseUrl: "http://[::1]:3001/x" },
    { remote: false, tenantSlug: "e2e-routeflow" },
  ],
  [
    "uppercase host",
    { baseUrl: "HTTP://LOCALHOST:3001" },
    { remote: false, tenantSlug: "e2e-routeflow" },
  ],
  [
    "surrounding whitespace",
    { baseUrl: "  http://localhost:3001  " },
    { remote: false, tenantSlug: "e2e-routeflow" },
  ],
  [
    "the demo tenant",
    { baseUrl: "http://localhost:3001", tenantSlug: "routeflow-demo" },
    { remote: false, tenantSlug: "routeflow-demo" },
  ],
  [
    "a throwaway qa-* tenant",
    { baseUrl: "http://localhost:3001", tenantSlug: "qa-964-1" },
    { remote: false, tenantSlug: "qa-964-1" },
  ],
  [
    "a throwaway e2e-* tenant",
    { baseUrl: "http://localhost:3001", tenantSlug: "e2e-abc" },
    { remote: false, tenantSlug: "e2e-abc" },
  ],
  // the two sanctioned remote paths keep today's CI / human-prod behaviour
  [
    "GitHub Actions against prod (post-deploy / nightly / ci)",
    { baseUrl: PROD, githubActions: "true" },
    { remote: true, tenantSlug: "e2e-routeflow" },
  ],
  [
    "a human's explicit opt-in against prod",
    { baseUrl: PROD, allowRemote: "1" },
    { remote: true, tenantSlug: "e2e-routeflow" },
  ],
];

describe("evaluateSetupTarget — refusals", () => {
  it.each(REFUSALS)("REFUSES %s", (_name, input, check) => {
    const result = evaluateSetupTarget(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.check).toBe(check);
      expect(result.message).toContain("[e2e setup guard] REFUSED");
      expect(result.message).toContain(check);
    }
  });
});

describe("evaluateSetupTarget — passes", () => {
  it.each(PASSES)("ACCEPTS %s", (_name, input, expected) => {
    const result = evaluateSetupTarget(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.remote).toBe(expected.remote);
      expect(result.tenantSlug).toBe(expected.tenantSlug);
    }
  });

  it("returns the normalised URL it vetted, not the raw string", () => {
    const result = evaluateSetupTarget({ baseUrl: "  HTTP://LOCALHOST:3001  " });
    expect(result.ok && result.baseUrl).toBe("http://localhost:3001/");
  });
});

describe("refusal messages say which check failed and what NOT to do", () => {
  it("unset: no default, set it locally, never point it at prod", () => {
    const r = evaluateSetupTarget({});
    expect(!r.ok && r.message).toMatch(/PLAYWRIGHT_BASE_URL is not set/);
    expect(!r.ok && r.message).toMatch(/no default/i);
    expect(!r.ok && r.message).toContain("http://localhost:3001");
    expect(!r.ok && r.message).toMatch(/Do NOT .* production/);
  });

  it("non-local: names the host, forbids agents, forbids the escape variable", () => {
    const r = evaluateSetupTarget({ baseUrl: PROD });
    expect(!r.ok && r.message).toContain("routeflowweb-production.up.railway.app");
    expect(!r.ok && r.message).toMatch(/human-only/);
    expect(!r.ok && r.message).toMatch(/NEVER set E2E_ALLOW_REMOTE_AUTH/);
    expect(!r.ok && r.message).toContain("npm run local:up");
  });

  it("tenant: names the offending slug and the approved-tenant policy", () => {
    const r = evaluateSetupTarget({ baseUrl: "http://localhost:3001", tenantSlug: "acme" });
    expect(!r.ok && r.message).toContain('"acme"');
    expect(!r.ok && r.message).toMatch(/approved test tenant/);
  });
});

describe("assertSafeSetupTarget", () => {
  it("throws a SetupGuardError carrying the failed check", () => {
    let caught: unknown;
    try {
      assertSafeSetupTarget({ baseUrl: "http://localhost.evil.com" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SetupGuardError);
    expect((caught as SetupGuardError).check).toBe("non-local");
  });

  it("returns the vetted target for a safe input", () => {
    expect(assertSafeSetupTarget({ baseUrl: "http://localhost:3001" })).toMatchObject({
      ok: true,
      remote: false,
      tenantSlug: "e2e-routeflow",
    });
  });
});

describe("envInput maps the real environment variable names", () => {
  it("reads exactly PLAYWRIGHT_BASE_URL / PLAYWRIGHT_TENANT_SLUG / GITHUB_ACTIONS / E2E_ALLOW_REMOTE_AUTH", () => {
    expect(
      envInput({
        PLAYWRIGHT_BASE_URL: "http://localhost:3001",
        PLAYWRIGHT_TENANT_SLUG: "qa-x",
        GITHUB_ACTIONS: "true",
        E2E_ALLOW_REMOTE_AUTH: "1",
      }),
    ).toEqual({
      baseUrl: "http://localhost:3001",
      tenantSlug: "qa-x",
      githubActions: "true",
      allowRemote: "1",
    });
  });

  it("an empty environment yields an input that is refused (unset), never defaulted", () => {
    expect(evaluateSetupTarget(envInput({}))).toMatchObject({
      ok: false,
      check: "base-url-unset",
    });
  });
});

describe("requireBaseUrl (config level, every project)", () => {
  it.each([
    ["unset", {}],
    ["empty", { PLAYWRIGHT_BASE_URL: "" }],
    ["whitespace", { PLAYWRIGHT_BASE_URL: "  " }],
  ])("throws when %s — there is no fallback", (_n, env) => {
    expect(() => requireBaseUrl(env)).toThrow(SetupGuardError);
  });

  it("returns the caller's value untouched when set (locality is the setup project's job)", () => {
    expect(requireBaseUrl({ PLAYWRIGHT_BASE_URL: "http://localhost:3001" })).toBe(
      "http://localhost:3001",
    );
    expect(requireBaseUrl({ PLAYWRIGHT_BASE_URL: PROD })).toBe(PROD);
  });
});

describe("wiring is pinned — the production default cannot come back", () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

  it("playwright.config.ts has no PLAYWRIGHT_BASE_URL fallback and uses requireBaseUrl", () => {
    const src = read("playwright.config.ts");
    expect(src).not.toMatch(/PLAYWRIGHT_BASE_URL\s*\?\?/);
    expect(src).not.toMatch(/routeflowweb-production\.up\.railway\.app/);
    expect(src).toContain("requireBaseUrl(");
  });

  it("e2e/setup/auth.setup.ts has no fallback and vets the target with assertSafeSetupTarget", () => {
    const src = read("e2e/setup/auth.setup.ts");
    expect(src).not.toMatch(/PLAYWRIGHT_BASE_URL\s*\?\?/);
    expect(src).not.toMatch(/routeflowweb-production\.up\.railway\.app/);
    expect(src).toContain("assertSafeSetupTarget(");
  });
});
