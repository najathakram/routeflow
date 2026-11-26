import { tenantSlugFromHostname } from "./tenant-host";

describe("tenantSlugFromHostname", () => {
  const cases: Array<[hostname: string, expected: string | null]> = [
    ["acme.routeflow.info", "acme"],
    ["www.routeflow.info", null],
    ["localhost", null],
    ["routeflowweb-production.up.railway.app", null],
    ["acme.up.railway.app", null],
    ["app.acme.example.com", null],
    ["billing.routeflow.info", null],
    // SA-1253 T8: the site's main host (a www form) and its bare alias host are never a tenant
    ["www.xrov.io", null],
    ["xrov.io", null],
  ];

  it.each(cases)("%s -> %s", (hostname, expected) => {
    expect(tenantSlugFromHostname(hostname)).toBe(expected);
  });
});
