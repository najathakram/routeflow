import { fetchOpenPaymentLink } from "./platform-pricing";

const mockGet = jest.fn();
jest.mock("@/lib/admin-api", () => ({
  superAdminClient: { get: (url: string) => mockGet(url), post: jest.fn() },
}));

const LINK = {
  kind: "card",
  url: "https://checkout.example.test/c/pay/cs_test_x",
  expiresAt: "2099-03-04T15:30:00.000Z",
};

describe("fetchOpenPaymentLink", () => {
  beforeEach(() => mockGet.mockReset());

  it("reads this business's open-link route", async () => {
    mockGet.mockResolvedValue({ data: LINK });
    await fetchOpenPaymentLink("t9");
    expect(mockGet).toHaveBeenCalledWith("/platform-admin/tenants/t9/billing/open-link");
  });

  it("returns the link object as sent", async () => {
    mockGet.mockResolvedValue({ data: LINK });
    expect(await fetchOpenPaymentLink("t9")).toEqual(LINK);
  });

  it("the empty body Nest sends for a null result (axios gives an empty string) is null", async () => {
    mockGet.mockResolvedValue({ data: "" });
    expect(await fetchOpenPaymentLink("t9")).toBeNull();
  });

  it("null, and an object with no url, are null", async () => {
    mockGet.mockResolvedValueOnce({ data: null });
    expect(await fetchOpenPaymentLink("t9")).toBeNull();
    mockGet.mockResolvedValueOnce({ data: {} });
    expect(await fetchOpenPaymentLink("t9")).toBeNull();
  });
});
