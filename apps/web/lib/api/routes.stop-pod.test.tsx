/**
 * REG-B35 — proof of delivery was invisible to the office: POD photos were
 * persisted as device-local `file://` URIs and native signatures as the
 * literal "native-captured" sentinel, so nothing was ever retrievable and no
 * web screen read `podPhotoUrls`/`signatureUrl`. Fixed in #477 (9f00684d):
 * the API now ingests POD artifacts into tenant-scoped storage and serves
 * presigned URLs from `GET /route-runs/:runId/stops/:stopId/pod`, and
 * `useStopPod` is the hook the routes/[id] detail page reads to render the
 * Proof of delivery section.
 *
 * Pinned at the data-fetching layer — a regression that drops the endpoint,
 * mis-shapes the query key, or strips `photos`/`signatureUrl` back out of
 * `StopPod` fails here without needing to mount the full detail page.
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { useStopPod } from "./routes";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockedGet = apiClient.get as jest.Mock;

function Wrapper({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(createTestQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("useStopPod — proof of delivery is fetchable by the office (B35)", () => {
  it("REG-B35 fetches presigned photo/signature URLs from GET /route-runs/:runId/stops/:stopId/pod", async () => {
    const pod = {
      photos: [{ url: "https://storage.example/tenants/t1/pod/stop-1/photo-1.jpg" }],
      legacyPhotoCount: 0,
      signatureUrl: "https://storage.example/tenants/t1/pod/stop-1/signature.svg",
      signatureCaptured: true,
      driverNote: null,
      completedAt: "2026-09-01T12:00:00.000Z",
      ageCheckRequired: false,
      ageVerified: false,
      identityCheckRequired: false,
      identityVerified: false,
      identityType: null,
    };
    mockedGet.mockResolvedValue({ data: pod });

    const { result } = renderHook(() => useStopPod("run-1", "stop-1"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // RED against a regression that changes the route, or drops back to sending only a
    // device-local URI / the "native-captured" sentinel instead of a retrievable URL.
    expect(mockedGet).toHaveBeenCalledWith("/route-runs/run-1/stops/stop-1/pod");
    expect(result.current.data?.photos).toEqual([
      { url: "https://storage.example/tenants/t1/pod/stop-1/photo-1.jpg" },
    ]);
    expect(result.current.data?.signatureUrl).toBe(
      "https://storage.example/tenants/t1/pod/stop-1/signature.svg",
    );
  });

  it("does not fetch until both runId and stopId are present", () => {
    renderHook(() => useStopPod("", "stop-1"), { wrapper: Wrapper });
    expect(mockedGet).not.toHaveBeenCalled();
  });
});
