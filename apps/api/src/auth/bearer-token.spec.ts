import { ExtractJwt } from "passport-jwt";
import { bearerTokenOf } from "./bearer-token";

/**
 * `bearerTokenOf` reads an Authorization header exactly as the JWT strategies do. The oracle is passport-jwt's own
 * extractor (the one `JwtStrategy` / `BuyerJwtStrategy` use), over a matrix of header shapes.
 */
describe("bearerTokenOf (reads the Authorization scheme like the JWT strategy)", () => {
  const extract = ExtractJwt.fromAuthHeaderAsBearerToken();
  const HEADERS: unknown[] = [
    "Bearer abc.def.ghi",
    "bearer abc.def.ghi",
    "BEARER abc.def.ghi",
    "BeArEr abc.def.ghi",
    "Bearer  abc.def.ghi",
    "Bearer\tabc.def.ghi",
    "  Bearer abc.def.ghi",
    "Bearer abc.def.ghi extra",
    "Bearer",
    "Bearer ",
    "",
    "abc.def.ghi",
    "Basic abc.def.ghi",
    "Token abc.def.ghi",
    "Bearerx abc.def.ghi",
    undefined,
    ["Bearer abc"],
    42,
  ];

  it.each(HEADERS.map((h) => [JSON.stringify(h) ?? "undefined", h]))(
    "agrees with passport-jwt for %s",
    (_label, header) => {
      const fromPassport = extract({ headers: { authorization: header } } as never);
      expect(bearerTokenOf(header)).toBe(fromPassport ?? null);
    },
  );
});

describe("bearerTokenOf is linear on a long header", () => {
  it("reads a 64 KB header with no whitespace without a stall, and still agrees with the strategy", () => {
    const long = "A".repeat(64 * 1024);
    const started = Date.now();
    expect(bearerTokenOf(long)).toBeNull();
    expect(bearerTokenOf(`Bearer ${long}`)).toBe(long);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("keeps passport's reading for padded and multi-token headers", () => {
    const extract = ExtractJwt.fromAuthHeaderAsBearerToken();
    for (const h of ["  Bearer   x  ", "Bearer\n\tx y z", "\tbearer x", "Bearer", "", "   "]) {
      expect(bearerTokenOf(h)).toBe(extract({ headers: { authorization: h } } as never) ?? null);
    }
  });
});
