import {
  CrmAuthError,
  CrmHttpError,
  CrmRateLimitError,
  GoHighLevelClient,
} from "./gohighlevel.client";

function mockFetchOnce(response: {
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  json?: () => Promise<unknown>;
}) {
  const headerMap = new Map(Object.entries(response.headers ?? {}));
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    headers: { get: (key: string) => headerMap.get(key) ?? null },
    json: response.json ?? (async () => ({})),
  });
}

describe("GoHighLevelClient", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  // T6 (R2): concrete URL + header contract for a GET call.
  it("T6: getLocation() calls the fixed GHL URL with the required headers", async () => {
    mockFetchOnce({ ok: true, json: async () => ({ location: { id: "loc1", name: "Acme HQ" } }) });
    const client = new GoHighLevelClient({ token: "tok", locationId: "loc1" });

    await client.getLocation();

    expect(global.fetch).toHaveBeenCalledWith(
      "https://services.leadconnectorhq.com/locations/loc1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer tok",
          Version: "2021-07-28",
          Accept: "application/json",
        }),
      }),
    );
  });

  // T7 (R13): a 401 response throws CrmAuthError.
  it("T7: any client call throws CrmAuthError on a 401 response", async () => {
    mockFetchOnce({ ok: false, status: 401 });
    const client = new GoHighLevelClient({ token: "tok", locationId: "loc1" });

    await expect(client.getLocation()).rejects.toBeInstanceOf(CrmAuthError);
  });

  // T8 (R13): a 429 with Retry-After throws CrmRateLimitError carrying retryAfterSec.
  it("T8: a 429 response with Retry-After throws CrmRateLimitError with retryAfterSec 30", async () => {
    mockFetchOnce({ ok: false, status: 429, headers: { "Retry-After": "30" } });
    const client = new GoHighLevelClient({ token: "tok", locationId: "loc1" });

    let caught: unknown;
    try {
      await client.getLocation();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CrmRateLimitError);
    expect((caught as CrmRateLimitError).retryAfterSec).toBe(30);
  });

  // T9 (R9): exact query-param names/values for searchOpportunities.
  it("T9: searchOpportunities builds the exact query string spec R9 names", async () => {
    mockFetchOnce({ ok: true, json: async () => ({ opportunities: [], meta: {} }) });
    const client = new GoHighLevelClient({ token: "tok", locationId: "loc1" });

    await client.searchOpportunities({ page: 2, pipelineId: "p", stageId: "s" });

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain("page=2");
    expect(calledUrl).toContain("limit=100");
    expect(calledUrl).toContain("pipeline_id=p");
    expect(calledUrl).toContain("pipeline_stage_id=s");
    expect(calledUrl).toContain("location_id=loc1");
  });

  // T10 (R19): PUT body for custom-field update never contains "tags".
  it("T10: updateContactCustomFields sends a body with no tags key", async () => {
    mockFetchOnce({ ok: true, json: async () => ({}) });
    const client = new GoHighLevelClient({ token: "tok", locationId: "loc1" });

    await client.updateContactCustomFields("c1", [{ id: "f1", field_value: "x" }]);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ customFields: [{ id: "f1", field_value: "x" }] });
    expect(sentBody).not.toHaveProperty("tags");
  });

  // T11 (R19): field-creation POST body shape.
  it("T11: createCustomField posts the exact field-creation body", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({ customField: { id: "f1", name: "RouteFlow Link" } }),
    });
    const client = new GoHighLevelClient({ token: "tok", locationId: "loc1" });

    await client.createCustomField("RouteFlow Link");

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ name: "RouteFlow Link", dataType: "TEXT", model: "contact" });
  });

  // T12 (R13): an AbortError (10s timeout) throws CrmHttpError with code "timeout".
  it("T12: an AbortError from fetch throws CrmHttpError with code timeout", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    (global.fetch as jest.Mock).mockRejectedValueOnce(abortError);
    const client = new GoHighLevelClient({ token: "tok", locationId: "loc1" });

    let caught: unknown;
    try {
      await client.getLocation();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CrmHttpError);
    expect((caught as CrmHttpError).code).toBe("timeout");
  });
});
