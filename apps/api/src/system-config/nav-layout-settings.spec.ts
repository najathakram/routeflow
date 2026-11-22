import {
  NAV_LAYOUT_CONFIG_KEY as T_KEY,
  NAV_LAYOUT_MAX_PINNED as T_MAX,
  SETTINGS_REGISTRY,
} from "@routeflow/types";
import { NAV_LAYOUT_CONFIG_KEY, NAV_LAYOUT_MAX_PINNED } from "./nav-layout-settings";

/** L-261: the API keeps its own literals; pinned equal to the shared file here, and the key is a registered setting. */
describe("nav layout constants: api literals === packages/types/api/nav-layout.ts", () => {
  it("the key and the pin limit are equal", () => {
    expect({ NAV_LAYOUT_CONFIG_KEY, NAV_LAYOUT_MAX_PINNED }).toEqual({
      NAV_LAYOUT_CONFIG_KEY: T_KEY,
      NAV_LAYOUT_MAX_PINNED: T_MAX,
    });
  });

  it("the key is registered as one systemConfig setting", () => {
    expect(SETTINGS_REGISTRY.filter((r) => r.key === NAV_LAYOUT_CONFIG_KEY)).toEqual([
      expect.objectContaining({ home: "systemConfig", adminOnly: true }),
    ]);
  });
});
