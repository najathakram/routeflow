import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * D-03 (#1803): `local:e2e` loads the throwaway `local-sa.env`, which WINS over an exported PLAYWRIGHT_SA_*
 * (an exported `qa_billing_sa` used to shadow it silently and the setup's login 401'd). Overriding is never silent.
 * The module is ESM, so each case runs in a child node process against a temp dir.
 */
describe("scripts/lib/local-sa-env.mjs loadLocalSaEnv", () => {
  const MOD = path.resolve(__dirname, "../../../../scripts/lib/local-sa-env.mjs");
  const posix = process.platform !== "win32";
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsa-env-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = (body: string, mode = 0o600) => {
    const f = path.join(dir, "local-sa.env");
    fs.writeFileSync(f, body, { mode });
    fs.chmodSync(f, mode);
    return f;
  };
  /** Runs loadLocalSaEnv in a child; returns the resulting env, the return value and the warnings. */
  const run = (f: string, env: Record<string, string>) => {
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { loadLocalSaEnv } from ${JSON.stringify("file://" + MOD)};
         const warns = []; const env = ${JSON.stringify(env)};
         const r = loadLocalSaEnv(env, ${JSON.stringify(f)}, { warn: (m) => warns.push(m) });
         console.log(JSON.stringify({ env, r, warns }));`,
      ],
      { encoding: "utf8" },
    );
    return JSON.parse(out) as { env: Record<string, string>; r: any; warns: string[] };
  };
  const BODY = "PLAYWRIGHT_SA_USERNAME=local-sa\nPLAYWRIGHT_SA_PASSWORD=s3cret-local\nOTHER=nope\n";

  it("the file WINS over an exported PLAYWRIGHT_SA_*, with a loud warning that names the variable and never prints a value", () => {
    const { env, r, warns } = run(file(BODY), {
      PLAYWRIGHT_SA_USERNAME: "qa_billing_sa",
      PLAYWRIGHT_SA_PASSWORD: "exported-secret",
    });
    expect(env.PLAYWRIGHT_SA_USERNAME).toBe("local-sa");
    expect(env.PLAYWRIGHT_SA_PASSWORD).toBe("s3cret-local");
    expect(r.shadowed).toEqual(["PLAYWRIGHT_SA_USERNAME", "PLAYWRIGHT_SA_PASSWORD"]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("WARNING");
    expect(warns[0]).toContain("PLAYWRIGHT_SA_USERNAME");
    for (const secret of ["qa_billing_sa", "exported-secret", "s3cret-local", "local-sa\n"]) {
      expect(warns[0]).not.toContain(secret);
    }
  });

  it("no warning when nothing was exported, or the exported value already equals the file's", () => {
    expect(run(file(BODY), {}).warns).toEqual([]);
    expect(
      run(file(BODY), {
        PLAYWRIGHT_SA_USERNAME: "local-sa",
        PLAYWRIGHT_SA_PASSWORD: "s3cret-local",
      }).warns,
    ).toEqual([]);
  });

  it("takes ONLY the two PLAYWRIGHT_SA_* names", () => {
    expect(run(file(BODY), {}).env).not.toHaveProperty("OTHER");
  });

  it("an absent file leaves the environment untouched (the super-admin specs skip as before)", () => {
    const res = run(path.join(dir, "missing.env"), { PLAYWRIGHT_SA_USERNAME: "qa_billing_sa" });
    expect(res.r).toEqual({ loaded: false, reason: "absent" });
    expect(res.env).toEqual({ PLAYWRIGHT_SA_USERNAME: "qa_billing_sa" });
    expect(res.warns).toEqual([]);
  });

  (posix ? it : it.skip)(
    "a group/world-readable copy is ignored entirely (POSIX only: Windows has no mode bits)",
    () => {
      const res = run(file(BODY, 0o644), { PLAYWRIGHT_SA_USERNAME: "qa_billing_sa" });
      expect(res.r).toEqual({ loaded: false, reason: "mode" });
      expect(res.env.PLAYWRIGHT_SA_USERNAME).toBe("qa_billing_sa");
    },
  );
});
