/**
 * A session token whose `aud` is present must name that realm: the staff strategy, the buyer
 * strategy and both gateway branches refuse a foreign `aud`. A token with no `aud` is unchanged.
 */
import { JwtService } from "@nestjs/jwt";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { BuyerJwtStrategy } from "../buyer/strategies/buyer-jwt.strategy";

const SECRET = "realm-audience-test-secret-0123456789";
const jwt = new JwtService({ secret: SECRET });
const cfg = { get: () => ({ secret: SECRET }) } as never;

const staffClaims = {
  sub: "u1",
  username: "alice",
  role: "OPERATOR",
  status: "ACTIVE",
  tenantId: "t1",
  canActAsDriver: false,
};
const buyerClaims = { sub: "b1", email: "b@example.test", name: "B", type: "BUYER" };

function authenticate(strategy: any, token: string) {
  return new Promise<string>((resolve) => {
    strategy.success = () => resolve("success");
    strategy.fail = () => resolve("fail");
    strategy.error = () => resolve("error");
    strategy.authenticate({ headers: { authorization: `Bearer ${token}` } });
  });
}

async function connect(claims: Record<string, unknown>, aud?: string | string[]) {
  const token = jwt.sign(claims, { expiresIn: "15m", ...(aud ? { audience: aud } : {}) });
  const prisma = {
    user: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: "u1", role: "OPERATOR", tenantId: "t1", canActAsDriver: false }]),
    },
    buyerAccount: { findMany: jest.fn().mockResolvedValue([{ id: "b1" }]) },
    customerLink: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const gateway = new RouteFlowGateway(jwt, prisma as any);
  const client: any = {
    handshake: { auth: { token }, headers: {} },
    data: {},
    rooms: new Set<string>(),
    id: "s1",
    join: jest.fn(),
    leave: jest.fn(),
    disconnect: jest.fn(),
  };
  await gateway.handleConnection(client);
  return client;
}

describe("staff strategy audience", () => {
  const strategy = new JwtStrategy(cfg);
  const sign = (aud?: string | string[]) =>
    jwt.sign(staffClaims, { expiresIn: "15m", ...(aud ? { audience: aud } : {}) });

  it.each([[undefined], ["staff-access"], [["staff-access"]]])("admits aud %p", async (aud) => {
    expect(await authenticate(strategy, sign(aud as never))).toBe("success");
  });

  it.each([
    ["buyer-access"],
    ["email-verify"],
    ["stripe-connect-state"],
    [["staff-access", "buyer-access"]],
  ])("refuses a foreign aud %p", async (aud) => {
    expect(await authenticate(strategy, sign(aud as never))).not.toBe("success");
    await expect(strategy.validate({ ...staffClaims, aud } as never)).rejects.toBeDefined();
  });
});

describe("buyer strategy audience", () => {
  const strategy = new BuyerJwtStrategy(cfg);
  const sign = (aud?: string | string[]) =>
    jwt.sign(buyerClaims, { expiresIn: "15m", ...(aud ? { audience: aud } : {}) });

  it.each([[undefined], ["buyer-access"]])("admits aud %p", async (aud) => {
    expect(await authenticate(strategy, sign(aud as never))).toBe("success");
  });

  it.each([["staff-access"], ["email-verify"], ["stripe-connect-state"]])(
    "refuses a foreign aud %p",
    async (aud) => {
      expect(await authenticate(strategy, sign(aud))).not.toBe("success");
      await expect(strategy.validate({ ...buyerClaims, aud } as never)).rejects.toBeDefined();
    },
  );
});

describe("gateway audience", () => {
  it.each([[undefined], ["staff-access"]])("staff branch admits aud %p", async (aud) => {
    const client = await connect(staffClaims, aud);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.join).toHaveBeenCalled();
  });

  it.each([["buyer-access"], ["email-verify"], ["stripe-connect-state"]])(
    "staff branch refuses foreign aud %p",
    async (aud) => {
      const client = await connect(staffClaims, aud);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    },
  );

  it.each([[undefined], ["buyer-access"]])("buyer branch admits aud %p", async (aud) => {
    const client = await connect(buyerClaims, aud);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.data.buyerAccountId).toBe("b1");
  });

  it.each([["staff-access"], ["email-verify"], ["stripe-connect-state"]])(
    "buyer branch refuses foreign aud %p",
    async (aud) => {
      const client = await connect(buyerClaims, aud);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.data.buyerAccountId).toBeUndefined();
    },
  );
});
