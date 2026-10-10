/**
 * B1094 cross-customer guard: the buyer's Idempotency-Key is customer-scoped on the server, so the
 * module-level key must never survive a logout or a seller switch, and must be minted under WHO is
 * submitting (buyer account + active seller) so a switch the clear missed still gets a fresh key.
 */
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
jest.mock("expo-web-browser", () => ({ openAuthSessionAsync: jest.fn() }));

const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => mockStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void mockStore.set(k, v),
  deleteItemAsync: async (k: string) => void mockStore.delete(k),
}));

import { BUYER_KEYS } from "../lib/auth-keys";
import { toSecureStoreKey } from "../lib/secure-key";
import {
  buyerApiClient,
  buyerLogout,
  getBuyerSubmitScope,
  setActiveSeller,
  type BuyerSeller,
} from "../lib/buyer-auth";
import { buyerSubmitKeyFor, clearBuyerSubmitKey } from "../lib/buyer-submit-key";

const seller = (id: string) =>
  ({ linkId: `l-${id}`, linkStatus: "ACTIVE", tenant: { id } }) as unknown as BuyerSeller;
const jwt = (sub: string) =>
  `h.${Buffer.from(JSON.stringify({ sub, type: "BUYER" })).toString("base64")}.s`;
const cart = { items: [{ productId: "p1", qty: 3 }] };

describe("buyer submit key never crosses a customer", () => {
  beforeEach(() => {
    mockStore.clear();
    clearBuyerSubmitKey();
    jest.spyOn(buyerApiClient, "post").mockResolvedValue({ data: {} } as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it("logout drops the key: the next buyer's identical cart mints a new one", async () => {
    const before = buyerSubmitKeyFor(cart);
    await buyerLogout();
    expect(buyerSubmitKeyFor(cart)).not.toBe(before);
  });

  it("switching seller drops the key", async () => {
    const before = buyerSubmitKeyFor(cart);
    await setActiveSeller(seller("t-2"));
    expect(buyerSubmitKeyFor(cart)).not.toBe(before);
  });

  it("the scope names the buyer account and the active seller, so either changing is a new cart", async () => {
    mockStore.set(toSecureStoreKey(BUYER_KEYS.accessToken), jwt("buyer-1"));
    await setActiveSeller(seller("t-1"));
    const a = await getBuyerSubmitScope();
    await setActiveSeller(seller("t-2"));
    const b = await getBuyerSubmitScope();
    mockStore.set(toSecureStoreKey(BUYER_KEYS.accessToken), jwt("buyer-2"));
    const c = await getBuyerSubmitScope();
    expect(new Set([a, b, c]).size).toBe(3);
    // and the same cart under two scopes never shares a key, even with no clear in between
    expect(buyerSubmitKeyFor(cart, a)).not.toBe(buyerSubmitKeyFor(cart, c));
  });
});
