import { readFileSync } from "fs";
import { join } from "path";
import { STORE_STATE_HREF } from "@/components/RestrictionRemedyActions";

/**
 * R672: the indeterminate-restriction remedy link (`STORE_STATE_HREF`) targets a fragment on /settings. The
 * "Business address" card must carry that id, or the link lands on nothing and the page never scrolls.
 * Source pin (the settings page is too heavy to mount); the id is read from the href constant so the two cannot drift.
 */
const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("/settings Business address card is the remedy link's anchor target (R672)", () => {
  it("carries the id the remedy href points at", () => {
    const fragment = STORE_STATE_HREF.split("#")[1];
    expect(fragment).toBeTruthy();
    expect(src).toContain(`<Card id="${fragment}" title="Business address">`);
  });
});
