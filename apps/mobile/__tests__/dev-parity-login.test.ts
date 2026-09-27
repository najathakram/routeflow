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
let storeState: { buyer: any; activeSeller: any } = { buyer: null, activeSeller: null };
jest.mock("../lib/buyer-session-store", () => ({
  useBuyerSessionStore: {
    getState: () => ({ ...storeState, setBuyer, setActiveSeller }),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  isPrivateApiUrl,
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

describe("guard 3: only a loopback or private-LAN API", () => {
  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "http://10.0.0.5:3000",
    "http://172.16.0.2:3000",
    "http://172.31.255.1:3000",
    "http://192.168.4.25:3000",
  ])("%s is private", (u) => expect(isPrivateApiUrl(u)).toBe(true));

  it.each([
    "https://routeflowapi-production.up.railway.app",
    "https://www.routeflow.info",
    "http://172.32.0.1:3000",
    "http://11.0.0.1",
    "http://192.169.0.1",
    "http://999.1.1.1",
    "http://localhost.evil.com",
    "not a url",
    undefined,
  ])("%s is NOT private", (u) => expect(isPrivateApiUrl(u)).toBe(false));
});

describe("credentials parsing", () => {
  it("reads email, password and seller from JSON", () => {
    expect(parseParityLogin(CREDS)).toEqual({
      email: "Parity@Test.local",
      password: "pw",
      seller: "test",
    });
  });
  it.each([undefined, "", "not json", '{"email":"a"}', '{"email":"","password":"x"}'])(
    "%s is refused",
    (raw) => expect(parseParityLogin(raw)).toBeNull(),
  );
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

  it("every EXPO_PUBLIC_PARITY_LOGIN read and the marker live inside `if (__DEV__)`", () => {
    const devStart = code.indexOf("if (__DEV__) {");
    expect(devStart).toBeGreaterThan(-1);
    for (const needle of ["process.env.EXPO_PUBLIC_PARITY_LOGIN", "dev-parity-login"]) {
      const first = code.indexOf(needle);
      expect(first).toBeGreaterThan(devStart);
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
