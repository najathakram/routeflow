// The palette `<style id="brand-tokens">` must be on a page exactly once. The one mount is the
// frame the public pages wear (SiteFrame); the ready-made pages get it from the build-time fill.
// A second mount (the root layout, a page, a shell) would give a page two elements with one id.
import * as fs from "fs";
import * as path from "path";

const WEB_ROOT = path.resolve(__dirname, "..", "..");
const ONE_MOUNT = "components/site-frame/SiteFrame.tsx";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const mounts = (roots: string[]) =>
  roots
    .flatMap((r) => sourceFiles(path.join(WEB_ROOT, r)))
    .filter((f) => /<BrandTokens[\s/>]/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(WEB_ROOT, f).split(path.sep).join("/"));

describe("BrandTokens is mounted once", () => {
  it("only SiteFrame renders <BrandTokens /> in app/ and components/ source", () => {
    expect(mounts(["app", "components"])).toEqual([ONE_MOUNT]);
  });

  it("the scan sees a mount (a vacuous empty scan would pass the check above)", () => {
    expect(fs.readFileSync(path.join(WEB_ROOT, ONE_MOUNT), "utf8")).toMatch(/<BrandTokens\s*\/>/);
    expect(sourceFiles(path.join(WEB_ROOT, "app")).length).toBeGreaterThan(100);
  });

  it("the root layout does not mount it (SiteFrame does, once per page)", () => {
    expect(fs.readFileSync(path.join(WEB_ROOT, "app/layout.tsx"), "utf8")).not.toContain(
      "BrandTokens",
    );
  });
});
