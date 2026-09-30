// Contract test for the config-snapshots client: mocks the HTTP client itself so a drift in the
// endpoint paths or the unwrapping shows up here first.
import {
  fetchConfigSnapshots,
  previewConfigSnapshotRestore,
  restoreConfigSnapshot,
} from "./config-snapshots";
import { superAdminClient } from "@/lib/admin-api";

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: { get: jest.fn(), post: jest.fn() },
}));

const mockGet = superAdminClient.get as jest.Mock;
const mockPost = superAdminClient.post as jest.Mock;

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe("config-snapshots client", () => {
  it("fetchConfigSnapshots reads the tenant-scoped list and returns the bare array", async () => {
    const rows = [{ id: "s1", planKey: "SCALE", entries: { configs: 1, overrides: 2 } }];
    mockGet.mockResolvedValueOnce({ data: rows });

    expect(await fetchConfigSnapshots("t1")).toEqual(rows);
    expect(mockGet).toHaveBeenCalledWith("/platform-admin/tenants/t1/config-snapshots");
  });

  it("previewConfigSnapshotRestore GETs the preview route (a read: never a POST)", async () => {
    const preview = { snapshotId: "s1", willRestore: [], keptNewer: [], skipped: [] };
    mockGet.mockResolvedValueOnce({ data: preview });

    expect(await previewConfigSnapshotRestore("t1", "s1")).toEqual(preview);
    expect(mockGet).toHaveBeenCalledWith("/platform-admin/tenants/t1/config-snapshots/s1/preview");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("restoreConfigSnapshot POSTs the restore route and returns the report", async () => {
    const result = {
      snapshotId: "s1",
      report: { restored: 2, skipped: 0, keptNewer: 0, unchanged: 0 },
    };
    mockPost.mockResolvedValueOnce({ data: result });

    expect(await restoreConfigSnapshot("t1", "s1")).toEqual(result);
    expect(mockPost).toHaveBeenCalledWith("/platform-admin/tenants/t1/config-snapshots/s1/restore");
  });

  it("propagates an API error (e.g. 409 already restored) instead of swallowing it", async () => {
    mockPost.mockRejectedValueOnce(new Error("Request failed with status code 409"));

    await expect(restoreConfigSnapshot("t1", "s1")).rejects.toThrow("409");
  });
});
