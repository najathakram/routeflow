/**
 * SECURITY TIER 1 pins for lib/dev-parity-login.ts (#2338): every guard the lead ruled.
 */
import * as fs from "fs";
import * as path from "path";

const buyerLogin = jest.fn();
const getBuyerSellers = jest.fn();
jest.mock("../lib/buyer-auth", () => ({
  buyerLogin: (...a: unknown[]) => buyerLogin(...a),
  getBuyerSellers: (...a: unknown[]) => getBuyerSellers(...a),
}));

const setBuyer = jest.fn();
const setActiveSeller = jest.fn();
const signOut = jest.fn();
let storeState: { buyer: any; activeSeller: any } = { buyer: null, activeSeller: null };
jest.mock("../lib/buyer-session-store", () => ({
  useBuyerSessionStore: {
    getState: () => ({ ...storeState, setBuyer, setActiveSeller, signOut }),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  isSimulatorApiUrl,
  parseParityLogin,
  maybeDevParityLogin,
} = require("../lib/dev-parity-login");

const CREDS = JSON.stringify({ email: "Parity@Test.local", password: "pw", seller: "test" });
const LOCAL = { parityLogin: CREDS, apiUrl: "http://localhost:3000" };
const g = globalThis as any;

beforeEach(() => {
  jest.clearAllMocks();
  storeState = { buyer: null, activeSeller: null };
  g.__DEV__ = true;
  buyerLogin.mockResolvedValue({ buyer: { email: "parity@test.local" } });
  getBuyerSellers.mockResolvedValue([{ tenant: { slug: "other" } }, { tenant: { slug: "test" } }]);
});

describe("guard 3 (Opus fold): only the simulator's own loopback API, http(s) only", () => {
  it.each([
    "http://localhost:3000",
    "https://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "http://10.0.2.2:3000", // the Android emulator's alias for the host loopback
  ])("%s is allowed", (u) => expect(isSimulatorApiUrl(u)).toBe(true));

  it.each([
    "http://192.168.4.25:3000", // LAN addresses are refused: the harness is simulator-only
    "http://10.0.0.5:3000",
    "http://172.16.0.2:3000",
    "http://127.0.0.2:3000",
    "ftp://localhost:3000", // not http(s)
    "file://localhost/x",
    "https://routeflowapi-production.up.railway.app",
    "http://localhost.evil.com",
    "not a url",
    undefined,
  ])("%s is refused", (u) => expect(isSimulatorApiUrl(u)).toBe(false));
});

describe("credentials parsing", () => {
  it("reads email, password and seller from JSON", () => {
    expect(parseParityLogin(CREDS)).toEqual({
      email: "Parity@Test.local",
      password: "pw",
      seller: "test",
    });
  });
  it.each([
    undefined,
    "",
    "not json",
    '{"email":"a"}',
    '{"email":"","password":"x"}',
    '{"email":"a@b","password":"x"}', // no seller: no default-tenant fallback (Opus fold)
  ])("%s is refused", (raw) => expect(parseParityLogin(raw)).toBeNull());
});

describe("maybeDevParityLogin: every guard", () => {
  it("guard 1: outside __DEV__ it does nothing at all", async () => {
    g.__DEV__ = false;
    await expect(maybeDevParityLogin(LOCAL)).resolves.toBe("skipped");
    expect(buyerLogin).not.toHaveBeenCalled();
  });

  it("guard 2: without EXPO_PUBLIC_PARITY_LOGIN it does nothing", async () => {
    await expect(maybeDevParityLogin({ apiUrl: LOCAL.apiUrl })).resolves.toBe("skipped");
    expect(buyerLogin).not.toHaveBeenCalled();
  });

  it("guard 3: against a deployed API it does nothing", async () => {
    await expect(
      maybeDevParityLogin({
        parityLogin: CREDS,
        apiUrl: "https://routeflowapi-production.up.railway.app",
      }),
    ).resolves.toBe("skipped");
    expect(buyerLogin).not.toHaveBeenCalled();
  });

  it("an already signed-in parity buyer is left alone", async () => {
    storeState = {
      buyer: { email: "parity@test.local" },
      activeSeller: { tenant: { slug: "test" } },
    };
    await expect(maybeDevParityLogin(LOCAL)).resolves.toBe("already-signed-in");
    expect(buyerLogin).not.toHaveBeenCalled();
  });

  it("all guards hold: signs in through the real path and picks the named seller", async () => {
    await expect(maybeDevParityLogin(LOCAL)).resolves.toBe("signed-in");
    expect(buyerLogin).toHaveBeenCalledWith("parity@test.local", "pw");
    expect(setBuyer).toHaveBeenCalledWith({ email: "parity@test.local" });
    expect(setActiveSeller).toHaveBeenCalledWith({ tenant: { slug: "test" } });
  });

  it("Opus fold: a seller that is not linked ⇒ skipped, NO activation, and the half sign-in is cleared", async () => {
    getBuyerSellers.mockResolvedValue([{ tenant: { slug: "other" } }]);
    await expect(maybeDevParityLogin(LOCAL)).resolves.toBe("skipped");
    expect(setActiveSeller).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("Opus fold: a seller lookup that throws after setBuyer also clears the half sign-in", async () => {
    getBuyerSellers.mockRejectedValue(new Error("500"));
    await expect(maybeDevParityLogin(LOCAL)).resolves.toBe("skipped");
    expect(setActiveSeller).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("a failed sign-in never throws (the app stays on its login screen)", async () => {
    buyerLogin.mockRejectedValue(new Error("401"));
    await expect(maybeDevParityLogin(LOCAL)).resolves.toBe("skipped");
    expect(setActiveSeller).not.toHaveBeenCalled();
  });
});

describe("static pins: nothing leaks outside the dev branch", () => {
  const mobile = path.resolve(__dirname, "..");
  const src = fs.readFileSync(path.join(mobile, "lib", "dev-parity-login.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("every EXPO_PUBLIC_PARITY_LOGIN read and the marker are CONTAINED in the `if (__DEV__)` block", () => {
    const open = code.indexOf("if (__DEV__) {");
    expect(open).toBeGreaterThan(-1);
    // The block's matching close brace, by counting braces from its opening one.
    let depth = 0;
    let close = -1;
    for (let i = code.indexOf("{", open); i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) {
        close = i;
        break;
      }
    }
    expect(close).toBeGreaterThan(open);
    for (const needle of ["process.env.EXPO_PUBLIC_PARITY_LOGIN", "dev-parity-login"]) {
      let at = code.indexOf(needle);
      expect(at).toBeGreaterThan(-1);
      for (; at !== -1; at = code.indexOf(needle, at + 1)) {
        expect(at > open && at < close).toBe(true);
      }
    }
  });

  it("no top-level string constant carries the marker (it would ship in production)", () => {
    expect(code).not.toMatch(/^export const .*dev-parity-login/m);
  });

  it("EXPO_PUBLIC_PARITY_LOGIN is referenced by no other app file", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (
          /\.(ts|tsx|js)$/.test(name) &&
          fs.readFileSync(full, "utf8").includes("EXPO_PUBLIC_PARITY_LOGIN")
        )
          hits.push(path.relative(mobile, full));
      }
    };
    for (const dir of ["app", "lib", "components"]) walk(path.join(mobile, dir));
    expect(hits).toEqual([path.join("lib", "dev-parity-login.ts")]);
  });
});
