import { apiClient } from "./api-client";
import { writeLiveCart } from "./counter-live-cart";
import { liveCartKey } from "./counter-live-cart-keys";
import { parkStoredLiveCarts } from "./counter-live-cart-park";

jest.mock("./api-client", () => ({ apiClient: { post: jest.fn() } }));
const post = apiClient.post as unknown as jest.Mock;

const KEY = liveCartKey("acme", "u1");
const line = {
  tempId: "t1",
  productId: "p1",
  name: "Cola",
  unitPrice: 2.5,
  qty: 2,
  listPrice: 2.5,
  unit: "each",
  priceType: "STANDARD",
};
const save = () =>
  writeLiveCart(
    KEY,
    { lines: [line], customer: null, method: "CASH", tendered: "", reference: "", walkIn: true },
    "tab",
  );

beforeEach(() => {
  localStorage.clear();
  post.mockReset();
  post.mockResolvedValue({ data: { id: "x" } });
});

/** W-1184: signing out used to wipe the stored sale with no copy anywhere (the lost-sale path). */
describe("parkStoredLiveCarts (sign-out)", () => {
  it("parks the stored sale on the server before the browser forgets it", async () => {
    save();
    await parkStoredLiveCarts(KEY);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/orders/counter-sale/parked");
    expect(body.id).toEqual(expect.any(String));
    expect(body.payload.lines).toHaveLength(1);
    expect(localStorage.getItem(KEY!)).toBeNull(); // one copy only: it is on the server now
  });

  it("a refused park keeps going: sign-out is never blocked, and nothing throws", async () => {
    save();
    post.mockRejectedValue(new Error("offline"));
    await expect(parkStoredLiveCarts(KEY)).resolves.toBeUndefined();
  });

  it("parks only the signed-in user's cart: another user's stored cart is left untouched", async () => {
    save();
    const other = liveCartKey("acme", "u2")!;
    writeLiveCart(
      other,
      { lines: [line], customer: null, method: "CASH", tendered: "", reference: "", walkIn: true },
      "tab",
    );
    await parkStoredLiveCarts(KEY);
    expect(post).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(other)).not.toBeNull();
    expect(localStorage.getItem(KEY!)).toBeNull();
  });

  it("with no signed-in user (no key) nothing is parked", async () => {
    save();
    await parkStoredLiveCarts(null);
    expect(post).not.toHaveBeenCalled();
  });

  it("an empty browser makes no request", async () => {
    await parkStoredLiveCarts(KEY);
    expect(post).not.toHaveBeenCalled();
  });
});
