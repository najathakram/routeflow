// Admin settings writes must NEVER enter the offline queue (REG-B308 class): offline, the UI says
// "Couldn't save" while the queue replays the change later, so selling restrictions could silently
// flip OFF. Each write opts out per request with `_skipOfflineQueue` (see api-client).
const mockPatch = jest.fn().mockResolvedValue({ data: {} });
jest.mock("../lib/api-client", () => ({
  apiClient: { patch: (...a: unknown[]) => mockPatch(...a) },
}));

import {
  patchRestrictionsSettings,
  patchRouteSettings,
  patchUserPreferences,
} from "../lib/api/settings-parity";

beforeEach(() => mockPatch.mockClear());

it.each([
  [
    "route defaults",
    () => patchRouteSettings({ serviceTimeMinutes: 10 } as never),
    "/settings/route",
  ],
  [
    "low-stock digest / prefs",
    () => patchUserPreferences({ lowStockDigestEnabled: "false" }),
    "/users/me/preferences",
  ],
  [
    "selling restrictions toggle",
    () => patchRestrictionsSettings({ enabled: false }),
    "/settings/restrictions",
  ],
])("%s PATCH opts out of the offline queue", async (_name, call, url) => {
  await call();
  expect(mockPatch).toHaveBeenCalledTimes(1);
  expect(mockPatch.mock.calls[0][0]).toBe(url);
  expect(mockPatch.mock.calls[0][2]).toMatchObject({ _skipOfflineQueue: true });
});
