import { strictFake } from "./strict-fake";

describe("strictFake (W-1338): a fake names the members it lacks", () => {
  it("records a missing nested member by path and keeps present members as they are", async () => {
    const misses: string[] = [];
    const list = jest.fn().mockResolvedValue({ data: [] });
    const fake = strictFake<any>(
      { isConfigured: true, client: { subscriptionItems: { list } } },
      "stripe",
      misses,
    );

    expect(fake.isConfigured).toBe(true);
    await fake.client.subscriptionItems.list({});
    expect(list).toHaveBeenCalledTimes(1);
    expect(fake.client.checkout).toBeUndefined();
    expect(fake.client.subscriptionItems.del).toBeUndefined();

    expect(misses).toEqual(["stripe.client.checkout", "stripe.client.subscriptionItems.del"]);
  });

  it("keeps object identity and ignores the probes jest and promises make", async () => {
    const misses: string[] = [];
    const fake = strictFake<any>({ client: { a: {} } }, "stripe", misses);

    expect(fake.client).toBe(fake.client);
    await Promise.resolve(fake.client); // reads `then`
    expect(fake).toEqual(expect.anything());
    expect(misses).toEqual([]);
  });
});
