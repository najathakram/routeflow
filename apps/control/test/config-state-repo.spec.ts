/**
 * Server-token PR, config: the state repo is its own variable, the deploy key is retired, and the
 * product repo can never be named as the state repo. Required lazily so each test fails on its own.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const cfg = (): any => require("../src/config");

const FULL: Record<string, string> = {
  CONTROL_PASSWORD: "pw-pw-pw-pw",
  CONTROL_SESSION_SECRET: "x".repeat(40),
  CONTROL_GITHUB_TOKEN: "ghp_x",
  CONTROL_REPO: "acme/acme",
  CONTROL_STATE_REPO: "acme/acme-control-state",
  CONTROL_PORT: "8080",
};

describe("CONTROL_STATE_REPO", () => {
  it("is required when not local, and the message names the variable only", () => {
    const env = { ...FULL };
    delete env.CONTROL_STATE_REPO;
    expect(() => cfg().loadConfig(env)).toThrow(/CONTROL_STATE_REPO is required/);
  });

  it("is exposed as config.stateRepo", () => {
    expect(cfg().loadConfig(FULL).stateRepo).toBe("acme/acme-control-state");
  });

  it.each(["acme", "acme/", "/acme", "a/b/c", "acme/ac me", "acme/acme?x=1", "https://x/y/z"])(
    "a malformed value %j is refused as owner/name",
    (bad) => {
      expect(() => cfg().loadConfig({ ...FULL, CONTROL_STATE_REPO: bad })).toThrow(
        /CONTROL_STATE_REPO must be owner\/name/,
      );
    },
  );

  it.each([
    "najathakram/routeflow",
    "NajathAkram/RouteFlow",
    "najathakram/routeflow.git",
    "najathakram/routeflow.wiki",
    "najathakram/routeflow.git.wiki",
    "najathakram/routeflow.wiki.git",
    "najathakram/routeflow.git.git",
    "NAJATHAKRAM/ROUTEFLOW.GIT",
    "najathakram/routeflow/",
    "najathakram/routeflow.git/",
  ])("the product repo spelled %j is refused, naming the rule", (spelled) => {
    expect(() => cfg().loadConfig({ ...FULL, CONTROL_STATE_REPO: spelled })).toThrow(
      /CONTROL_STATE_REPO must not be najathakram\/routeflow/,
    );
  });

  // review F4: trailing dots (alone or mixed with .git/.wiki//) must not slip past the check
  it.each([
    "najathakram/routeflow.",
    "najathakram/routeflow..",
    "najathakram/routeflow..git",
    "najathakram/routeflow.git.",
    "najathakram/routeflow.git./",
    "najathakram/routeflow./",
    "najathakram/routeflow.wiki.",
    "NajathAkram/RouteFlow..GIT",
    "  najathakram/routeflow.  ",
  ])("the product repo with trailing dots %j is refused, naming the rule", (spelled) => {
    expect(() => cfg().loadConfig({ ...FULL, CONTROL_STATE_REPO: spelled })).toThrow(
      /CONTROL_STATE_REPO must not be najathakram\/routeflow/,
    );
  });

  it("fuzz: every spelling built from {.git,.wiki,/,.} suffixes (1-3 deep), in 3 cases, is refused", () => {
    const parts = [".git", ".wiki", "/", "."];
    const suffixes: string[] = [];
    const walk = (cur: string, depth: number): void => {
      if (depth > 0) suffixes.push(cur);
      if (depth === 3) return;
      for (const p of parts) walk(cur + p, depth + 1);
    };
    walk("", 0);
    const bases = ["najathakram/routeflow", "NAJATHAKRAM/ROUTEFLOW", "NajathAkram/RouteFlow"];
    const spellings = bases.flatMap((b) => suffixes.map((x) => b + x));
    expect(spellings.length).toBeGreaterThanOrEqual(40);
    const escaped: string[] = [];
    for (const sp of spellings) {
      try {
        cfg().loadConfig({ ...FULL, CONTROL_STATE_REPO: sp });
        escaped.push(sp);
      } catch (e: any) {
        if (!/CONTROL_STATE_REPO must not be najathakram\/routeflow/.test(e.message)) {
          escaped.push(`${sp} -> ${e.message}`);
        }
      }
    }
    expect(escaped).toEqual([]);
  });

  it.each([
    "najathakram/routeflow-control-state",
    "najathakram/routeflow2",
    "other/routeflow",
    "najathakram/routeflow-state.git",
    "najathakram/.routeflow",
    "najathakram/routeflow.old",
    "najathakram/xrouteflow",
    "najathakram/routeflowx.",
  ])("the look-alike %j stays allowed", (ok) => {
    expect(cfg().loadConfig({ ...FULL, CONTROL_STATE_REPO: ok }).stateRepo).toBe(ok);
  });

  it("refuses a state repo equal to CONTROL_REPO in any spelling, naming the rule", () => {
    for (const same of [
      "acme/acme",
      "ACME/Acme",
      "acme/acme.git",
      "acme/acme.",
      "acme/acme/",
      "acme/acme..git",
      "acme/acme.wiki",
    ]) {
      expect(() => cfg().loadConfig({ ...FULL, CONTROL_STATE_REPO: same })).toThrow(
        /CONTROL_STATE_REPO must not equal CONTROL_REPO/,
      );
    }
  });
  it("a state repo that merely resembles CONTROL_REPO stays allowed", () => {
    for (const ok of ["acme/acme-control-state", "acme/acme2", "other/acme"]) {
      expect(cfg().loadConfig({ ...FULL, CONTROL_STATE_REPO: ok }).stateRepo).toBe(ok);
    }
  });

  it("the refusal applies in local mode too when a value is given, but local needs none", () => {
    const local = { CONTROL_LOCAL: "1" };
    expect(cfg().loadConfig(local).stateRepo).toBeUndefined();
    expect(() =>
      cfg().loadConfig({ ...local, CONTROL_STATE_REPO: "najathakram/routeflow" }),
    ).toThrow(/must not be najathakram\/routeflow/);
  });

  it("missing-variable messages list names only, never a value", () => {
    const env = { ...FULL, CONTROL_GITHUB_TOKEN: "ghp_secret_value_zzz" };
    delete env.CONTROL_STATE_REPO;
    delete env.CONTROL_PASSWORD;
    try {
      cfg().loadConfig(env);
    } catch (e: any) {
      expect(e.message).toMatch(/CONTROL_STATE_REPO is required/);
      expect(e.message).toMatch(/CONTROL_PASSWORD is required/);
      expect(e.message).not.toContain("ghp_secret_value_zzz");
      return;
    }
    throw new Error("loadConfig did not throw");
  });
});

describe("CONTROL_DEPLOY_KEY_B64 is retired", () => {
  it("is no longer required", () => {
    expect(() => cfg().loadConfig(FULL)).not.toThrow();
    expect(cfg().REQUIRED_NON_LOCAL).not.toContain("CONTROL_DEPLOY_KEY_B64");
  });

  it("when set, config carries one warning line that never contains the value", () => {
    const value = "U0VDUkVULUtFWS1ESU5PVEVTVA==";
    const c = cfg().loadConfig({ ...FULL, CONTROL_DEPLOY_KEY_B64: value });
    expect(c.warnings).toEqual(["control: CONTROL_DEPLOY_KEY_B64 is no longer used; remove it"]);
    expect(JSON.stringify(c)).not.toContain(value);
  });

  it("when unset, there is no warning", () => {
    expect(cfg().loadConfig(FULL).warnings).toEqual([]);
  });

  it("the key is not kept on the config object", () => {
    const c = cfg().loadConfig({ ...FULL, CONTROL_DEPLOY_KEY_B64: "dGVzdA==" });
    expect(c).not.toHaveProperty("deployKeyB64");
  });
});

describe("CONTROL_GITHUB_TOKEN and CONTROL_REPO stay required", () => {
  it.each(["CONTROL_GITHUB_TOKEN", "CONTROL_REPO"])("non-local without %s throws", (name) => {
    const env = { ...FULL };
    delete env[name];
    expect(() => cfg().loadConfig(env)).toThrow(new RegExp(`${name} is required`));
  });
});
