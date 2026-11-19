import { BRAND } from "./brand";
import { brandHost } from "./brand-host";

/**
 * The host the bookkeeping invoice PDF prints in its header and footer. The first case reads the
 * real brand.json (no mock), so a change of the site's origin shows up here as one visible line.
 */
describe("common/brand-host", () => {
  it("prints the real brand's host without a leading www", () => {
    expect(brandHost(BRAND.origin)).toBe("routeflow.info");
  });

  it("returns a bare host unchanged", () => {
    expect(brandHost("https://fixture.test")).toBe("fixture.test");
  });

  it("drops only a leading www, and keeps a port and any other subdomain", () => {
    expect(brandHost("https://www.fixture.test")).toBe("fixture.test");
    expect(brandHost("https://app.fixture.test:8443")).toBe("app.fixture.test:8443");
    expect(brandHost("https://fixture.www.test")).toBe("fixture.www.test");
  });
});
