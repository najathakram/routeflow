/**
 * @jest-environment node
 */
// SA-1146 B-1 (B446): Checkout used to send a tenant to `/billing/success` and `/billing/cancel`, pages
// that do not exist. A link already out (a Stripe session lives 23 h) must still land on the Billing
// page with the return notice. Temporary redirects: the owner removes them 7 days after deploy (a
// register row carries the date), so a permanent redirect would outlive them in browser caches.
import * as path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";
import { BILLING_CANCEL_PATH, BILLING_RETURN_PATHS } from "@routeflow/types";

const WEB_ROOT = path.resolve(__dirname, "..");

// next.config.mjs is loaded in a plain node subprocess, never in-process (see old-pages-redirect.static.test.ts).
function loadRedirects(): Array<{ source: string; destination: string; permanent: boolean }> {
  const configUrl = pathToFileURL(path.join(WEB_ROOT, "next.config.mjs")).href;
  const script =
    `const m = await import(${JSON.stringify(configUrl)});` +
    `process.stdout.write(JSON.stringify(await m.default.redirects()));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: WEB_ROOT,
      encoding: "utf8",
      timeout: 15_000,
    }),
  );
}

describe("old Checkout return addresses redirect to the Billing page", () => {
  const redirects = loadRedirects();

  it("/billing/success lands on the plan-checkout return path, temporarily", () => {
    expect(redirects.find((r) => r.source === "/billing/success")).toEqual({
      source: "/billing/success",
      destination: BILLING_RETURN_PATHS.plan,
      permanent: false,
    });
  });

  it("/billing/cancel lands on the cancelled notice, temporarily", () => {
    expect(redirects.find((r) => r.source === "/billing/cancel")).toEqual({
      source: "/billing/cancel",
      destination: BILLING_CANCEL_PATH,
      permanent: false,
    });
  });
});
